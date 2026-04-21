import { RoutingEvaluatorService } from './routing-evaluator.service';
import { ResolverContext, ResolverDecision } from './resolver.types';

function legacyDecision(partial: Partial<ResolverDecision> = {}): ResolverDecision {
  return {
    target: { kind: 'team', team_id: 'team-legacy' },
    chosen_by: 'request_type_default',
    strategy: 'fixed',
    trace: [],
    ...partial,
  };
}

function stubResolver(decision: ResolverDecision = legacyDecision()) {
  return { resolve: jest.fn().mockResolvedValue(decision) } as any;
}

function stubSupabase(flags: Record<string, unknown>) {
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
      if (table === 'routing_dualrun_logs') {
        return { insert };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return { service: { admin } as any, insert };
}

const CTX: ResolverContext = {
  tenant_id: 'tenant-1',
  ticket_id: 'ticket-1',
  request_type_id: 'rt-1',
  domain: 'it',
  priority: 'normal',
  asset_id: null,
  location_id: null,
};

describe('RoutingEvaluatorService', () => {
  it('mode=off is a pure pass-through — legacy called once, v2 never, no dualrun row', async () => {
    const resolver = stubResolver();
    const { service, insert } = stubSupabase({}); // missing key → off
    const evaluator = new RoutingEvaluatorService(resolver, service);

    const result = await evaluator.evaluateCaseOwner(CTX);

    expect(result).toEqual(legacyDecision());
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('mode=dualrun serves legacy and writes a diff row (v2 stub throws → diff_summary.v2_error)', async () => {
    const resolver = stubResolver();
    const { service, insert } = stubSupabase({ routing_v2_mode: 'dualrun' });
    const evaluator = new RoutingEvaluatorService(resolver, service);

    const result = await evaluator.evaluateCaseOwner(CTX);

    expect(result.target).toEqual({ kind: 'team', team_id: 'team-legacy' });
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.mode).toBe('dualrun');
    expect(row.hook).toBe('case_owner');
    expect(row.v2_output).toBeNull();
    expect(row.diff_summary).toMatchObject({ v2_error: expect.stringContaining('not implemented') });
  });

  it('mode=v2_only throws when v2 engine is not implemented (expected until Workstream B wires it in)', async () => {
    const resolver = stubResolver();
    const { service } = stubSupabase({ routing_v2_mode: 'v2_only' });
    const evaluator = new RoutingEvaluatorService(resolver, service);

    await expect(evaluator.evaluateCaseOwner(CTX)).rejects.toThrow(/v2_only.*v2 evaluation failed/);
  });

  it('caches the feature flag per tenant — 3 calls → 1 tenants read', async () => {
    const resolver = stubResolver();
    const { service } = stubSupabase({}); // off
    const fromSpy = service.admin.from as jest.Mock;
    const evaluator = new RoutingEvaluatorService(resolver, service);

    await evaluator.evaluateCaseOwner(CTX);
    await evaluator.evaluateCaseOwner(CTX);
    await evaluator.evaluateCaseOwner(CTX);

    const tenantReads = fromSpy.mock.calls.filter((c) => c[0] === 'tenants').length;
    expect(tenantReads).toBe(1);
  });
});
