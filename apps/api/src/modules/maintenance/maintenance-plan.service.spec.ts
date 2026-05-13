import { TenantContext } from '../../common/tenant-context';
import { AppError } from '../../common/errors';
import {
  MaintenancePlanService,
  type MaintenancePlanRow,
} from './maintenance-plan.service';

const TENANT = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_TYPE_ID = '44444444-4444-4444-8444-444444444444';
const AUTH_UID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';

function makeRow(overrides: Partial<MaintenancePlanRow> = {}): MaintenancePlanRow {
  return {
    id: PLAN_ID,
    tenant_id: TENANT,
    name: 'HVAC monthly check',
    description: null,
    active: true,
    asset_id: ASSET_ID,
    asset_type_id: null,
    request_type_id: REQUEST_TYPE_ID,
    location_id: null,
    title_template: 'PM check for {{asset.name}}',
    description_template: null,
    priority: 'medium',
    planned_duration_minutes: 60,
    recurrence_interval: 1,
    recurrence_unit: 'month',
    anchor_date: '2026-05-13',
    lead_days: 7,
    next_run_at: '2026-06-13T09:00:00.000Z',
    last_completed_at: null,
    last_generated_at: null,
    created_at: '2026-05-13T09:00:00.000Z',
    updated_at: '2026-05-13T09:00:00.000Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

type RpcResult = { data: unknown; error: unknown };

interface FakeState {
  row: MaintenancePlanRow;
  workOrderCount: number;
  userIdForAuth: string | null;
  hardDeleteFails?: boolean;
  insertCaptured: Array<Record<string, unknown>>;
  updateCaptured: Array<Record<string, unknown>>;
  deleted: boolean;
  rowNotFound?: boolean;
}

function makeService(state: FakeState): MaintenancePlanService {
  const supabase = {
    admin: {
      from: jest.fn((table: string) => buildChain(table, state)),
      rpc: jest.fn(async (): Promise<RpcResult> => ({ data: null, error: null })),
    },
  };
  return new MaintenancePlanService(supabase as never);
}

function buildChain(table: string, state: FakeState) {
  if (table === 'maintenance_plans') return planChain(state);
  if (table === 'work_orders') return workOrderChain(state);
  if (table === 'users') return userChain(state);
  throw new Error(`unexpected table ${table}`);
}

function planChain(state: FakeState) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.range = async () => ({ data: [state.row], error: null, count: 1 });
  chain.maybeSingle = async () => ({
    data: state.rowNotFound ? null : state.row,
    error: null,
  });
  chain.single = async () => ({ data: state.row, error: null });
  chain.insert = (row: Record<string, unknown>) => {
    state.insertCaptured.push(row);
    return chain;
  };
  chain.update = (row: Record<string, unknown>) => {
    state.updateCaptured.push(row);
    Object.assign(state.row, row);
    return chain;
  };
  chain.delete = () => {
    state.deleted = true;
    return {
      eq: () => ({
        eq: async () => ({
          data: null,
          error: state.hardDeleteFails ? { message: 'simulated' } : null,
        }),
      }),
    };
  };
  return chain;
}

function workOrderChain(state: FakeState) {
  const chain: Record<string, unknown> = {};
  chain.select = (_cols: string, opts?: { head?: boolean }) => {
    void opts;
    return chain;
  };
  chain.eq = (_col: string, _val: unknown) => {
    void _col;
    void _val;
    return Promise.resolve({
      data: null,
      error: null,
      count: state.workOrderCount,
    }).then ? thenableChain(chain, state.workOrderCount) : chain;
  };
  return chain;
}

function thenableChain(chain: Record<string, unknown>, count: number) {
  const wrapper: Record<string, unknown> = {
    ...chain,
    then: (cb: (r: { data: unknown; error: null; count: number }) => unknown) =>
      Promise.resolve({ data: null, error: null, count }).then(cb),
  };
  wrapper.eq = (_col: string, _val: unknown) => {
    void _col;
    void _val;
    return wrapper;
  };
  return wrapper;
}

function userChain(state: FakeState) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({
    data: state.userIdForAuth ? { id: state.userIdForAuth } : null,
    error: null,
  });
  return chain;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    row: makeRow(),
    workOrderCount: 0,
    userIdForAuth: USER_ID,
    insertCaptured: [],
    updateCaptured: [],
    deleted: false,
    ...overrides,
  };
}

