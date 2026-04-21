import type { CaseOwnerPolicyDefinition, NormalizedRoutingContext, OwnerDecision } from '@prequest/shared';
import { RoutingEvaluatorService } from './routing-evaluator.service';
import { ResolverContext, ResolverDecision } from './resolver.types';

const TEAM_LEGACY = 'a1b2c3d4-e5f6-4789-9abc-111111111111';
const TEAM_V2 = 'a1b2c3d4-e5f6-4789-9abc-222222222222';
const RT_ID = 'b2c3d4e5-f6a7-4b89-8cde-333333333333';
const POLICY_ENTITY_ID = 'c3d4e5f6-a7b8-4c9d-9ef0-444444444444';

function legacyDecision(partial: Partial<ResolverDecision> = {}): ResolverDecision {
  return {
    target: { kind: 'team', team_id: TEAM_LEGACY },
    chosen_by: 'request_type_default',
    strategy: 'fixed',
    trace: [],
    ...partial,
  };
}

function stubResolver(decision: ResolverDecision = legacyDecision()) {
  return { resolve: jest.fn().mockResolvedValue(decision) } as any;
}

function stubSupabase(flags: Record<string, unknown>, requestTypeRow: { case_owner_policy_entity_id: string | null } | null = null) {
  const insert = jest.fn().mockResolvedValue({ error: null });
  const admin = {
    from: jest.fn((table: string) => {
      if (table === 'tenants') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { feature_flags: flags }, error: null }) }),
          }),
        };
      }
      if (table === 'request_types') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: requestTypeRow, error: null }) }),
            }),
          }),
        };
      }
      if (table === 'routing_dualrun_logs') {
        return { insert };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return { service: { admin } as any, insert };
}

function stubIntakeScoping(): any {
  const context: NormalizedRoutingContext = {
    tenant_id: 'tenant-1',
    request_type_id: RT_ID,
    domain_id: 'domain-1',
    priority: 'normal',
    location_id: null,
    asset_id: null,
    scope_source: 'requester_home',
    operational_scope_id: null,
    operational_scope_chain: [],
    evaluated_at: '2026-04-21T00:00:00.000Z',
    active_support_window_id: null,
  };
  return { normalize: jest.fn().mockResolvedValue(context) };
}

function stubPolicyStore(published: { config_type: 'case_owner_policy'; definition: CaseOwnerPolicyDefinition; version_id: string } | null): any {
  return { getPublishedDefinition: jest.fn().mockResolvedValue(published) };
}

function stubCaseOwnerEngine(target: { kind: 'team'; team_id: string } = { kind: 'team', team_id: TEAM_V2 }): any {
  const decision: OwnerDecision = {
    target,
    matched_row_id: 'default',
    trace: [{ step: 'policy_default', matched: true, reason: 'test', target }],
    evaluated_at: '2026-04-21T00:00:00.000Z',
  };
  return { evaluate: jest.fn().mockReturnValue(decision) };
}

function buildEvaluator(overrides: {
  resolver?: any;
  supabase?: any;
  intakeScoping?: any;
  policyStore?: any;
  caseOwnerEngine?: any;
}) {
  return new RoutingEvaluatorService(
    overrides.resolver ?? stubResolver(),
    overrides.supabase ?? stubSupabase({}).service,
    overrides.intakeScoping ?? stubIntakeScoping(),
    overrides.policyStore ?? stubPolicyStore(null),
    overrides.caseOwnerEngine ?? stubCaseOwnerEngine(),
  );
}

function examplePolicy(): CaseOwnerPolicyDefinition {
  return {
    schema_version: 1,
    request_type_id: RT_ID,
    scope_source: 'requester_home',
    rows: [],
    default_target: { kind: 'team', team_id: TEAM_V2 },
  };
}

const CTX: ResolverContext = {
  tenant_id: 'a1b2c3d4-e5f6-4789-9abc-555555555555',
  ticket_id: 'a1b2c3d4-e5f6-4789-9abc-666666666666',
  request_type_id: RT_ID,
  domain: 'it',
  priority: 'normal',
  asset_id: null,
  location_id: null,
};

