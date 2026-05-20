import { Injectable } from '@nestjs/common';
import { AppErrors, wrapPgError } from '../../common/errors';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import type { AttachPlanApproval } from '../booking-bundles/attach-plan.types';
import { planUuid } from '../booking-bundles/plan-uuid';
import { comparePlanApprovals } from '../booking-bundles/plan-sort';
import type {
  ApproverTarget,
  ServiceRuleOutcome,
} from '../service-catalog/dto/types';

/**
 * Assembles approval rows for a bundle/standalone-order from per-line rule
 * outcomes. Implements the dedup algorithm from spec §4.4:
 *
 *   1. Collect every matched require_approval / allow_override rule across
 *      every line.
 *   2. Resolve each rule's `approver_target` into one or more concrete
 *      person_ids:
 *        - person → [personId]
 *        - role → expanded to active members (first-approver-wins enforced
 *          on approval submission, not creation)
 *        - derived (cost_center.default_approver) → cost_centers row lookup
 *   3. Group by approver_person_id. Build one approval row per group with
 *      `scope_breakdown jsonb` covering every entity the rule(s) touched.
 *   4. Upsert with application-layer SELECT-merge-UPDATE inside the bundle
 *      transaction. The unique partial index
 *      `(target_entity_id, approver_person_id) WHERE status='pending'` is the
 *      safety net — concurrent inserts surface as 23505 and the second
 *      writer retries.
 *
 * Why not raw `INSERT ... ON CONFLICT DO UPDATE SET scope_breakdown =
 *   scope_breakdown || EXCLUDED.scope_breakdown`?
 * The jsonb `||` operator does shallow merge — `reservation_ids: [r1]`
 * paired with `reservation_ids: [r2]` keeps only the EXCLUDED side.
 * Application-layer merge is the only way to concat arrays per key.
 */

export interface AssembleApprovalsArgs {
  /**
   * Post-canonicalisation (2026-05-02): the canonical type for booking-anchored
   * approvals is `'booking'` — the booking IS the bundle (00277:27). The
   * 00278:172 CHECK constraint enforces the new vocabulary at the DB layer;
   * any legacy `'booking_bundle'` rows are backfilled to `'booking'` by
   * 00278:163-165. The TS union is tightened here to match — the DB no
   * longer admits `'booking_bundle'` so neither does the type system.
   */
  target_entity_type: 'booking' | 'order';
  target_entity_id: string;
  /** Per-line rule outcomes from `ServiceRuleResolverService.resolveBulk`. */
  per_line_outcomes: Array<{
    line_key: string;
    outcome: ServiceRuleOutcome;
    /** Entities this line touched — for scope_breakdown. */
    scope: ApprovalScope;
  }>;
  /**
   * Optional bundle-wide outcome (e.g. cost-center owner approval at the
   * bundle level rather than per-line). Same shape as per-line outcomes;
   * scope is only the bundle-wide entities.
   */
  bundle_outcome?: {
    outcome: ServiceRuleOutcome;
    scope: ApprovalScope;
  };
  /**
   * Required for derived approver_targets like cost_center.default_approver.
   */
  bundle_context: {
    cost_center_id: string | null;
    requester_person_id: string;
    bundle_id: string | null;
  };
}

export interface ApprovalScope {
  reservation_ids?: string[];
  order_ids?: string[];
  order_line_item_ids?: string[];
  ticket_ids?: string[];
  asset_reservation_ids?: string[];
}

export interface AssembledApproval {
  target_entity_type: string;
  target_entity_id: string;
  approver_person_id: string;
  scope_breakdown: ApprovalScope & {
    reasons: Array<{ rule_id: string; denial_message: string | null }>;
  };
  status: 'pending';
  was_existing: boolean;
}

@Injectable()
export class ApprovalRoutingService {
  constructor(private readonly supabase: SupabaseService) {}

