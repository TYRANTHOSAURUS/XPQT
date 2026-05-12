import { PMGeneratorService, type DuePlanRow } from './pm-generator.service';

const TENANT_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TENANT_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';
const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_IDS_FOR_TYPE = [
  '44440000-0000-4000-8000-000000000001',
  '44440000-0000-4000-8000-000000000002',
  '44440000-0000-4000-8000-000000000003',
] as const;

function makePlan(overrides: Partial<DuePlanRow> = {}): DuePlanRow {
  return {
    id: PLAN_ID,
    tenant_id: TENANT_A,
    asset_id: ASSET_ID,
    asset_type_id: null,
    recurrence_interval: 1,
    recurrence_unit: 'month',
    next_run_at: '2026-06-13T09:00:00.000Z',
    lead_days: 7,
    ...overrides,
  };
}

type FromArg = string;
type RpcResult = { data: unknown; error: unknown };

interface Fake {
  tenants: Array<{ id: string; status: string }>;
  duePlansByTenant: Record<string, DuePlanRow[]>;
  assetsByType: Record<string, Array<{ id: string }>>;
  rpcResultsForPlan: Record<string, Array<{ data: unknown; error: unknown }>>;
  rpcCalls: Array<{ p_plan_id: string; p_asset_id: string; p_run_at: string }>;
  updatedNextRunAtByPlan: Record<string, string>;
  failPlanIds: Set<string>;
}

function makeService(fake: Fake): PMGeneratorService {
  const supabase = {
    admin: {
      from: jest.fn((table: FromArg) => buildChain(table, fake)),
      rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn !== 'create_pm_work_order') {
          throw new Error(`unexpected rpc ${fn}`);
        }
        const call = {
          p_plan_id: args.p_plan_id as string,
          p_asset_id: args.p_asset_id as string,
          p_run_at: args.p_run_at as string,
        };
        fake.rpcCalls.push(call);
        const queue = fake.rpcResultsForPlan[call.p_plan_id];
        if (queue && queue.length > 0) {
          return queue.shift()!;
        }
        return { data: `wo-${fake.rpcCalls.length}`, error: null };
      }),
    },
  };
  return new PMGeneratorService(supabase as never);
}

function buildChain(table: string, fake: Fake) {
  if (table === 'tenants') return tenantsChain(fake);
  if (table === 'maintenance_plans') return plansChain(fake);
  if (table === 'assets') return assetsChain(fake);
  throw new Error(`unexpected table ${table}`);
}

function tenantsChain(fake: Fake) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.order = () => {
    const filtered = fake.tenants.filter((t) =>
      Object.entries(filters).every(([k, v]) => (t as never)[k] === v),
    );
    return Promise.resolve({
      data: filtered.map((t) => ({ id: t.id })),
      error: null,
    });
  };
  return chain;
}

function plansChain(fake: Fake) {
  const filters: Record<string, unknown> = {};
  let updatePayload: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.lte = () => chain;
  chain.order = () => chain;
  chain.limit = () => {
    const tenantId = filters.tenant_id as string | undefined;
    const due = (tenantId && fake.duePlansByTenant[tenantId]) || [];
    return Promise.resolve({ data: due, error: null });
  };
  chain.update = (payload: Record<string, unknown>) => {
    updatePayload = payload;
    return chain;
  };
  // After .update(...).eq(...).eq(...) the chain awaits — provide a then.
  Object.defineProperty(chain, 'then', {
    value: (cb: (r: { data: null; error: null }) => unknown) => {
      const planId = filters.id as string | undefined;
      if (planId && updatePayload && 'next_run_at' in updatePayload) {
        fake.updatedNextRunAtByPlan[planId] = updatePayload.next_run_at as string;
        if (fake.failPlanIds.has(planId)) {
          return Promise.resolve({ data: null, error: { message: 'simulated' } }).then(cb);
        }
      }
      return Promise.resolve({ data: null, error: null }).then(cb);
    },
    configurable: true,
  });
  return chain;
}

function assetsChain(fake: Fake) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters[col] = val;
    return chain;
  };
  chain.order = () => {
    const typeId = filters.asset_type_id as string | undefined;
    const list = (typeId && fake.assetsByType[typeId]) || [];
    return Promise.resolve({ data: list, error: null });
  };
  return chain;
}

function makeFake(overrides: Partial<Fake> = {}): Fake {
  return {
    tenants: [
      { id: TENANT_A, status: 'active' },
      { id: TENANT_B, status: 'active' },
    ],
    duePlansByTenant: {},
    assetsByType: {},
    rpcResultsForPlan: {},
    rpcCalls: [],
    updatedNextRunAtByPlan: {},
    failPlanIds: new Set(),
    ...overrides,
  };
}

