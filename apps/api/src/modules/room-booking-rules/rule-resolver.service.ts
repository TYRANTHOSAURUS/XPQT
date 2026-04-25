import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  EvaluationContext,
  PredicateEngineService,
} from './predicate-engine.service';
import type {
  ApprovalConfig,
  BookingScenario,
  Predicate,
  RuleEffect,
  TargetScope,
} from './dto';

/**
 * Resolves which booking rules apply to a given (requester, space, time,
 * criteria) booking attempt and aggregates their effects.
 *
 * Specificity ordering (highest first):
 *   1. target_scope = 'room'           (target_id = space.id)
 *   2. target_scope = 'space_subtree'  (target_id IS ancestor of space)
 *   3. target_scope = 'room_type'      (predicate filters by space.type)
 *   4. target_scope = 'tenant'
 * Within the same specificity bucket, higher `priority` wins.
 *
 * Effect aggregation (any-wins):
 *   - any matched rule with effect 'deny'              → final = deny
 *   - any matched rule with effect 'require_approval'  → final = require_approval (unless deny dominates)
 *   - any matched rule with effect 'warn'              → collected as warning(s)
 *   - any matched rule with effect 'allow_override'    → set the overridable flag
 *
 * The `allow_override` doesn't itself bypass deny; the booking pipeline (Phase
 * C) is responsible for honouring the actor's `rooms.override_rules`
 * permission and turning a denied attempt into an audited override.
 */

export interface RuleRow {
  id: string;
  tenant_id: string;
  name: string;
  target_scope: TargetScope;
  target_id: string | null;
  applies_when: Predicate;
  effect: RuleEffect;
  approval_config: ApprovalConfig | null;
  denial_message: string | null;
  priority: number;
  active: boolean;
  template_id: string | null;
}

export interface MatchedRule extends RuleRow {
  /** 1=room, 2=subtree, 3=room_type, 4=tenant — lower is more specific. */
  specificity: number;
}

export interface ResolveOutcome {
  effects: RuleEffect[];
  matchedRules: MatchedRule[];
  warnings: string[];
  denialMessages: string[];
  /** Set when at least one allow_override rule matched. */
  overridable: boolean;
  /** require_approval config of the highest-priority approval rule, if any. */
  approvalConfig: ApprovalConfig | null;
  /** Convenience aggregate: 'allow' | 'deny' | 'require_approval'. */
  final: 'allow' | 'deny' | 'require_approval';
}

