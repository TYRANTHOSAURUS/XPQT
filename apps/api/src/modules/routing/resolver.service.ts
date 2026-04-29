import { Injectable } from '@nestjs/common';
import { ResolverRepository } from './resolver-repository';
import { ScopeOverrideResolverService } from './scope-override-resolver.service';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  LocationTeamHit,
  ResolverContext,
  ResolverDecision,
  TraceEntry,
} from './resolver.types';

@Injectable()
export class ResolverService {
  constructor(
    private readonly repo: ResolverRepository,
    private readonly scopeOverrides: ScopeOverrideResolverService,
  ) {}

  async resolve(context: ResolverContext): Promise<ResolverDecision> {
    const trace: TraceEntry[] = [];
    const loaded = await this.hydrate(context);

    // Scope-override pre-step. When the admin has configured a request-type-
    // scoped handler override that matches this ticket's location, it wins
    // over rules/asset/location/default. handler_kind='none' is an explicit
    // unassignment and is terminal (the admin is saying "this scope has no
    // coverage"). handler_kind=null means the override only touches workflow/
    // SLA/policy-entity ids; routing falls through to the normal chain and
    // downstream callers consume the override for their own fields.
    // See live-doc §5.5 + §6.3.
    // Effective-location fallback (explicit → asset) is centralized in
    // ScopeOverrideResolverService. The asset was already hydrated above so
    // we resolve the effective space ourselves and call resolveForLocation
    // to skip a second assets round trip; semantics match ScopeOverrideResolverService.deriveEffectiveLocation.
    const overrideLocationId = context.location_id ?? loaded.asset?.assigned_space_id ?? null;
    const override = context.request_type_id
      ? await this.scopeOverrides.resolveForLocation(
          context.tenant_id,
          context.request_type_id,
          overrideLocationId,
        )
      : null;
    if (override?.handler_kind === 'none') {
      trace.push({
        step: 'scope_override_unassigned',
        matched: true,
        reason: `scope override ${override.id} (${override.precedence}) handler_kind=none`,
        target: null,
      });
      return { target: null, chosen_by: 'scope_override_unassigned', strategy: 'fixed', trace };
    }
    if (override?.handler_kind === 'team' && override.handler_team_id) {
      const target: AssignmentTarget = { kind: 'team', team_id: override.handler_team_id };
      trace.push({
        step: 'scope_override',
        matched: true,
        reason: `scope override ${override.id} (${override.precedence}) team`,
        target,
      });
      return { target, chosen_by: 'scope_override', strategy: 'fixed', trace };
    }
    if (override?.handler_kind === 'vendor' && override.handler_vendor_id) {
      const target: AssignmentTarget = { kind: 'vendor', vendor_id: override.handler_vendor_id };
      trace.push({
        step: 'scope_override',
        matched: true,
        reason: `scope override ${override.id} (${override.precedence}) vendor`,
        target,
      });
      return { target, chosen_by: 'scope_override', strategy: 'fixed', trace };
    }
    if (override) {
      trace.push({
        step: 'scope_override',
        matched: false,
        reason: `scope override ${override.id} (${override.precedence}) has no handler — falling through to chain`,
        target: null,
      });
    }

    const ruleHit = await this.tryRules(context, trace);
    if (ruleHit) return ruleHit;

    const shape: FulfillmentShape = loaded.request_type?.fulfillment_strategy ?? 'fixed';

    if (shape === 'asset' || shape === 'auto') {
      const hit = this.tryAsset(loaded.asset, trace);
      if (hit) return this.done(trace, hit.step, shape, hit.target);
    }

    if ((shape === 'location' || shape === 'auto') && loaded.location_chain) {
      const hit = await this.tryLocationChain(loaded.location_chain, loaded.domain_chain ?? [], trace);
      if (hit) return this.done(trace, hit.step, shape, hit.target);
    }

    const rt = loaded.request_type;
    if (rt) {
      const rtDefault = this.pickTarget(rt.default_team_id, rt.default_vendor_id);
      if (rtDefault) {
        trace.push({ step: 'request_type_default', matched: true, reason: `request type ${rt.id}`, target: rtDefault });
        return this.done(trace, 'request_type_default', shape, rtDefault);
      }
      trace.push({ step: 'request_type_default', matched: false, reason: `request type ${rt.id} has no default`, target: null });
    }

    trace.push({ step: 'unassigned', matched: true, reason: 'no candidates matched', target: null });
    return { target: null, chosen_by: 'unassigned', strategy: shape, trace };
  }

  private async tryRules(context: ResolverContext, trace: TraceEntry[]): Promise<ResolverDecision | null> {
    const excluded = context.excluded_rule_ids;
    const allRules = await this.repo.loadRoutingRules(context.tenant_id);
    const rules = excluded && excluded.length > 0
      ? allRules.filter((r) => !excluded.includes(r.id))
      : allRules;
    const ruleCtx: Record<string, unknown> = {
      ticket_type_id: context.request_type_id,
      request_type_id: context.request_type_id,
      domain: context.domain,
      location_id: context.location_id,
      priority: context.priority,
      asset_id: context.asset_id,
    };

    for (const rule of rules) {
      if (!this.matchesConditions(rule.conditions, ruleCtx)) continue;
      const target: AssignmentTarget | null = rule.action_assign_team_id
        ? { kind: 'team', team_id: rule.action_assign_team_id }
        : rule.action_assign_user_id
        ? { kind: 'user', user_id: rule.action_assign_user_id }
        : null;
      if (!target) continue;
      trace.push({ step: 'rule', matched: true, reason: `rule ${rule.name}`, target });
      return {
        target,
        chosen_by: 'rule',
        strategy: 'rule',
        rule_id: rule.id,
        rule_name: rule.name,
        trace,
      };
    }
    return null;
  }