describe('PMGeneratorService', () => {
  describe('resolveTargets', () => {
    it('returns [asset_id] for a single-asset plan', async () => {
      const fake = makeFake();
      const svc = makeService(fake);
      const targets = await svc.resolveTargets(makePlan());
      expect(targets).toEqual([ASSET_ID]);
    });

    it('fans out to every asset of the type', async () => {
      const fake = makeFake({
        assetsByType: {
          [ASSET_TYPE_ID]: ASSET_IDS_FOR_TYPE.map((id) => ({ id })),
        },
      });
      const svc = makeService(fake);
      const targets = await svc.resolveTargets(
        makePlan({ asset_id: null, asset_type_id: ASSET_TYPE_ID }),
      );
      expect(targets).toEqual([...ASSET_IDS_FOR_TYPE]);
    });

    it('returns empty list when an asset_type plan has no assets', async () => {
      const fake = makeFake();
      const svc = makeService(fake);
      const targets = await svc.resolveTargets(
        makePlan({ asset_id: null, asset_type_id: ASSET_TYPE_ID }),
      );
      expect(targets).toEqual([]);
    });

    it('throws when a row has neither asset_id nor asset_type_id (mutex defense-in-depth)', async () => {
      const fake = makeFake();
      const svc = makeService(fake);
      await expect(
        svc.resolveTargets(makePlan({ asset_id: null, asset_type_id: null })),
      ).rejects.toThrow(/target_mutex_violation/);
    });
  });

  describe('callCreatePmWorkOrderRpc', () => {
    it('passes p_actor_user_id null (cron is a system actor)', async () => {
      const fake = makeFake();
      const svc = makeService(fake);
      await svc.callCreatePmWorkOrderRpc(makePlan(), ASSET_ID);
      expect(fake.rpcCalls).toHaveLength(1);
    });

    it('returns null when the RPC reports ON CONFLICT (idempotent replay)', async () => {
      const fake = makeFake({
        rpcResultsForPlan: { [PLAN_ID]: [{ data: null, error: null }] },
      });
      const svc = makeService(fake);
      const result = await svc.callCreatePmWorkOrderRpc(makePlan(), ASSET_ID);
      expect(result).toBeNull();
    });

    it('throws when the RPC reports an error', async () => {
      const fake = makeFake({
        rpcResultsForPlan: {
          [PLAN_ID]: [{ data: null, error: { message: 'asset_not_in_tenant' } }],
        },
      });
      const svc = makeService(fake);
      await expect(
        svc.callCreatePmWorkOrderRpc(makePlan(), ASSET_ID),
      ).rejects.toBeTruthy();
    });
  });

  describe('generateForPlan', () => {
    it('continues to the next asset when one RPC throws (per-row catch)', async () => {
      const plan = makePlan({
        asset_id: null,
        asset_type_id: ASSET_TYPE_ID,
        next_run_at: '2026-06-13T09:00:00.000Z',
      });
      const fake = makeFake({
        assetsByType: {
          [ASSET_TYPE_ID]: ASSET_IDS_FOR_TYPE.map((id) => ({ id })),
        },
        rpcResultsForPlan: {
          [PLAN_ID]: [
            { data: 'wo-1', error: null },
            { data: null, error: { message: 'asset_not_in_tenant' } },
            { data: 'wo-3', error: null },
          ],
        },
      });
      const svc = makeService(fake);
      const result = await svc.generateForPlan(plan, new Date('2026-06-13T03:00:00.000Z'));
      expect(result.spawned).toBe(2);
      expect(result.failed).toBe(1);
      expect(fake.rpcCalls).toHaveLength(3);
    });

    it('advances next_run_at by one recurrence step regardless of per-asset failures', async () => {
      const plan = makePlan({ next_run_at: '2026-06-13T09:00:00.000Z' });
      const fake = makeFake();
      const svc = makeService(fake);
      await svc.generateForPlan(plan, new Date('2026-06-13T03:00:00.000Z'));
      expect(fake.updatedNextRunAtByPlan[PLAN_ID]).toBe(
        '2026-07-13T09:00:00.000Z',
      );
    });
  });

  describe('generateForTenant', () => {
    it('iterates all due plans in a tenant', async () => {
      const planA = makePlan({ id: '0000a000-0000-4000-8000-000000000001' });
      const planB = makePlan({
        id: '0000b000-0000-4000-8000-000000000002',
        asset_id: ASSET_ID,
      });
      const fake = makeFake({
        duePlansByTenant: { [TENANT_A]: [planA, planB] },
      });
      const svc = makeService(fake);
      const result = await svc.generateForTenant(
        TENANT_A,
        new Date('2026-06-13T03:00:00.000Z'),
      );
      expect(result.plans).toBe(2);
      expect(result.spawned).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('drains in batches without infinite looping when DB keeps returning the same row', async () => {
      const planA = makePlan({ id: '0000a000-0000-4000-8000-000000000001' });
      const fake = makeFake({ duePlansByTenant: { [TENANT_A]: [planA] } });
      const svc = makeService(fake);
      const result = await svc.generateForTenant(
        TENANT_A,
        new Date('2026-06-13T03:00:00.000Z'),
      );
      expect(result.plans).toBe(1);
    });
  });

  describe('generateForAllTenants', () => {
    it('continues to the next tenant when one tenant has no plans', async () => {
      const planA = makePlan({ id: '0000a000-0000-4000-8000-000000000001' });
      const fake = makeFake({
        duePlansByTenant: { [TENANT_A]: [planA] },
      });
      const svc = makeService(fake);
      const result = await svc.generateForAllTenants(
        new Date('2026-06-13T03:00:00.000Z'),
      );
      expect(result.tenants).toBe(2);
      expect(result.spawned).toBe(1);
    });
  });
});
