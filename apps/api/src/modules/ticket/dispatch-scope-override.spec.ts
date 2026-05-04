/**
 * Integration spec for DispatchService.resolveChildSla scope-override wiring.
 *
 * Pins the two contract points codex flagged:
 *   1. Executor-SLA override wins over vendor/team defaults.
 *   2. Asset-only children (row has asset_id but no location_id) must still
 *      hit the override — asset fallback lives in ScopeOverrideResolverService
 *      and the dispatch call passes { locationId, assetId } through.
 */
import { DispatchService, DispatchDto } from './dispatch.service';

type ParentRow = {
  id: string; tenant_id: string; ticket_type_id: string | null;
  location_id: string | null; asset_id: string | null;
  priority: string; title: string; ticket_kind: string;
  status_category: string; requester_person_id: string | null;
};

function makeParent(over: Partial<ParentRow> = {}): ParentRow {
  return {
    id: 'parent-1', tenant_id: 't1', ticket_type_id: 'rt-1',
    location_id: null, asset_id: 'asset-1', priority: 'medium',
    title: 'Fix projector', ticket_kind: 'case', status_category: 'assigned',
    requester_person_id: 'person-1', ...over,
  };
}

function makeDeps(parent: ParentRow) {
  const inserted: Array<Record<string, unknown>> = [];
  const ticketService = {
    getById: jest.fn(async () => parent),
    addActivity: jest.fn().mockResolvedValue(undefined),
  };
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        // Step 1c.4: dispatch now writes to work_orders. Mock both for compat.
        if (table === 'work_orders' || table === 'tickets') {
          return {
            insert: (row: Record<string, unknown>) => {
              inserted.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: { ...row, id: 'child-1' }, error: null }),
                }),
              };
            },
            update: () => ({
              eq: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
            }),
          } as unknown;
        }
        if (table === 'request_types') {
          // Plan A.2: loadRequestTypeConfig now chains .eq('id').eq('tenant_id').
          const single = { data: { domain: 'av' }, error: null };
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => single }),
                maybeSingle: async () => single,
              }),
            }),
          } as unknown;
        }
        // vendors / teams / users — no defaults configured. If any of these
        // run, it means the scope-override step did NOT short-circuit.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        } as unknown;
      }),
    },
  };
  const routingService = {
    evaluate: jest.fn().mockResolvedValue({
      target: { kind: 'vendor', vendor_id: 'vendor-X' },
      chosen_by: 'request_type_default',
      rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    }),
    recordDecision: jest.fn().mockResolvedValue(undefined),
  };
  const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  return { ticketService, supabase, routingService, slaService, visibility, inserted };
}

describe('DispatchService.resolveChildSla — scope-override integration', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  it('applies executor_sla_policy_id from a scope override on a location-backed child', async () => {
    const parent = makeParent({ location_id: 'loc-floor3', asset_id: null });
    const deps = makeDeps(parent);
    const scopeOverrides = {
      resolve: jest.fn().mockImplementation(async (_t, _rt, intake) => {
        expect(intake).toEqual({ locationId: 'loc-floor3', assetId: null });
        return { executor_sla_policy_id: 'sla-executor', precedence: 'exact_space' };
      }),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    };
    const svc = new DispatchService(
      deps.supabase as never, deps.ticketService as never, deps.routingService as never,
      deps.slaService as never, deps.visibility as never, scopeOverrides as never,
    );
    const dto: DispatchDto = { title: 'Swap cable' };
    await svc.dispatch(parent.id, dto, '__system__');
    expect(scopeOverrides.resolve).toHaveBeenCalled();
    expect(deps.inserted[0].sla_id).toBe('sla-executor');
  });

  it('applies executor_sla_policy_id from a scope override on an asset-only child (no location)', async () => {
    const parent = makeParent({ location_id: null, asset_id: 'asset-projector-7' });
    const deps = makeDeps(parent);
    // The scope-override stub verifies it received assetId so the service's
    // deriveEffectiveLocation path is what unlocks the override — not any
    // caller-side fallback. If the dispatch ever reverts to passing only
    // location_id, this assertion fails.
    const scopeOverrides = {
      resolve: jest.fn().mockImplementation(async (_t, _rt, intake) => {
        expect(intake).toEqual({ locationId: null, assetId: 'asset-projector-7' });
        return { executor_sla_policy_id: 'sla-exec-asset', precedence: 'ancestor_space' };
      }),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    };
    const svc = new DispatchService(
      deps.supabase as never, deps.ticketService as never, deps.routingService as never,
      deps.slaService as never, deps.visibility as never, scopeOverrides as never,
    );
    await svc.dispatch(parent.id, { title: 'Onsite fix' }, '__system__');
    expect(scopeOverrides.resolve).toHaveBeenCalled();
    expect(deps.inserted[0].sla_id).toBe('sla-exec-asset');
  });

  it('falls through to vendor/team defaults when the override has no executor_sla_policy_id', async () => {
    const parent = makeParent({ location_id: 'loc-a', asset_id: null });
    const deps = makeDeps(parent);
    const scopeOverrides = {
      resolve: jest.fn().mockResolvedValue({ executor_sla_policy_id: null }),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    };
    const svc = new DispatchService(
      deps.supabase as never, deps.ticketService as never, deps.routingService as never,
      deps.slaService as never, deps.visibility as never, scopeOverrides as never,
    );
    await svc.dispatch(parent.id, { title: 'x' }, '__system__');
    // Override didn't set executor SLA, vendor/team defaults all null in this
    // stub — final sla_id should be null and no timers started.
    expect(deps.inserted[0].sla_id).toBeNull();
    expect(deps.slaService.startTimers).not.toHaveBeenCalled();
  });

  it('skips the override lookup when dto.sla_id is explicit', async () => {
    const parent = makeParent();
    const deps = makeDeps(parent);
    const scopeOverrides = {
      resolve: jest.fn(),
      resolveForLocation: jest.fn(),
      deriveEffectiveLocation: jest.fn(),
    };
    const svc = new DispatchService(
      deps.supabase as never, deps.ticketService as never, deps.routingService as never,
      deps.slaService as never, deps.visibility as never, scopeOverrides as never,
    );
    await svc.dispatch(parent.id, { title: 'x', sla_id: 'dto-sla' }, '__system__');
    expect(scopeOverrides.resolve).not.toHaveBeenCalled();
    expect(deps.inserted[0].sla_id).toBe('dto-sla');
  });
});
