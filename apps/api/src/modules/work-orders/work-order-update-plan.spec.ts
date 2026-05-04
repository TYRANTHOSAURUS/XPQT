// Tests for WorkOrderService.update — the plan branch's merge logic against
// the current row.
//
// Bug being locked in: when the dto only contains `planned_duration_minutes`,
// the orchestrator was passing `last?.planned_start_at ?? null` to setPlan,
// which silently cleared the existing start (and, by setPlan's "duration
// without a start makes no sense" invariant, the duration too). The fix is
// to read the current row at the head of the plan branch when `last` is
// null, then merge per `presentInDto ? dto.value : current.value`.
//
// Mock pattern mirrors `work-order-set-plan.spec.ts` for the supabase chain
// shape, but the plan branch is exercised through `update()` and we mock
// `setPlan` itself so the assertion is on what the merge logic decided.
//
// Contract (one `it` per row):
//   { dur: 90 }                 | start='X', dur=30  → setPlan('X', 90)
//   { start: 'Y' }              | start='X', dur=30  → setPlan('Y', 30)
//   { start: null }             | start='X', dur=30  → setPlan(null, null)
//                                                        (existing setPlan
//                                                        invariant: clearing
//                                                        start clears dur)
//   { dur: 90 }                 | start=null, dur=null → 400 plan_invalid
//   { start: null, dur: 90 }    | any                  → 400 plan_invalid

import { BadRequestException } from '@nestjs/common';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
};

const TENANT = 't1';

function makeDeps(initial: WorkOrderRow) {
  const row: WorkOrderRow = { ...initial };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'work_orders') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  // Both the merge-time current-row read and any post-write
                  // refetch land here. Returns a snapshot of `row`.
                  maybeSingle: async () => ({ data: { ...row }, error: null }),
                  single: async () => ({ data: { ...row }, error: null }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'sla_policies') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          } as unknown;
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      rpc: jest.fn(async (fn: string) => {
        throw new Error(`unexpected rpc in update plan-branch mock: ${fn}`);
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
    completeTimers: jest.fn().mockResolvedValue(undefined),
    startTimers: jest.fn().mockResolvedValue(undefined),
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: true,
    }),
    assertCanPlan: jest.fn().mockResolvedValue(undefined),
  };

  return {
    row: () => row,
    supabase,
    slaService,
    visibility,
  };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new WorkOrderService(
    deps.supabase as never,
    deps.slaService as never,
    deps.visibility as never,
  );
}

describe('WorkOrderService.update — plan-branch merge against current row', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('duration-only patch preserves existing start', async () => {
    const startsAt = '2026-05-02T09:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    // Mock setPlan so we assert on the merge logic's decision, not its side
    // effects. Returning the resulting row as if setPlan had committed.
    const setPlanSpy = jest
      .spyOn(svc, 'setPlan')
      .mockImplementation(async (_id, start, dur) => ({
        id: 'wo1',
        tenant_id: TENANT,
        sla_id: null,
        planned_start_at: start,
        planned_duration_minutes: dur,
      }));

    const result = await svc.update(
      'wo1',
      { planned_duration_minutes: 90 },
      SYSTEM_ACTOR,
    );

    expect(setPlanSpy).toHaveBeenCalledTimes(1);
    expect(setPlanSpy).toHaveBeenCalledWith('wo1', startsAt, 90, SYSTEM_ACTOR);
    expect(result.planned_start_at).toBe(startsAt);
    expect(result.planned_duration_minutes).toBe(90);
  });

  it('start-only patch preserves existing duration', async () => {
    const startsAt = '2026-05-02T09:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    const setPlanSpy = jest
      .spyOn(svc, 'setPlan')
      .mockImplementation(async (_id, start, dur) => ({
        id: 'wo1',
        tenant_id: TENANT,
        sla_id: null,
        planned_start_at: start,
        planned_duration_minutes: dur,
      }));

    const newStart = '2026-05-03T10:00:00.000Z';
    const result = await svc.update(
      'wo1',
      { planned_start_at: newStart },
      SYSTEM_ACTOR,
    );

    expect(setPlanSpy).toHaveBeenCalledTimes(1);
    expect(setPlanSpy).toHaveBeenCalledWith('wo1', newStart, 30, SYSTEM_ACTOR);
    expect(result.planned_start_at).toBe(newStart);
    expect(result.planned_duration_minutes).toBe(30);
  });

  it('explicit start=null patch clears both fields (setPlan invariant)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-02T09:00:00.000Z',
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    const setPlanSpy = jest
      .spyOn(svc, 'setPlan')
      .mockImplementation(async () => ({
        id: 'wo1',
        tenant_id: TENANT,
        sla_id: null,
        planned_start_at: null,
        planned_duration_minutes: null,
      }));

    // Caller sends only `planned_start_at: null`. The "clear start" gesture
    // is the established "clear plan" gesture — setPlan's invariant would
    // collapse duration to null anyway, but the orchestrator merge has to
    // honour it explicitly because the validation below otherwise 400s
    // when finalDuration carries the old non-null value forward. Net: the
    // merge passes (null, null) to setPlan, and the row clears.
    const result = await svc.update(
      'wo1',
      { planned_start_at: null },
      SYSTEM_ACTOR,
    );

    expect(setPlanSpy).toHaveBeenCalledTimes(1);
    expect(setPlanSpy).toHaveBeenCalledWith('wo1', null, null, SYSTEM_ACTOR);
    expect(result.planned_start_at).toBeNull();
    expect(result.planned_duration_minutes).toBeNull();
  });

  it('rejects duration-only patch when existing start is null (400 work_order.plan_invalid)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: null,
      planned_duration_minutes: null,
    });
    const svc = makeSvc(deps);
    const setPlanSpy = jest.spyOn(svc, 'setPlan');

    let caught: unknown = null;
    try {
      await svc.update(
        'wo1',
        { planned_duration_minutes: 90 },
        SYSTEM_ACTOR,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const response = (caught as BadRequestException).getResponse() as {
      code?: string;
    };
    expect(response.code).toBe('work_order.plan_invalid');
    expect(setPlanSpy).not.toHaveBeenCalled();
  });

  it('rejects { start: null, duration: N } in one patch (400 work_order.plan_invalid)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-02T09:00:00.000Z',
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);
    const setPlanSpy = jest.spyOn(svc, 'setPlan');

    let caught: unknown = null;
    try {
      await svc.update(
        'wo1',
        { planned_start_at: null, planned_duration_minutes: 90 },
        SYSTEM_ACTOR,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    const response = (caught as BadRequestException).getResponse() as {
      code?: string;
    };
    expect(response.code).toBe('work_order.plan_invalid');
    expect(setPlanSpy).not.toHaveBeenCalled();
  });
});
