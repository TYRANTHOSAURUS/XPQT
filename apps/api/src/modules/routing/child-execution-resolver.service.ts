import { Injectable } from '@nestjs/common';
import type {
  AssignmentTarget,
  ChildDispatchPolicyDefinition,
  ChildPlan,
  ResolverOutput,
  TraceEntry,
} from '@prequest/shared';
import { ResolverRepository } from './resolver-repository';

/**
 * Workstream C / Contract 4: Assignment resolver for child work orders.
 *
 * Given one concrete ChildPlan + its published ChildDispatchPolicyDefinition,
 * picks one executor target. Vendors ARE first-class here (unlike parent case
 * owners — see plan principle #2).
 *
 * MVP coverage:
 *   - execution_routing = 'fixed'   → fixed_target, fall back to fallback_target
 *   - execution_routing = 'by_asset'
 *                      | 'by_location'
 *                      | 'by_asset_then_location'  → location-team walk via
 *     ResolverRepository, then fallback_target, then unassigned
 *   - execution_routing = 'workflow' → unassigned (workflow-created children
 *     resolve through a different path in DispatchService)
 *
 * Not covered yet: time windows (Workstream D), per-asset override column on
 * the policy itself (studio UI work).
 */

@Injectable()
export class ChildExecutionResolverService {
  constructor(private readonly repo: ResolverRepository) {}

  async resolve(
    plan: ChildPlan,
    policy: ChildDispatchPolicyDefinition,
  ): Promise<ResolverOutput> {
    const trace: TraceEntry[] = [];

    if (policy.execution_routing === 'fixed') {
      const hit = pickFixed(policy.fixed_target);
      if (hit) {
        trace.push({
          step: 'policy_row',
          matched: true,
          reason: `fixed_target ${policy.fixed_target?.kind}/${policy.fixed_target?.id}`,
          target: hit,
        });
        return done(trace, hit, 'policy_row', plan.execution_context.evaluated_at);
      }
      return fallbackOrUnassigned(policy, trace, plan, 'fixed_target missing');
    }

    if (policy.execution_routing === 'workflow') {
      trace.push({
        step: 'unassigned',
        matched: true,
        reason: 'workflow execution — children resolve via DispatchService, not the resolver',
        target: null,
      });
      return done(trace, null, 'unassigned', plan.execution_context.evaluated_at);
    }

    // by_asset | by_location | by_asset_then_location — use the resolver repo.
    const locationFirst = policy.execution_routing !== 'by_asset';
    const location_id =
      plan.derived_scope.kind === 'location'
        ? plan.derived_scope.location_id
        : plan.execution_context.location_id;

    if (locationFirst && location_id) {
      const domain = plan.execution_context.domain_id ?? '';
      if (domain) {
        const hit = await this.repo.locationTeam(location_id, domain);
        if (hit && (hit.team_id || hit.vendor_id)) {
          const target: AssignmentTarget = hit.team_id
            ? { kind: 'team', team_id: hit.team_id }
            : { kind: 'vendor', vendor_id: hit.vendor_id! };
          trace.push({
            step: 'location_team',
            matched: true,
            reason: `location_team(${location_id}, ${domain})`,
            target,
          });
          return done(trace, target, 'location_team', plan.execution_context.evaluated_at);
        }
        trace.push({
          step: 'location_team',
          matched: false,
          reason: `no location_teams row for (${location_id}, ${domain})`,
          target: null,
        });
      } else {
        trace.push({
          step: 'location_team',
          matched: false,
          reason: 'no domain_id resolved — skipping location_team lookup',
          target: null,
        });
      }
    }

    // TODO: asset/asset-type lookup path — Workstream D widens ResolverRepo.
    return fallbackOrUnassigned(policy, trace, plan, 'no execution match');
  }
}

function pickFixed(fixed: ChildDispatchPolicyDefinition['fixed_target']): AssignmentTarget | null {
  if (!fixed) return null;
  if (fixed.kind === 'team') return { kind: 'team', team_id: fixed.id };
  if (fixed.kind === 'vendor') return { kind: 'vendor', vendor_id: fixed.id };
  return null;
}

function fallbackOrUnassigned(
  policy: ChildDispatchPolicyDefinition,
  trace: TraceEntry[],
  plan: ChildPlan,
  reason: string,
): ResolverOutput {
  if (policy.fallback_target) {
    const t = pickFixed(policy.fallback_target);
    if (t) {
      trace.push({
        step: 'policy_default',
        matched: true,
        reason: `${reason} — using fallback_target ${policy.fallback_target.kind}/${policy.fallback_target.id}`,
        target: t,
      });
      return done(trace, t, 'policy_default', plan.execution_context.evaluated_at);
    }
  }
  trace.push({ step: 'unassigned', matched: true, reason, target: null });
  return done(trace, null, 'unassigned', plan.execution_context.evaluated_at);
}

function done(
  trace: TraceEntry[],
  target: AssignmentTarget | null,
  chosen_by: ResolverOutput['chosen_by'],
  evaluated_at: string,
): ResolverOutput {
  return { target, chosen_by, trace, evaluated_at };
}