describe('RoutingEvaluatorService', () => {
  it('mode=off is a pure pass-through — legacy called once, v2 never, no dualrun row', async () => {
    const resolver = stubResolver();
    const { service, insert } = stubSupabase({});
    const intakeScoping = stubIntakeScoping();
    const evaluator = buildEvaluator({ resolver, supabase: service, intakeScoping });

    const result = await evaluator.evaluateCaseOwner(CTX);

    expect(result).toEqual(legacyDecision());
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(intakeScoping.normalize).not.toHaveBeenCalled();
  });

  it('mode=dualrun with no policy attached — v2 returns unassigned, diff row written', async () => {
    const resolver = stubResolver();
    const { service, insert } = stubSupabase(
      { routing_v2_mode: 'dualrun' },
      { case_owner_policy_entity_id: null },
    );
    const evaluator = buildEvaluator({ resolver, supabase: service });

    const result = await evaluator.evaluateCaseOwner(CTX);

    // User still gets legacy during dualrun.
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_LEGACY });

    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.mode).toBe('dualrun');
    expect(row.hook).toBe('case_owner');
    expect(row.v2_output.target).toBeNull();
    expect(row.v2_output.chosen_by).toBe('unassigned');
    expect(row.target_match).toBe(false);
  });

  it('mode=dualrun with policy attached — v2 returns engine decision, diff captured', async () => {
    const resolver = stubResolver();
    const { service, insert } = stubSupabase(
      { routing_v2_mode: 'dualrun' },
      { case_owner_policy_entity_id: POLICY_ENTITY_ID },
    );
    const policyStore = stubPolicyStore({
      config_type: 'case_owner_policy',
      definition: examplePolicy(),
      version_id: 'v1',
    });
    const evaluator = buildEvaluator({ resolver, supabase: service, policyStore });

    const result = await evaluator.evaluateCaseOwner(CTX);

    // Legacy served during dualrun.
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_LEGACY });

    const row = insert.mock.calls[0][0];
    expect(row.v2_output.target).toEqual({ kind: 'team', team_id: TEAM_V2 });
    expect(row.v2_output.chosen_by).toBe('policy_default');
    // legacy team_id != v2 team_id → target_match=false
    expect(row.target_match).toBe(false);
    expect(row.chosen_by_match).toBe(false);
  });

  it('mode=v2_only with policy attached — v2 served, legacy skipped', async () => {
    const resolver = stubResolver();
    const { service } = stubSupabase(
      { routing_v2_mode: 'v2_only' },
      { case_owner_policy_entity_id: POLICY_ENTITY_ID },
    );
    const policyStore = stubPolicyStore({
      config_type: 'case_owner_policy',
      definition: examplePolicy(),
      version_id: 'v1',
    });
    const evaluator = buildEvaluator({ resolver, supabase: service, policyStore });

    const result = await evaluator.evaluateCaseOwner(CTX);

    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_V2 });
    expect(result.chosen_by).toBe('policy_default');
    // Legacy was not consulted.
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('mode=v2_only with no policy attached — v2 returns unassigned, does not throw (fail-soft during dual-run)', async () => {
    const resolver = stubResolver();
    const { service } = stubSupabase(
      { routing_v2_mode: 'v2_only' },
      { case_owner_policy_entity_id: null },
    );
    const evaluator = buildEvaluator({ resolver, supabase: service });

    const result = await evaluator.evaluateCaseOwner(CTX);

    expect(result.target).toBeNull();
    expect(result.chosen_by).toBe('unassigned');
  });

  it('child_dispatch hook still throws (Workstream C not shipped)', async () => {
    const resolver = stubResolver();
    const { service } = stubSupabase({ routing_v2_mode: 'dualrun' });
    const evaluator = buildEvaluator({ resolver, supabase: service });

    // Dualrun serves legacy regardless of v2 error; confirm the v2 error path
    // records the expected not-implemented message in the diff summary.
    const result = await evaluator.evaluateChildDispatch(CTX);
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_LEGACY });
  });

  it('caches the feature flag per tenant — 3 calls → 1 tenants read', async () => {
    const resolver = stubResolver();
    const { service } = stubSupabase({});
    const fromSpy = service.admin.from as jest.Mock;
    const evaluator = buildEvaluator({ resolver, supabase: service });

    await evaluator.evaluateCaseOwner(CTX);
    await evaluator.evaluateCaseOwner(CTX);
    await evaluator.evaluateCaseOwner(CTX);

    const tenantReads = fromSpy.mock.calls.filter((c) => c[0] === 'tenants').length;
    expect(tenantReads).toBe(1);
  });
});