@Injectable()
export class RuleResolverService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: PredicateEngineService,
  ) {}

  /**
   * The single-space resolution path. Builds the EvaluationContext, fetches
   * all candidate rules in one query, evaluates each, and aggregates.
   */
  async resolve(scenario: BookingScenario): Promise<ResolveOutcome> {
    const tenant = TenantContext.current();

    const [ctx, candidateRules] = await Promise.all([
      this.buildContext(scenario),
      this.fetchCandidateRules(scenario.space_id),
    ]);

    return this.evaluateAndAggregate(candidateRules, ctx, scenario.space_id, tenant.id);
  }

  /**
   * Bulk path used by the picker. Loads the requester + every space in one go,
   * fetches rules in one query (tenant + room_type are shared, room/subtree
   * are filtered per space), then evaluates per-space.
   */
  async resolveBulk(
    requesterPersonId: string,
    spaceIds: string[],
    timeRange: { start_at: string; end_at: string },
    criteria: BookingScenario['criteria'] = {},
  ): Promise<Map<string, ResolveOutcome>> {
    const tenant = TenantContext.current();
    const out = new Map<string, ResolveOutcome>();
    if (spaceIds.length === 0) return out;

    // Fetch all candidate rules once. Cheaper than N queries; we'll filter
    // per space in TS using the ancestor/type maps.
    const allRules = await this.fetchAllRules();
    const requester = await this.loadRequester(requesterPersonId);
    const permissions = await this.loadPermissionMap(requester.user_id);

    // Fetch every space + parent chain in one query.
    const spaces = await this.loadSpacesWithAncestors(spaceIds);

    for (const spaceId of spaceIds) {
      const space = spaces.get(spaceId);
      if (!space) {
        out.set(spaceId, this.emptyOutcome());
        continue;
      }
      const candidates = filterRulesForSpace(allRules, space);
      const ctx = this.assembleContext({
        requester,
        permissions,
        space,
        scenario: {
          requester_person_id: requesterPersonId,
          space_id: spaceId,
          start_at: timeRange.start_at,
          end_at: timeRange.end_at,
          attendee_count: (criteria as { attendee_count?: number } | undefined)?.attendee_count ?? null,
          criteria,
        },
      });
      out.set(
        spaceId,
        await this.evaluateAndAggregate(candidates, ctx, spaceId, tenant.id),
      );
    }
    return out;
  }

  /** Used by SimulationService to evaluate a draft rule against a scenario. */
  async evaluateAdHoc(
    rules: RuleRow[],
    scenario: BookingScenario,
  ): Promise<ResolveOutcome> {
    const tenant = TenantContext.current();
    const ctx = await this.buildContext(scenario);
    return this.evaluateAndAggregate(rules, ctx, scenario.space_id, tenant.id);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async fetchCandidateRules(spaceId: string): Promise<RuleRow[]> {
    const tenant = TenantContext.current();
    // Load space ancestor chain so we can match space_subtree rules.
    const ancestorIds = await this.loadAncestorChain(spaceId);

    // Single query: pull every rule that COULD match this space. We
    // intentionally over-fetch room_type rules (no SQL filter on type) and
    // filter in TS — it keeps the query simple and fast (<= 100 rules per
    // tenant in expected tenant size).
    const targets = [...ancestorIds, spaceId];
    const orConds = [
      `target_scope.eq.tenant`,
      `target_scope.eq.room_type`,
      `and(target_scope.eq.room,target_id.eq.${spaceId})`,
      `and(target_scope.eq.space_subtree,target_id.in.(${targets.join(',')}))`,
    ].join(',');

    const { data, error } = await this.supabase.admin
      .from('room_booking_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .or(orConds);
    if (error) throw error;
    return (data ?? []) as RuleRow[];
  }

  /** All active rules in the tenant — used by the bulk picker path. */
  private async fetchAllRules(): Promise<RuleRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true);
    if (error) throw error;
    return (data ?? []) as RuleRow[];
  }

  private async loadAncestorChain(spaceId: string): Promise<string[]> {
    // Walk up via space.parent_id. We could call space_descendants on the
    // root and check membership, but the chain length is bounded (<= 5 for
    // typical tenant trees), so iterative SELECT is fine and doesn't pull
    // every space in the tenant.
    const tenant = TenantContext.current();
    const ids: string[] = [];
    let current: string | null = spaceId;
    let safety = 0;
    while (current && safety < 16) {
      const result = await this.supabase.admin
        .from('spaces')
        .select('id, parent_id')
        .eq('id', current)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      if (result.error) throw result.error;
      const row = result.data as { id: string; parent_id: string | null } | null;
      if (!row) break;
      ids.push(row.id);
      current = row.parent_id;
      safety += 1;
    }
    // Drop the leaf — caller wants ancestors. But the leaf is also useful
    // for matching `target_scope='space_subtree' target_id=self`, so we keep
    // it. Caller adds spaceId again only for the room scope.
    return ids;
  }

  private async loadSpacesWithAncestors(spaceIds: string[]): Promise<
    Map<string, SpaceWithChain>
  > {
    const tenant = TenantContext.current();
    // One query loads all spaces in the tenant — but we don't need every
    // space. Instead we walk parents iteratively per id using a single
    // batched select per layer. For the bulk path (picker, ~30 candidates),
    // this is bounded at ~30 × tree-depth queries. Acceptable.
    const out = new Map<string, SpaceWithChain>();
    const allIds = new Set(spaceIds);
    let layer = new Set(spaceIds);
    const fetched = new Map<string, { id: string; type: string | null; parent_id: string | null; capacity: number | null; min_attendees: number | null; default_calendar_id: string | null }>();

    while (layer.size > 0) {
      const { data, error } = await this.supabase.admin
        .from('spaces')
        .select('id, type, parent_id, capacity, min_attendees, default_calendar_id')
        .eq('tenant_id', tenant.id)
        .in('id', Array.from(layer));
      if (error) throw error;
      const nextLayer = new Set<string>();
      for (const row of (data ?? []) as Array<{
        id: string;
        type: string | null;
        parent_id: string | null;
        capacity: number | null;
        min_attendees: number | null;
        default_calendar_id: string | null;
      }>) {
        fetched.set(row.id, row);
        if (row.parent_id && !fetched.has(row.parent_id) && !allIds.has(row.parent_id)) {
          nextLayer.add(row.parent_id);
          allIds.add(row.parent_id);
        }
      }
      layer = nextLayer;
    }

    for (const spaceId of spaceIds) {
      const seed = fetched.get(spaceId);
      if (!seed) continue;
      const chain: string[] = [seed.id];
      let cursor = seed.parent_id;
      let safety = 0;
      while (cursor && safety < 16) {
        const node = fetched.get(cursor);
        if (!node) break;
        chain.push(node.id);
        cursor = node.parent_id;
        safety += 1;
      }
      out.set(spaceId, {
        id: seed.id,
        type: seed.type,
        parent_id: seed.parent_id,
        capacity: seed.capacity,
        min_attendees: seed.min_attendees,
        default_calendar_id: seed.default_calendar_id,
        ancestor_ids: chain,
      });
    }
    return out;
  }

  private async loadRequester(personId: string): Promise<RequesterContext> {
    const tenant = TenantContext.current();
    const [{ data: person, error: pErr }, { data: membership, error: mErr }] =
      await Promise.all([
        this.supabase.admin
          .from('persons')
          .select('id, type, cost_center')
          .eq('id', personId)
          .eq('tenant_id', tenant.id)
          .maybeSingle(),
        this.supabase.admin
          .from('person_org_memberships')
          .select('org_node_id')
          .eq('person_id', personId)
          .eq('tenant_id', tenant.id)
          .eq('is_primary', true)
          .maybeSingle(),
      ]);
    if (pErr) throw pErr;
    if (mErr) throw mErr;
    if (!person) throw new NotFoundException(`Person ${personId} not found`);

    // Find the linked user (if any) so we can compute role_ids + permissions.
    const { data: user, error: uErr } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (uErr) throw uErr;
    const userId = (user as { id: string } | null)?.id ?? null;

    let roleIds: string[] = [];
    if (userId) {
      const { data: roles, error: rErr } = await this.supabase.admin
        .from('user_role_assignments')
        .select('role_id')
        .eq('user_id', userId)
        .eq('tenant_id', tenant.id)
        .eq('active', true);
      if (rErr) throw rErr;
      roleIds = ((roles ?? []) as Array<{ role_id: string }>).map((r) => r.role_id);
    }

    return {
      id: personId,
      type: (person as { type: string | null }).type ?? null,
      cost_center: (person as { cost_center: string | null }).cost_center ?? null,
      org_node_id: (membership as { org_node_id: string } | null)?.org_node_id ?? null,
      role_ids: roleIds,
      user_id: userId,
    };
  }

  private async loadPermissionMap(userId: string | null): Promise<Record<string, boolean>> {
    if (!userId) return {};
    const tenant = TenantContext.current();
    // We only check permissions referenced by templates today
    // (rooms.override_rules, rooms.book_on_behalf). For each, call the
    // existing user_has_permission RPC.
    const perms = ['rooms.override_rules', 'rooms.book_on_behalf'];
    const result: Record<string, boolean> = {};
    await Promise.all(
      perms.map(async (perm) => {
        const { data, error } = await this.supabase.admin.rpc('user_has_permission', {
          p_user_id: userId,
          p_tenant_id: tenant.id,
          p_permission: perm,
        });
        if (error) throw error;
        result[perm] = Boolean(data);
      }),
    );
    return result;
  }

  private async buildContext(scenario: BookingScenario): Promise<EvaluationContext> {
    const requester = await this.loadRequester(scenario.requester_person_id);
    const permissions = await this.loadPermissionMap(requester.user_id);
    const spaceMap = await this.loadSpacesWithAncestors([scenario.space_id]);
    const space = spaceMap.get(scenario.space_id);
    if (!space) throw new NotFoundException(`Space ${scenario.space_id} not found`);
    return this.assembleContext({ requester, permissions, space, scenario });
  }

  private assembleContext(args: {
    requester: RequesterContext;
    permissions: Record<string, boolean>;
    space: SpaceWithChain;
    scenario: BookingScenario;
  }): EvaluationContext {
    const { requester, permissions, space, scenario } = args;
    const startMs = Date.parse(scenario.start_at);
    const endMs = Date.parse(scenario.end_at);
    const duration = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.round((endMs - startMs) / 60_000) : 0;
    const lead = Number.isFinite(startMs)
      ? Math.round((startMs - Date.now()) / 60_000) : 0;
    return {
      requester: {
        id: requester.id,
        role_ids: requester.role_ids,
        org_node_id: requester.org_node_id,
        type: requester.type,
        cost_center: requester.cost_center,
        user_id: requester.user_id,
      },
      space: {
        id: space.id,
        type: space.type,
        parent_id: space.parent_id,
        capacity: space.capacity,
        min_attendees: space.min_attendees,
        default_calendar_id: space.default_calendar_id,
        ancestor_ids: space.ancestor_ids,
      },
      booking: {
        start_at: scenario.start_at,
        end_at: scenario.end_at,
        duration_minutes: duration,
        lead_time_minutes: lead,
        attendee_count: scenario.attendee_count ?? null,
      },
      permissions,
      resolved: {
        org_descendants: {},
        in_business_hours: {},
      },
    };
  }

  private async evaluateAndAggregate(
    rules: RuleRow[],
    ctx: EvaluationContext,
    spaceId: string,
    _tenantId: string,
  ): Promise<ResolveOutcome> {
    // Filter to rules that apply to this space (specificity check).
    const candidateBuckets = bucketRulesBySpecificity(rules, ctx.space);

    // Sort within each bucket by priority desc; flatten (most-specific first).
    const orderedRules: Array<RuleRow & { specificity: number }> = [];
    for (const [specificity, bucket] of candidateBuckets) {
      bucket.sort((a, b) => b.priority - a.priority);
      for (const r of bucket) orderedRules.push({ ...r, specificity });
    }

    // Hydrate the engine context with any DB-backed helper data the
    // predicates reference.
    const predicates = orderedRules.map((r) => r.applies_when);
    await this.engine.hydrateContextHelpers(predicates, ctx);

    const matched: MatchedRule[] = [];
    for (const rule of orderedRules) {
      let fired: boolean;
      try {
        fired = this.engine.evaluate(rule.applies_when, ctx);
      } catch (err) {
        // Treat malformed rule predicate as a non-match — admins fix in the
        // editor. Surface to logs so we can spot drift.
        console.warn(
          `[room-booking-rules] rule ${rule.id} predicate eval failed:`,
          (err as Error).message,
        );
        fired = false;
      }
      if (fired) matched.push({ ...rule, specificity: rule.specificity });
    }

    return aggregateOutcome(matched, spaceId);
  }

  private emptyOutcome(): ResolveOutcome {
    return {
      effects: [],
      matchedRules: [],
      warnings: [],
      denialMessages: [],
      overridable: false,
      approvalConfig: null,
      final: 'allow',
    };
  }
}