  async assemble(args: AssembleApprovalsArgs): Promise<AssembledApproval[]> {
    const tenant = TenantContext.current();

    // Step 1+2: collect (target, scope, reason) tuples and resolve approver
    // targets into concrete person ids.
    const tuples = await this.collectApproverTuples(args);
    if (tuples.length === 0) return [];

    // Step 3: group by approver_person_id, build merged scope_breakdown.
    const grouped = new Map<
      string,
      {
        scope: ApprovalScope;
        reasons: Array<{ rule_id: string; denial_message: string | null }>;
      }
    >();
    for (const t of tuples) {
      const entry = grouped.get(t.approver_person_id) ?? {
        scope: {},
        reasons: [],
      };
      mergeScopeInto(entry.scope, t.scope);
      entry.reasons.push({ rule_id: t.rule_id, denial_message: t.denial_message });
      grouped.set(t.approver_person_id, entry);
    }

    // Step 4: upsert each grouped row.
    const out: AssembledApproval[] = [];
    for (const [approverPersonId, entry] of grouped) {
      const result = await this.upsertApproval({
        tenant_id: tenant.id,
        target_entity_type: args.target_entity_type,
        target_entity_id: args.target_entity_id,
        approver_person_id: approverPersonId,
        scope: entry.scope,
        reasons: entry.reasons,
      });
      out.push(result);
    }
    return out;
  }

