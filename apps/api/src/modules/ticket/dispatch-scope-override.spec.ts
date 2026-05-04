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

// Plan A.4 / Commit 2 — system actor must validate FK refs. Convert short
// ids to v4-shaped uuids so assertTenantOwned passes; mock seeds a known set.
const UUID_PREFIX = '00000000-0000-4000-8000-';
function uuidFor(short: string): string {
  const hex = Buffer.from(short).toString('hex').slice(0, 12).padEnd(12, '0');
  return UUID_PREFIX + hex;
}
const UUID = {
  parent: uuidFor('parent1'),
  rt: uuidFor('rt1'),
  asset: uuidFor('asset1'),
  vendorX: uuidFor('vendorX'),
  person: uuidFor('person1'),
  locFloor3: uuidFor('locFlr3'),
  locA: uuidFor('locA'),
  assetProjector7: uuidFor('asProj7'),
  slaExecutor: uuidFor('slaExec'),
  slaExecAsset: uuidFor('slaXAst'),
  dtoSla: uuidFor('dtoSla'),
};
const KNOWN_IDS = new Set(Object.values(UUID));

type ParentRow = {
  id: string; tenant_id: string; ticket_type_id: string | null;
  location_id: string | null; asset_id: string | null;
  priority: string; title: string; ticket_kind: string;
  status_category: string; requester_person_id: string | null;
};

function makeParent(over: Partial<ParentRow> = {}): ParentRow {
  return {
    id: UUID.parent, tenant_id: 't1', ticket_type_id: UUID.rt,
    location_id: null, asset_id: UUID.asset, priority: 'medium',
    title: 'Fix projector', ticket_kind: 'case', status_category: 'assigned',
    requester_person_id: UUID.person, ...over,
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
        // vendors / teams / users / sla_policies / spaces / assets —
        // no defaults configured. If any of these run for SLA-resolution,
        // it means the scope-override step did NOT short-circuit. The
        // assertTenantOwned validator-shape (`select('id')`) is recognised
        // so a known uuid in the test fixture passes.
        return {
          select: (cols: string) => ({
            eq: (_col: string, id: string) => ({
              eq: () => ({
                maybeSingle: async () => {
                  if (cols === 'id') {
                    return { data: KNOWN_IDS.has(id) ? { id } : null, error: null };
                  }
                  return { data: null, error: null };
                },
              }),
              maybeSingle: async () => {
                if (cols === 'id') {
                  return { data: KNOWN_IDS.has(id) ? { id } : null, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        } as unknown;
      }),
    },
  };
  const routingService = {
    evaluate: jest.fn().mockResolvedValue({
      target: { kind: 'vendor', vendor_id: UUID.vendorX },
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
    const parent = makeParent({ location_id: UUID.locFloor3, asset_id: null });
    const deps = makeDeps(parent);
    const scopeOverrides = {
      resolve: jest.fn().mockImplementation(async (_t, _rt, intake) => {
        expect(intake).toEqual({ locationId: UUID.locFloor3, assetId: null });
        return { executor_sla_policy_id: UUID.slaExecutor, precedence: 'exact_space' };
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
    expect(deps.inserted[0].sla_id).toBe(UUID.slaExecutor);
  });

  it('applies executor_sla_policy_id from a scope override on an asset-only child (no location)', async () => {
    const parent = makeParent({ location_id: null, asset_id: UUID.assetProjector7 });
    const deps = makeDeps(parent);
    // The scope-override stub verifies it received assetId so the service's
    // deriveEffectiveLocation path is what unlocks the override — not any
    // caller-side fallback. If the dispatch ever reverts to passing only
    // location_id, this assertion fails.
    const scopeOverrides = {
      resolve: jest.fn().mockImplementation(async (_t, _rt, intake) => {
        expect(intake).toEqual({ locationId: null, assetId: UUID.assetProjector7 });
        return { executor_sla_policy_id: UUID.slaExecAsset, precedence: 'ancestor_space' };
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
    expect(deps.inserted[0].sla_id).toBe(UUID.slaExecAsset);
  });

  it('falls through to vendor/team defaults when the override has no executor_sla_policy_id', async () => {
    const parent = makeParent({ location_id: UUID.locA, asset_id: null });
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
    await svc.dispatch(parent.id, { title: 'x', sla_id: UUID.dtoSla }, '__system__');
    expect(scopeOverrides.resolve).not.toHaveBeenCalled();
    expect(deps.inserted[0].sla_id).toBe(UUID.dtoSla);
  });
});
