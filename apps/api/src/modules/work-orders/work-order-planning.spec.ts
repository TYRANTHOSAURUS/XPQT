// Tests for WorkOrderPlanningService — the read path that powers
// /desk/planning. Validation is the highest-value unit-test surface;
// deeper integration (visibility, can_plan derivation, DST math) is
// exercised by the smoke gate against a real DB.

import { WorkOrderPlanningService, type PlanningFilters } from './work-order-planning.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';

function makeSvc() {
  const supabase = {
    admin: {
      from: jest.fn(),
      rpc: jest.fn(),
    },
  };
  const visibility = {
    loadContext: jest.fn(),
  };
  return {
    svc: new WorkOrderPlanningService(supabase as never, visibility as never),
    supabase,
    visibility,
  };
}

function runInTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, slug: 't1', tier: 'standard' }, fn);
}

const validFilters: PlanningFilters = {
  from: '2026-05-12T07:00:00.000Z',
  to: '2026-05-13T07:00:00.000Z',
};

describe('WorkOrderPlanningService — validation', () => {
  it('rejects missing from', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() => svc.getWindow({ ...validFilters, from: '' }, 'auth-uid')),
    ).rejects.toThrow(/from is required/i);
  });

  it('rejects missing to', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() => svc.getWindow({ ...validFilters, to: '' }, 'auth-uid')),
    ).rejects.toThrow(/to is required/i);
  });

  it('rejects unparseable from', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() => svc.getWindow({ ...validFilters, from: 'not a date' }, 'auth-uid')),
    ).rejects.toThrow(/ISO 8601/i);
  });

  it('rejects from >= to', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() =>
        svc.getWindow(
          { from: '2026-05-13T07:00:00.000Z', to: '2026-05-13T07:00:00.000Z' },
          'auth-uid',
        ),
      ),
    ).rejects.toThrow(/strictly before/);
  });

  it('rejects window > 14 days', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() =>
        svc.getWindow(
          { from: '2026-05-01T00:00:00.000Z', to: '2026-05-20T00:00:00.000Z' },
          'auth-uid',
        ),
      ),
    ).rejects.toThrow(/14 days/);
  });

  it('rejects unknown status_category', async () => {
    const { svc } = makeSvc();
    await expect(
      runInTenant(() =>
        svc.getWindow({ ...validFilters, status: ['bogus'] }, 'auth-uid'),
      ),
    ).rejects.toThrow(/unknown status_category/);
  });

  it('returns an empty response when the actor is unknown in the tenant', async () => {
    const { svc, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue({
      user_id: '', // empty user_id = unknown user
      person_id: null,
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: false,
    });

    const result = await runInTenant(() => svc.getWindow(validFilters, 'auth-uid'));
    expect(result).toEqual({ planned: [], unscheduled: [] });
  });

  it('accepts a 14-day window exactly', async () => {
    const { svc, visibility } = makeSvc();
    visibility.loadContext.mockResolvedValue({
      user_id: '',
      person_id: null,
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: false,
    });
    // 14-day boundary: passes validation; empty-actor short-circuit returns {planned:[],unscheduled:[]}.
    const result = await runInTenant(() =>
      svc.getWindow(
        { from: '2026-05-01T00:00:00.000Z', to: '2026-05-15T00:00:00.000Z' },
        'auth-uid',
      ),
    );
    expect(result.planned).toEqual([]);
    expect(result.unscheduled).toEqual([]);
  });
});
