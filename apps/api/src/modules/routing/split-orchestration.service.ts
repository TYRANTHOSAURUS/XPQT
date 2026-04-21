import { Injectable } from '@nestjs/common';
import type {
  ChildDispatchPolicyDefinition,
  ChildPlan,
  NormalizedRoutingContext,
  VisibilityHints,
} from '@prequest/shared';

/**
 * Workstream C / Contract 3: Split / orchestration engine.
 *
 * Pure function. Decides how many child work orders to create and what scope
 * each one carries. This engine does NOT pick the assignee — that's Contract 4
 * (ChildExecutionResolverService). One engine per responsibility.
 *
 * MVP behavior:
 * - `dispatch_mode = 'none'`      → zero plans
 * - `dispatch_mode = 'always' | 'optional' | 'multi_template'` → at least one
 * - `split_strategy = 'single'`   → exactly one plan, using the parent context
 * - `split_strategy = 'per_location' | 'per_asset' | 'per_vendor_service'`
 *   → one plan. True multi-plan splits require per-scope intake input which
 *   legacy ticket creation doesn't carry. Workstream D/E extends this once
 *   the studio UI and multi-location intake form land.
 */

const DEFAULT_VISIBILITY: VisibilityHints = {
  parent_owner_sees_children: true,
  vendor_children_visibility: 'vendor_and_parent_owner',
  cross_location_overlays: [],
};

@Injectable()
export class SplitOrchestrationService {
  plan(
    context: NormalizedRoutingContext,
    policy: ChildDispatchPolicyDefinition,
  ): ChildPlan[] {
    if (policy.dispatch_mode === 'none') return [];

    const basePlan: ChildPlan = {
      plan_id: crypto.randomUUID(),
      derived_scope: deriveScope(context, policy),
      title_hint: titleHint(policy),
      execution_context: context,
      visibility_hints: DEFAULT_VISIBILITY,
    };

    return [basePlan];
  }
}

function deriveScope(
  context: NormalizedRoutingContext,
  policy: ChildDispatchPolicyDefinition,
): ChildPlan['derived_scope'] {
  switch (policy.split_strategy) {
    case 'per_asset':
      if (context.asset_id) return { kind: 'asset', asset_id: context.asset_id };
      return fallbackLocationScope(context);
    case 'per_vendor_service':
      if (policy.fixed_target && policy.fixed_target.kind === 'vendor') {
        return {
          kind: 'vendor_service',
          vendor_id: policy.fixed_target.id,
          service_area_id: null,
        };
      }
      return fallbackLocationScope(context);
    case 'per_location':
    case 'single':
    default:
      return fallbackLocationScope(context);
  }
}

function fallbackLocationScope(context: NormalizedRoutingContext): ChildPlan['derived_scope'] {
  if (context.location_id) return { kind: 'location', location_id: context.location_id };
  if (context.asset_id) return { kind: 'asset', asset_id: context.asset_id };
  // No scope available. Return a location with empty string so downstream can
  // detect and route to fallback/unassigned. A richer sentinel shape would be
  // nicer but would require widening the discriminated union in shared.
  return { kind: 'location', location_id: '' };
}

function titleHint(policy: ChildDispatchPolicyDefinition): string {
  return `Child work (${policy.split_strategy})`;
}