// ── Helpers (exported for testing) ─────────────────────────────────────

interface RequesterContext {
  id: string;
  type: string | null;
  cost_center: string | null;
  org_node_id: string | null;
  role_ids: string[];
  user_id: string | null;
}

interface SpaceWithChain {
  id: string;
  type: string | null;
  parent_id: string | null;
  capacity: number | null;
  min_attendees: number | null;
  default_calendar_id: string | null;
  ancestor_ids: string[]; // including self
}

/** Decide which rules can match a space, bucketed by specificity. */
export function bucketRulesBySpecificity(
  rules: RuleRow[],
  space: { id: string; type: string | null; ancestor_ids: string[] },
): Map<number, RuleRow[]> {
  const buckets = new Map<number, RuleRow[]>();
  const ancestorSet = new Set(space.ancestor_ids);
  for (const rule of rules) {
    if (!rule.active) continue;
    let specificity: number | null = null;
    switch (rule.target_scope) {
      case 'room':
        if (rule.target_id === space.id) specificity = 1;
        break;
      case 'space_subtree':
        // Matches if the rule's target_id is the space itself or any ancestor
        // of the space.
        if (rule.target_id && ancestorSet.has(rule.target_id)) specificity = 2;
        break;
      case 'room_type':
        // target_id must match the space's type. Note: target_id is uuid in
        // schema, but we coerce to string here for the comparison so admins
        // can store the type name in target_id-as-text via the editor (see
        // module README in this folder for the "room_type encoding" note).
        // If target_id is null we treat the rule as type-agnostic.
        if (rule.target_id == null || String(rule.target_id) === String(space.type)) {
          specificity = 3;
        }
        break;
      case 'tenant':
        specificity = 4;
        break;
    }
    if (specificity !== null) {
      const list = buckets.get(specificity) ?? [];
      list.push(rule);
      buckets.set(specificity, list);
    }
  }
  // Return keys sorted ascending (most specific first).
  return new Map([...buckets.entries()].sort(([a], [b]) => a - b));
}

