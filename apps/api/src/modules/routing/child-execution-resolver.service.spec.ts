import type { ChildDispatchPolicyDefinition, ChildPlan, NormalizedRoutingContext } from '@prequest/shared';
import { ChildExecutionResolverService } from './child-execution-resolver.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const RT = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const LOC = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const DOMAIN = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';

const TEAM_FIXED = '11111111-2222-4333-9444-555555555555';
const TEAM_FALLBACK = '22222222-3333-4444-9555-666666666666';
const TEAM_LOCATION = '33333333-4444-4555-9666-777777777777';
const VENDOR_X = '44444444-5555-4666-9777-888888888888';

function stubRepo(locationTeamHit: { team_id: string | null; vendor_id: string | null } | null = null) {
  return {
    locationTeam: jest.fn().mockResolvedValue(locationTeamHit),
  } as any;
}

function baseContext(overrides: Partial<NormalizedRoutingContext> = {}): NormalizedRoutingContext {
  return {
    tenant_id: TENANT,
    request_type_id: RT,
    domain_id: DOMAIN,
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

function plan(ctx: NormalizedRoutingContext = baseContext()): ChildPlan {
  return {
    plan_id: 'p0',
    derived_scope: { kind: 'location', location_id: LOC },
    title_hint: 'x',
    execution_context: ctx,
    visibility_hints: {
      parent_owner_sees_children: true,
      vendor_children_visibility: 'vendor_and_parent_owner',
      cross_location_overlays: [],
    },
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

describe('ChildExecutionResolverService', () => {
  it('execution_routing=fixed picks fixed_target as a team', async () => {
    const svc = new ChildExecutionResolverService(stubRepo());
    const result = await svc.resolve(
      plan(),
      policy({ fixed_target: { kind: 'team', id: TEAM_FIXED } }),
    );
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_FIXED });
    expect(result.chosen_by).toBe('policy_row');
  });

  it('execution_routing=fixed picks fixed_target as a vendor — vendors are first-class here', async () => {
    const svc = new ChildExecutionResolverService(stubRepo());
    const result = await svc.resolve(
      plan(),
      policy({ fixed_target: { kind: 'vendor', id: VENDOR_X } }),
    );
    expect(result.target).toEqual({ kind: 'vendor', vendor_id: VENDOR_X });
  });

  it('execution_routing=fixed with no fixed_target falls back to fallback_target', async () => {
    const svc = new ChildExecutionResolverService(stubRepo());
    const result = await svc.resolve(
      plan(),
      policy({ fallback_target: { kind: 'team', id: TEAM_FALLBACK } }),
    );
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_FALLBACK });
    expect(result.chosen_by).toBe('policy_default');
  });

  it('execution_routing=fixed with neither fixed nor fallback → unassigned', async () => {
    const svc = new ChildExecutionResolverService(stubRepo());
    const result = await svc.resolve(plan(), policy());
    expect(result.target).toBeNull();
    expect(result.chosen_by).toBe('unassigned');
  });

  it('execution_routing=workflow returns unassigned with a workflow trace reason', async () => {
    const svc = new ChildExecutionResolverService(stubRepo());
    const result = await svc.resolve(plan(), policy({ execution_routing: 'workflow' }));
    expect(result.target).toBeNull();
    expect(result.chosen_by).toBe('unassigned');
    expect(result.trace[0].reason).toMatch(/workflow execution/);
  });

  it('execution_routing=by_location hits location_teams when a row exists', async () => {
    const svc = new ChildExecutionResolverService(
      stubRepo({ team_id: TEAM_LOCATION, vendor_id: null }),
    );
    const result = await svc.resolve(plan(), policy({ execution_routing: 'by_location' }));
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_LOCATION });
    expect(result.chosen_by).toBe('location_team');
  });

  it('execution_routing=by_location with vendor hit returns vendor target', async () => {
    const svc = new ChildExecutionResolverService(
      stubRepo({ team_id: null, vendor_id: VENDOR_X }),
    );
    const result = await svc.resolve(plan(), policy({ execution_routing: 'by_location' }));
    expect(result.target).toEqual({ kind: 'vendor', vendor_id: VENDOR_X });
  });

  it('execution_routing=by_location falls back to fallback_target on no row', async () => {
    const svc = new ChildExecutionResolverService(stubRepo(null));
    const result = await svc.resolve(
      plan(),
      policy({ execution_routing: 'by_location', fallback_target: { kind: 'team', id: TEAM_FALLBACK } }),
    );
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_FALLBACK });
  });

  it('execution_routing=by_location with null domain_id skips lookup and falls through', async () => {
    const repo = stubRepo();
    const svc = new ChildExecutionResolverService(repo);
    const ctx = baseContext({ domain_id: null });
    const result = await svc.resolve(plan(ctx), policy({ execution_routing: 'by_location' }));
    expect(repo.locationTeam).not.toHaveBeenCalled();
    expect(result.chosen_by).toBe('unassigned');
    const skipEntry = result.trace.find((t) => t.reason.includes('no domain_id'));
    expect(skipEntry).toBeDefined();
  });
});