  /**
   * Plan-only variant of `assemble` for the combined-RPC path
   * (`create_booking_with_attach_plan`). Returns the same logical rows the
   * existing `assemble` would have written — but does NOT write them. The
   * combined RPC inserts the rows atomically alongside booking + slots +
   * orders + OLIs + asset_reservations.
   *
   * Spec: §7.5 of docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
   *
   * Differences from `assemble`:
   *   - `target_entity_type` is narrowed to `'booking'` (the combined RPC
   *     only ever inserts booking-anchored approvals; the standalone-order
   *     path keeps using `assemble`).
   *   - Caller MUST pass `idempotencyKey` so each row's `id` is derived
   *     deterministically via `planUuid(key, 'approval', approver_person_id)`.
   *     Two retries with the same idempotencyKey produce byte-identical
   *     approval ids.
   *   - Output is canonically sorted by `approver_person_id` so two retries
   *     with shuffled inputs produce byte-identical plan jsonb.
   *   - No DB writes; the combined RPC owns insertion + the unique-index
   *     dedup safety net.
   *
   * Why the existing `assemble` stays. Several non-attach call sites still
   * write approvals directly — `OrderService.createStandaloneOrder` is the
   * leading example, plus any future `onApprovalDecided` re-fire path. They
   * keep using `assemble` until each migrates onto its own RPC.
   */
  async assemblePlan(
    args: AssembleApprovalsArgs & {
      target_entity_type: 'booking';
      idempotencyKey: string;
    },
  ): Promise<AttachPlanApproval[]> {
    const tuples = await this.collectApproverTuples(args);
    if (tuples.length === 0) return [];

    // Step 3 (mirrors assemble): group by approver_person_id, build merged
    // scope_breakdown.
    const grouped = new Map<
      string,
      {
        scope: ApprovalScope;
        reasons: Array<{ rule_id: string; denial_message: string | null }>;
      }
    >();
    for (const t of tuples) {
      const entry = grouped.get(t.approver_person_id) ?? {
        scope: {},
        reasons: [],
      };
      mergeScopeInto(entry.scope, t.scope);
      // Dedup reasons by rule_id within this group — repeating a rule_id
      // across N lines yields the same reason once.
      if (!entry.reasons.some((r) => r.rule_id === t.rule_id)) {
        entry.reasons.push({ rule_id: t.rule_id, denial_message: t.denial_message });
      }
      grouped.set(t.approver_person_id, entry);
    }

    // audit-03 P2-3 (C2) — ONE shared, DETERMINISTIC approval_chain_id per
    // assemblePlan call. Without it the combined RPC's step-10 INSERT
    // persisted approval_chain_id=NULL and the 00402 inbox trigger
    // `return new`-skipped EVERY with-services pending-approval row →
    // approvers silently un-notified (systemic pre-existing P0; corroborated
    // by the in-code admission at booking-flow.service.ts ~:592-598). The
    // chain id MUST be deterministic (NOT randomUUID — that would change
    // the idempotency-hashed p_attach_plan between same-intent retries and
    // trip attach_operations.payload_mismatch 409, the exact D-5/D-6 bug
    // class). `planUuid('approval', sentinel)` reuses the existing
    // PlanRowKind enum; the '__chain__' stableIndex cannot collide with a
    // real approver_person_id (those are UUIDs, never the literal
    // '__chain__'). chain_threshold='all' is the createApprovalRows default
    // and the correct semantic here: the service-rule path aggregates
    // approvers from per-line outcomes with NO single per-chain threshold
    // — each row is an independently-required approver (≡ all-of). With
    // threshold='all', parallel_group = 'parallel-' + booking_id, mirroring
    // createApprovalRows; booking_id (= args.target_entity_id) is itself
    // planUuid-derived → deterministic. This path only ever resolves person
    // approvers (person / role→persons / derived→persons; see
    // resolveApproverTarget), so approver_team_id is always null here.
    const sharedApprovalChainId = planUuid(
      args.idempotencyKey,
      'approval',
      '__chain__',
    );
    const chainThreshold: 'all' = 'all';
    const parallelGroup = `parallel-${args.target_entity_id}`;

    // Step 4 — build plan rows + canonical sort. The stableIndex IS the
    // approver_person_id (§7.4 v8 row-kind table); sort applies the
    // determinism invariant on output.
    const rows: AttachPlanApproval[] = [];
    for (const [approverPersonId, entry] of grouped) {
      rows.push({
        id: planUuid(args.idempotencyKey, 'approval', approverPersonId),
        target_entity_type: 'booking',
        target_entity_id: args.target_entity_id,
        approver_person_id: approverPersonId,
        approval_chain_id: sharedApprovalChainId,
        parallel_group: parallelGroup,
        chain_threshold: chainThreshold,
        approver_team_id: null,
        scope_breakdown: {
          reservation_ids: entry.scope.reservation_ids ?? [],
          order_ids: entry.scope.order_ids ?? [],
          order_line_item_ids: entry.scope.order_line_item_ids ?? [],
          ticket_ids: entry.scope.ticket_ids ?? [],
          asset_reservation_ids: entry.scope.asset_reservation_ids ?? [],
          // audit-03 D-6 (V3-order) — canonical sort by (rule_id,
          // denial_message). Belt-and-suspenders: the upstream rule fetch
          // is now id-ordered + the resolver sort is stable, so tuple
          // order is already deterministic; this guarantees the SERIALIZED
          // `reasons` array (part of the idempotency-hashed p_attach_plan)
          // is byte-stable regardless of any future aggregation reorder.
          reasons: [...entry.reasons].sort(
            (a, b) =>
              a.rule_id.localeCompare(b.rule_id) ||
              (a.denial_message ?? '').localeCompare(b.denial_message ?? ''),
          ),
        },
        status: 'pending',
      });
    }
    return rows.sort(comparePlanApprovals);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async collectApproverTuples(
    args: AssembleApprovalsArgs,
  ): Promise<
    Array<{
      approver_person_id: string;
      rule_id: string;
      denial_message: string | null;
      scope: ApprovalScope;
    }>
  > {
    const out: Array<{
      approver_person_id: string;
      rule_id: string;
      denial_message: string | null;
      scope: ApprovalScope;
    }> = [];

    const flat = [
      ...args.per_line_outcomes.map((p) => ({
        outcome: p.outcome,
        scope: p.scope,
        line_key: p.line_key as string | null,
      })),
      ...(args.bundle_outcome
        ? [{ outcome: args.bundle_outcome.outcome, scope: args.bundle_outcome.scope, line_key: null }]
        : []),
    ];

    for (const item of flat) {
      const messageByRule = new Map<string, string | null>();
      for (const message of item.outcome.denial_messages) {
        // Best effort: associate any denial_message with all matched rules.
        // The spec wants per-rule messages but the aggregate already
        // collected them globally. We store the full set here and dedup at
        // the row level later.
        for (const ruleId of item.outcome.matched_rule_ids) {
          if (!messageByRule.has(ruleId)) messageByRule.set(ruleId, message);
        }
      }
      for (const at of item.outcome.approver_targets) {
        const persons = await this.resolveApproverTarget(at.target, args.bundle_context);
        for (const personId of persons) {
          out.push({
            approver_person_id: personId,
            rule_id: at.rule_id,
            denial_message: messageByRule.get(at.rule_id) ?? null,
            scope: item.scope,
          });
        }
      }
    }
    return out;
  }

  /**
   * Resolves an `ApproverTarget` to one or more concrete person ids.
   * `derived` expressions are limited in v1: only
   * `cost_center.default_approver` is supported. Future expressions
   * (`requester.manager`, `menu.fulfillment_team_lead`) are no-ops with a
   * warning, returning [] so the rule effectively becomes "warn only".
   */
  private async resolveApproverTarget(
    target: ApproverTarget,
    ctx: AssembleApprovalsArgs['bundle_context'],
  ): Promise<string[]> {
    const tenant = TenantContext.current();
    if (target.kind === 'person') return [target.person_id];

    if (target.kind === 'role') {
      // Expand role → active user_id list → person_id list.
      const { data, error } = await this.supabase.admin
        .from('user_role_assignments')
        .select('user_id')
        .eq('tenant_id', tenant.id)
        .eq('role_id', target.role_id)
        .eq('active', true);
      if (error) {
        throw wrapPgError(error, 'order.approval_role_expand_failed', {
          detail: `Approval-routing role ${target.role_id} expand failed`,
        });
      }
      const userIds = ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
      if (userIds.length === 0) return [];

      const { data: users, error: userErr } = await this.supabase.admin
        .from('users')
        .select('person_id')
        .eq('tenant_id', tenant.id)
        .in('id', userIds);
      if (userErr) {
        throw wrapPgError(userErr, 'order.approval_role_user_lookup_failed', {
          detail: `Approval-routing users lookup failed for role ${target.role_id}`,
        });
      }
      const personIds = ((users ?? []) as Array<{ person_id: string | null }>)
        .map((u) => u.person_id)
        .filter((id): id is string => Boolean(id));
      return personIds;
    }

    if (target.kind === 'derived') {
      if (target.expr === 'cost_center.default_approver') {
        if (!ctx.cost_center_id) return [];
        // Plan A.2 / Commit 7 / gap map §MEDIUM approval-routing.service.ts:236.
        // VERIFIED 2026-05-04: cost_centers lookup IS tenant-scoped via
        // .eq('tenant_id', tenant.id) below, so the derived-approver
        // expression cannot resolve to a foreign-tenant default approver.
        // Comment retained as a tripwire — if future refactoring drops
        // the tenant_id filter, the gap map entry should reopen.
        const { data, error } = await this.supabase.admin
          .from('cost_centers')
          .select('default_approver_person_id')
          .eq('tenant_id', tenant.id)
          .eq('id', ctx.cost_center_id)
          .maybeSingle();
        if (error) {
          throw wrapPgError(error, 'order.approval_cost_center_lookup_failed', {
            detail: `Approval-routing derived approver cost_center ${ctx.cost_center_id} lookup failed`,
          });
        }
        const row = data as { default_approver_person_id: string | null } | null;
        return row?.default_approver_person_id ? [row.default_approver_person_id] : [];
      }
      console.warn(
        `[approval-routing] derived approver expression not implemented in v1: ${target.expr}`,
      );
      return [];
    }
    return [];
  }

  /**
   * SELECT existing pending → if found, deep-merge arrays in TS, UPDATE.
   * If not found, INSERT. On 23505 (concurrent insert race), retry the
   * SELECT-merge-UPDATE path once.
   */
  private async upsertApproval(args: {
    tenant_id: string;
    target_entity_type: string;
    target_entity_id: string;
    approver_person_id: string;
    scope: ApprovalScope;
    reasons: Array<{ rule_id: string; denial_message: string | null }>;
  }): Promise<AssembledApproval> {
    return this.upsertWithRetry(args, 0);
  }

  private async upsertWithRetry(
    args: {
      tenant_id: string;
      target_entity_type: string;
      target_entity_id: string;
      approver_person_id: string;
      scope: ApprovalScope;
      reasons: Array<{ rule_id: string; denial_message: string | null }>;
    },
    attempt: number,
  ): Promise<AssembledApproval> {
    if (attempt > 2) {
      throw AppErrors.server('orders.approval_routing_failed', {
        detail: `approval-routing: dedup upsert retry exhausted for (target=${args.target_entity_id}, approver=${args.approver_person_id})`,
      });
    }

    const existing = await this.supabase.admin
      .from('approvals')
      .select('id, scope_breakdown')
      .eq('tenant_id', args.tenant_id)
      .eq('target_entity_id', args.target_entity_id)
      .eq('approver_person_id', args.approver_person_id)
      .eq('status', 'pending')
      .maybeSingle();
    if (existing.error) {
      throw wrapPgError(existing.error, 'order.approval_existing_lookup_failed', {
        detail: `Approval-routing existing-row lookup failed for target ${args.target_entity_id}`,
      });
    }

    if (existing.data) {
      const merged = mergeBreakdown(
        existing.data.scope_breakdown as AssembledApproval['scope_breakdown'],
        { ...args.scope, reasons: args.reasons },
      );
      const { error: updateErr } = await this.supabase.admin
        .from('approvals')
        .update({ scope_breakdown: merged })
        .eq('id', (existing.data as { id: string }).id);
      if (updateErr) {
        throw wrapPgError(updateErr, 'order.approval_scope_merge_failed', {
          detail: `Approval-routing scope_breakdown merge failed for approval ${(existing.data as { id: string }).id}`,
        });
      }
      return {
        target_entity_type: args.target_entity_type,
        target_entity_id: args.target_entity_id,
        approver_person_id: args.approver_person_id,
        scope_breakdown: merged,
        status: 'pending',
        was_existing: true,
      };
    }

    const insertScope: AssembledApproval['scope_breakdown'] = {
      ...args.scope,
      reasons: args.reasons,
    };
    const { error: insertErr } = await this.supabase.admin.from('approvals').insert({
      tenant_id: args.tenant_id,
      target_entity_type: args.target_entity_type,
      target_entity_id: args.target_entity_id,
      approver_person_id: args.approver_person_id,
      status: 'pending',
      scope_breakdown: insertScope,
    });
    if (insertErr) {
      // 23505 = unique violation on the dedup index. Retry the SELECT-merge
      // path so the second writer merges into the row the first writer just
      // committed.
      if ((insertErr as { code?: string }).code === '23505') {
        return this.upsertWithRetry(args, attempt + 1);
      }
      throw wrapPgError(insertErr, 'order.approval_insert_failed', {
        detail: `Approval-routing insert failed for target ${args.target_entity_id} approver ${args.approver_person_id}`,
      });
    }

    return {
      target_entity_type: args.target_entity_type,
      target_entity_id: args.target_entity_id,
      approver_person_id: args.approver_person_id,
      scope_breakdown: insertScope,
      status: 'pending',
      was_existing: false,
    };
  }
}

// ── Pure helpers (exported for testing) ───────────────────────────────────

export function mergeScopeInto(target: ApprovalScope, addition: ApprovalScope): ApprovalScope {
  for (const key of [
    'reservation_ids',
    'order_ids',
    'order_line_item_ids',
    'ticket_ids',
    'asset_reservation_ids',
  ] as const) {
    const existing = target[key] ?? [];
    const incoming = addition[key] ?? [];
    if (incoming.length === 0) continue;
    const merged = Array.from(new Set([...existing, ...incoming]));
    target[key] = merged;
  }
  return target;
}

export function mergeBreakdown(
  existing: AssembledApproval['scope_breakdown'],
  addition: AssembledApproval['scope_breakdown'],
): AssembledApproval['scope_breakdown'] {
  const out: AssembledApproval['scope_breakdown'] = { ...existing, reasons: [...(existing.reasons ?? [])] };
  mergeScopeInto(out, addition);
  // Reasons: dedup by rule_id.
  const seen = new Set(out.reasons.map((r) => r.rule_id));
  for (const r of addition.reasons ?? []) {
    if (!seen.has(r.rule_id)) {
      out.reasons.push(r);
      seen.add(r.rule_id);
    }
  }
  return out;
}