  private matchesConditions(
    conditions: Array<{ field: string; operator: string; value: unknown }>,
    context: Record<string, unknown>,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;
    return conditions.every((c) => {
      const actual = context[c.field];
      switch (c.operator) {
        case 'equals': return actual === c.value;
        case 'not_equals': return actual !== c.value;
        case 'in': return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
        case 'not_in': return Array.isArray(c.value) && !(c.value as unknown[]).includes(actual);
        case 'exists': return actual !== null && actual !== undefined;
        case 'gt': {
          const cmp = this.compareOrdinal(actual, c.value);
          return Number.isFinite(cmp) && cmp > 0;
        }
        case 'lt': {
          const cmp = this.compareOrdinal(actual, c.value);
          return Number.isFinite(cmp) && cmp < 0;
        }
        case 'gte': {
          const cmp = this.compareOrdinal(actual, c.value);
          return Number.isFinite(cmp) && cmp >= 0;
        }
        case 'lte': {
          const cmp = this.compareOrdinal(actual, c.value);
          return Number.isFinite(cmp) && cmp <= 0;
        }
        case 'contains': {
          if (typeof actual === 'string' && typeof c.value === 'string') {
            return actual.includes(c.value);
          }
          if (Array.isArray(actual)) {
            return (actual as unknown[]).includes(c.value);
          }
          return false;
        }
        default: return false;
      }
    });
  }

  // Ordered comparison for gt/lt/gte/lte. Numbers compare numerically; strings
  // compare lexicographically (ISO timestamps and ISO dates compare correctly
  // under that rule). Mismatched types return NaN so the operator falls
  // through to "doesn't match" instead of accidentally matching via coercion.
  private compareOrdinal(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }
    return NaN;
  }

  private tryAsset(
    asset: NonNullable<ResolverContext['loaded']>['asset'],
    trace: TraceEntry[],
  ): { step: ChosenBy; target: AssignmentTarget } | null {
    if (!asset) {
      trace.push({ step: 'asset_override', matched: false, reason: 'no asset in context', target: null });
      return null;
    }
    const override = this.pickTarget(asset.override_team_id, asset.override_vendor_id);
    if (override) {
      trace.push({ step: 'asset_override', matched: true, reason: 'asset override', target: override });
      return { step: 'asset_override', target: override };
    }
    trace.push({ step: 'asset_override', matched: false, reason: 'no asset override', target: null });

    const typeDefault = this.pickTarget(asset.type.default_team_id, asset.type.default_vendor_id);
    if (typeDefault) {
      trace.push({ step: 'asset_type_default', matched: true, reason: `asset type ${asset.asset_type_id}`, target: typeDefault });
      return { step: 'asset_type_default', target: typeDefault };
    }
    trace.push({ step: 'asset_type_default', matched: false, reason: `asset type ${asset.asset_type_id} has no default`, target: null });
    return null;
  }

  private async tryLocationChain(
    chain: string[],
    domainChain: string[],
    trace: TraceEntry[],
  ): Promise<{ step: ChosenBy; target: AssignmentTarget } | null> {
    if (domainChain.length === 0) {
      trace.push({ step: 'location_team', matched: false, reason: 'no domain in context', target: null });
      return null;
    }

    for (let d = 0; d < domainChain.length; d++) {
      const dom = domainChain[d];
      for (let s = 0; s < chain.length; s++) {
        const spaceId = chain[s];
        const hit = await this.repo.locationTeam(spaceId, dom);
        const target = this.fromHit(hit);
        if (target) {
          const step: ChosenBy =
            d > 0 ? 'domain_fallback'
            : s === 0 ? 'location_team'
            : 'parent_location_team';
          trace.push({ step, matched: true, reason: `space ${spaceId} domain ${dom}`, target });
          return { step, target };
        }
        const groupHit = await this.repo.spaceGroupTeam(spaceId, dom);
        const groupTarget = this.fromHit(groupHit);
        if (groupTarget) {
          const step: ChosenBy = d > 0 ? 'domain_fallback' : 'space_group_team';
          trace.push({ step, matched: true, reason: `space ${spaceId} (via group) domain ${dom}`, target: groupTarget });
          return { step, target: groupTarget };
        }
      }
    }
    trace.push({ step: 'location_team', matched: false, reason: 'no location match across domain chain', target: null });
    return null;
  }

  private async hydrate(context: ResolverContext) {
    const request_type = context.request_type_id
      ? await this.repo.loadRequestType(context.request_type_id)
      : null;
    const asset = context.asset_id ? await this.repo.loadAsset(context.asset_id) : null;
    const primaryLocation = context.location_id ?? asset?.assigned_space_id ?? null;
    const location_chain = primaryLocation ? await this.repo.locationChain(primaryLocation) : [];
    const domain_chain = context.domain
      ? await this.repo.domainChain(context.tenant_id, context.domain)
      : [];
    context.loaded = { request_type, asset, location_chain, domain_chain };
    return context.loaded;
  }

  private fromHit(hit: LocationTeamHit | null): AssignmentTarget | null {
    if (!hit) return null;
    return this.pickTarget(hit.team_id, hit.vendor_id);
  }

  private pickTarget(team_id: string | null | undefined, vendor_id: string | null | undefined): AssignmentTarget | null {
    if (team_id) return { kind: 'team', team_id };
    if (vendor_id) return { kind: 'vendor', vendor_id };
    return null;
  }

  private done(trace: TraceEntry[], chosen_by: ChosenBy, strategy: FulfillmentShape, target: AssignmentTarget): ResolverDecision {
    return { target, chosen_by, strategy, trace };
  }
}