/** Filter a flat list of rules down to the ones that target this space. */
export function filterRulesForSpace(
  rules: RuleRow[],
  space: { id: string; type: string | null; ancestor_ids: string[] },
): RuleRow[] {
  const buckets = bucketRulesBySpecificity(rules, space);
  const out: RuleRow[] = [];
  for (const list of buckets.values()) out.push(...list);
  return out;
}

/**
 * Pure aggregation logic. Exported for tests.
 *
 * Effect precedence (any-wins):
 *   - any deny → final 'deny'; ALL deny messages collected
 *   - else any require_approval → final 'require_approval'; approvalConfig
 *     from the highest-priority approval rule
 *   - else final 'allow'
 *   - warn + allow_override are collected independently and reported
 *     alongside the final.
 */
export function aggregateOutcome(matched: MatchedRule[], _spaceId: string): ResolveOutcome {
  const denials: string[] = [];
  const warnings: string[] = [];
  let overridable = false;
  let approvalConfig: ApprovalConfig | null = null;
  let approvalSpecificity = Infinity;
  let approvalPriority = -Infinity;

  let hasDeny = false;
  let hasApproval = false;

  for (const r of matched) {
    switch (r.effect) {
      case 'deny':
        hasDeny = true;
        if (r.denial_message) denials.push(r.denial_message);
        break;
      case 'require_approval':
        hasApproval = true;
        // Prefer the most specific, highest-priority rule's config.
        if (
          r.specificity < approvalSpecificity ||
          (r.specificity === approvalSpecificity && r.priority > approvalPriority)
        ) {
          approvalSpecificity = r.specificity;
          approvalPriority = r.priority;
          approvalConfig = r.approval_config ?? null;
        }
        break;
      case 'warn':
        if (r.denial_message) warnings.push(r.denial_message);
        else warnings.push(`Warning from rule "${r.name}"`);
        break;
      case 'allow_override':
        overridable = true;
        break;
    }
  }

  const final: 'allow' | 'deny' | 'require_approval' = hasDeny
    ? 'deny'
    : hasApproval
      ? 'require_approval'
      : 'allow';

  return {
    effects: matched.map((r) => r.effect),
    matchedRules: matched,
    warnings,
    denialMessages: denials,
    overridable,
    approvalConfig,
    final,
  };
}
