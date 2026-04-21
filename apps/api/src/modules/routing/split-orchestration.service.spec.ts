import type { ChildDispatchPolicyDefinition, NormalizedRoutingContext } from '@prequest/shared';
import { SplitOrchestrationService } from './split-orchestration.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const RT = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const LOC = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const ASSET = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';
const VENDOR = 'e5f6a7b8-c9d0-4e1f-9012-3456789abcde';

function ctx(overrides: Partial<NormalizedRoutingContext> = {}): NormalizedRoutingContext {
  return {
    tenant_id: TENANT,
    request_type_id: RT,
    domain_id: null,
    priority: 'normal',
    location_id: LOC,
    asset_id: null,
    scope_source: 'selected',
    operational_scope_id: LOC,
    operational_scope_chain: [LOC],
    evaluated_at: '2026-04-21T10:00:00.000Z',
    active_support_window_id: null,
    ...overrides,
  };
}

function policy(overrides: Partial<ChildDispatchPolicyDefinition> = {}): ChildDispatchPolicyDefinition {
  return {
    schema_version: 1,
    request_type_id: RT,
    dispatch_mode: 'always',
    split_strategy: 'single',
    execution_routing: 'fixed',
    ...overrides,
  };
}

describe('SplitOrchestrationService', () => {
  const svc = new SplitOrchestrationService();

  it('returns zero plans when dispatch_mode=none', () => {
    expect(svc.plan(ctx(), policy({ dispatch_mode: 'none' }))).toEqual([]);
  });

  it('returns one plan with location scope for split_strategy=single', () => {
    const plans = svc.plan(ctx(), policy({ split_strategy: 'single' }));
    expect(plans).toHaveLength(1);
    expect(plans[0].derived_scope).toEqual({ kind: 'location', location_id: LOC });
  });

  it('split_strategy=per_asset uses context.asset_id when present', () => {
    const plans = svc.plan(ctx({ asset_id: ASSET }), policy({ split_strategy: 'per_asset' }));
    expect(plans[0].derived_scope).toEqual({ kind: 'asset', asset_id: ASSET });
  });

  it('split_strategy=per_asset falls back to location when no asset_id', () => {
    const plans = svc.plan(ctx({ asset_id: null }), policy({ split_strategy: 'per_asset' }));
    expect(plans[0].derived_scope).toEqual({ kind: 'location', location_id: LOC });
  });

  it('split_strategy=per_vendor_service uses fixed_target when it is a vendor', () => {
    const plans = svc.plan(
      ctx(),
      policy({ split_strategy: 'per_vendor_service', fixed_target: { kind: 'vendor', id: VENDOR } }),
    );
    expect(plans[0].derived_scope).toEqual({
      kind: 'vendor_service',
      vendor_id: VENDOR,
      service_area_id: null,
    });
  });

  it('default visibility hints: parent owner sees children, vendor children visible to parent owner too', () => {
    const plans = svc.plan(ctx(), policy());
    expect(plans[0].visibility_hints.parent_owner_sees_children).toBe(true);
    expect(plans[0].visibility_hints.vendor_children_visibility).toBe('vendor_and_parent_owner');
  });

  it('plan execution_context preserves the incoming NormalizedRoutingContext', () => {
    const input = ctx({ priority: 'urgent' });
    const plans = svc.plan(input, policy());
    expect(plans[0].execution_context).toBe(input);
  });
});