const TENANT_INFO = {
  id: TENANT,
  slug: 'tenant-a',
  tier: 'standard' as const,
};

function runInTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run(TENANT_INFO, fn);
}

describe('MaintenancePlanService', () => {
  describe('create', () => {
    it('rejects when both asset_id and asset_type_id supplied (target mutex)', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.create(
            {
              name: 'bad',
              asset_id: ASSET_ID,
              asset_type_id: ASSET_TYPE_ID,
              request_type_id: REQUEST_TYPE_ID,
              title_template: 't',
              recurrence_interval: 1,
              recurrence_unit: 'month',
              anchor_date: '2026-05-13',
            },
            { authUid: AUTH_UID },
          ),
        ).rejects.toMatchObject({
          code: 'maintenance_plans.target_mutex_violation',
        });
      });
    });

    it('rejects when neither asset_id nor asset_type_id supplied', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.create(
            {
              name: 'bad',
              request_type_id: REQUEST_TYPE_ID,
              title_template: 't',
              recurrence_interval: 1,
              recurrence_unit: 'month',
              anchor_date: '2026-05-13',
            },
            { authUid: AUTH_UID },
          ),
        ).rejects.toBeInstanceOf(AppError);
      });
    });

    it('rejects invalid recurrence_interval via Zod', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.create(
            {
              name: 'bad',
              asset_id: ASSET_ID,
              request_type_id: REQUEST_TYPE_ID,
              title_template: 't',
              recurrence_interval: 0,
              recurrence_unit: 'month',
              anchor_date: '2026-05-13',
            },
            { authUid: AUTH_UID },
          ),
        ).rejects.toMatchObject({ code: 'validation.failed' });
      });
    });

    it('rejects invalid recurrence_unit via Zod', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.create(
            {
              name: 'bad',
              asset_id: ASSET_ID,
              request_type_id: REQUEST_TYPE_ID,
              title_template: 't',
              recurrence_interval: 1,
              recurrence_unit: 'fortnight' as unknown as 'month',
              anchor_date: '2026-05-13',
            },
            { authUid: AUTH_UID },
          ),
        ).rejects.toMatchObject({ code: 'validation.failed' });
      });
    });

    it('inserts a single-asset plan with derived next_run_at + actor stamping', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(() =>
        svc.create(
          {
            name: 'monthly hvac',
            asset_id: ASSET_ID,
            request_type_id: REQUEST_TYPE_ID,
            title_template: 'HVAC {{asset.name}}',
            recurrence_interval: 1,
            recurrence_unit: 'month',
            anchor_date: '2026-06-01',
          },
          { authUid: AUTH_UID },
        ),
      );
      expect(state.insertCaptured).toHaveLength(1);
      const captured = state.insertCaptured[0]!;
      expect(captured.tenant_id).toBe(TENANT);
      expect(captured.asset_id).toBe(ASSET_ID);
      expect(captured.asset_type_id).toBeNull();
      expect(captured.created_by).toBe(USER_ID);
      expect(captured.updated_by).toBe(USER_ID);
      expect(captured.next_run_at).toBe('2026-06-01T09:00:00.000Z');
      expect(captured.lead_days).toBe(7);
      expect(captured.priority).toBe('medium');
      expect(captured.planned_duration_minutes).toBe(60);
    });

    it('leaves created_by null when the auth user has no linked users row', async () => {
      const state = makeState({ userIdForAuth: null });
      const svc = makeService(state);
      await runInTenant(() =>
        svc.create(
          {
            name: 'no-actor',
            asset_id: ASSET_ID,
            request_type_id: REQUEST_TYPE_ID,
            title_template: 't',
            recurrence_interval: 1,
            recurrence_unit: 'day',
            anchor_date: '2026-06-01',
          },
          { authUid: AUTH_UID },
        ),
      );
      const captured = state.insertCaptured[0]!;
      expect(captured.created_by).toBeNull();
      expect(captured.updated_by).toBeNull();
    });
  });

  describe('update', () => {
    it('preserves next_run_at when recurrence is unchanged', async () => {
      const state = makeState();
      const svc = makeService(state);
      const originalNextRun = state.row.next_run_at;
      await runInTenant(() =>
        svc.update(PLAN_ID, { name: 'renamed' }, { authUid: AUTH_UID }),
      );
      expect(state.updateCaptured).toHaveLength(1);
      const captured = state.updateCaptured[0]!;
      expect(captured.name).toBe('renamed');
      expect(captured.next_run_at).toBeUndefined();
      expect(state.row.next_run_at).toBe(originalNextRun);
    });

    it('recomputes next_run_at when recurrence_interval changes', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(() =>
        svc.update(PLAN_ID, { recurrence_interval: 2 }, { authUid: AUTH_UID }),
      );
      const captured = state.updateCaptured[0]!;
      expect(captured.recurrence_interval).toBe(2);
      expect(typeof captured.next_run_at).toBe('string');
      expect(new Date(captured.next_run_at as string).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it('recomputes next_run_at when anchor_date changes', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(() =>
        svc.update(
          PLAN_ID,
          { anchor_date: '2027-01-01' },
          { authUid: AUTH_UID },
        ),
      );
      const captured = state.updateCaptured[0]!;
      expect(captured.anchor_date).toBe('2027-01-01');
      expect(captured.next_run_at).toBe('2027-01-01T09:00:00.000Z');
    });

    it('rejects target-mutex violation on update (flipping to asset_type without clearing asset_id)', async () => {
      const state = makeState({ row: makeRow({ asset_id: ASSET_ID }) });
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.update(
            PLAN_ID,
            { asset_type_id: ASSET_TYPE_ID },
            { authUid: AUTH_UID },
          ),
        ).rejects.toMatchObject({
          code: 'maintenance_plans.target_mutex_violation',
        });
      });
    });

    it('rejects empty update body via Zod refine', async () => {
      const state = makeState();
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.update(PLAN_ID, {}, { authUid: AUTH_UID }),
        ).rejects.toMatchObject({ code: 'validation.failed' });
      });
    });

    it('throws not_found when the plan is missing', async () => {
      const state = makeState({ rowNotFound: true });
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(
          svc.update(PLAN_ID, { name: 'x' }, { authUid: AUTH_UID }),
        ).rejects.toMatchObject({ code: 'maintenance_plans.not_found' });
      });
    });
  });

  describe('delete', () => {
    it('soft-deletes when work orders reference the plan', async () => {
      const state = makeState({ workOrderCount: 4 });
      const svc = makeService(state);
      const result = await runInTenant(() => svc.delete(PLAN_ID));
      expect(result.mode).toBe('soft');
      expect(state.updateCaptured).toContainEqual(
        expect.objectContaining({ active: false }),
      );
      expect(state.deleted).toBe(false);
    });

    it('hard-deletes when no work orders reference the plan', async () => {
      const state = makeState({ workOrderCount: 0 });
      const svc = makeService(state);
      const result = await runInTenant(() => svc.delete(PLAN_ID));
      expect(result.mode).toBe('hard');
      expect(state.deleted).toBe(true);
    });

    it('throws not_found when the plan is missing', async () => {
      const state = makeState({ rowNotFound: true });
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(svc.delete(PLAN_ID)).rejects.toMatchObject({
          code: 'maintenance_plans.not_found',
        });
      });
    });
  });

  describe('findById / list', () => {
    it('list filters tenant_id and returns rows', async () => {
      const state = makeState();
      const svc = makeService(state);
      const result = await runInTenant(() => svc.list({ active: 'true' }));
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.tenant_id).toBe(TENANT);
    });

    it('findById raises maintenance_plans.not_found for missing rows', async () => {
      const state = makeState({ rowNotFound: true });
      const svc = makeService(state);
      await runInTenant(async () => {
        await expect(svc.findById(PLAN_ID)).rejects.toMatchObject({
          code: 'maintenance_plans.not_found',
        });
      });
    });
  });
});
