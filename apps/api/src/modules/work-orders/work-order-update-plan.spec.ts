// Tests for WorkOrderService.update — the plan branch's merge against the
// current row.
//
// Post-§3.0 cutover (Commit B): plan-branch merge lives in TS BEFORE the
// orchestrator RPC call (work-order.service.ts:265-319). The merge:
//   • Reads the current row when only one of the two plan keys is in the
//     dto (to preserve the absent one across the patch).
//   • Honours the "clear plan" gesture: explicit `start=null` with no
//     duration in the dto → `dtoNormalized.planned_duration_minutes = null`
//     so the §3.0 RPC commits the explicit clear (F-IMP-3 / 2026-05-11).
//   • Rejects with `work_order.plan_invalid` when the eventual row would be
//     duration-without-start (the §3.0 RPC's plan branch is partial-update
//     friendly and does NOT enforce this — TS is the gate).
//
// Contract (one `it` per row) — assert the `p_patches.plan` shape on the
// `update_entity_combined` call:
//   { dur: 90 }                 | start='X', dur=30  → plan={ planned_duration_minutes: 90 }
//   { start: 'Y' }              | start='X', dur=30  → plan={ planned_start_at: 'Y' }
//   { start: null }             | start='X', dur=30  → plan={ planned_start_at: null,
//                                                              planned_duration_minutes: null }
//   { dur: 90 }                 | start=null, dur=null → 400 plan_invalid (no RPC)
//   { start: null, dur: 90 }    | any                  → 400 plan_invalid (no RPC)

import { AppError } from '../../common/errors';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
};

const TENANT = 't1';
const CRI = 'cri-plan-test';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function makeDeps(initial: WorkOrderRow) {
  const row: WorkOrderRow = { ...initial };
  const rpcCalls: RpcCall[] = [];

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
      rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'update_entity_combined') {
          return { data: null, error: null };
        }
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
    buildTimersForRpc: jest.fn().mockResolvedValue([]),
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1',
      person_id: 'p1',
      tenant_id: TENANT,
      team_ids: [],
      role_assignments: [],
      vendor_id: null,
      has_read_all: false,
      has_write_all: true,
    }),
    assertCanPlan: jest.fn().mockResolvedValue(undefined),
  };

  return {
    row: () => row,
    rpcCalls,
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

/** Convenience: pluck `update_entity_combined` calls only. */
function combinedCalls(
  rpcCalls: RpcCall[],
): Array<Record<string, unknown>> {
  return rpcCalls
    .filter((c) => c.fn === 'update_entity_combined')
    .map((c) => c.args);
}

describe('WorkOrderService.update — plan-branch merge against current row', () => {
  beforeEach(() => {
    jest
      .spyOn(
        require('../../common/tenant-context').TenantContext,
        'current',
      )
      .mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('duration-only patch preserves existing start (plan branch carries only the duration key)', async () => {
    const startsAt = '2026-05-02T09:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    await svc.update(
      'wo1',
      { planned_duration_minutes: 90 },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(deps.rpcCalls);
    expect(combined).toHaveLength(1);
    // Only the duration key was in the dto — the RPC's plan branch
    // (00333:397-503) is partial-update friendly, so only that key is
    // sent. The existing start is preserved by absence (NOT by being
    // re-sent as start='X'). This is the F-IMP-3 contract: don't echo
    // values the caller didn't touch.
    expect(combined[0].p_patches).toMatchObject({
      plan: { planned_duration_minutes: 90 },
    });
    expect(
      (combined[0].p_patches as { plan: Record<string, unknown> }).plan
        .planned_start_at,
    ).toBeUndefined();
  });

  it('start-only patch preserves existing duration (plan branch carries only the start key)', async () => {
    const startsAt = '2026-05-02T09:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    const newStart = '2026-05-03T10:00:00.000Z';
    await svc.update(
      'wo1',
      { planned_start_at: newStart },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(deps.rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      plan: { planned_start_at: newStart },
    });
    expect(
      (combined[0].p_patches as { plan: Record<string, unknown> }).plan
        .planned_duration_minutes,
    ).toBeUndefined();
  });

  it('explicit start=null patch clears both fields (clear-plan gesture / F-IMP-3)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-02T09:00:00.000Z',
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    // Caller sends only `planned_start_at: null`. The orchestrator merge
    // (work-order.service.ts:295-309) writes the explicit-null clear onto
    // the dtoNormalized clone for duration too, so the RPC commits both
    // columns to null.
    await svc.update(
      'wo1',
      { planned_start_at: null },
      SYSTEM_ACTOR,
      CRI,
    );

    const combined = combinedCalls(deps.rpcCalls);
    expect(combined).toHaveLength(1);
    expect(combined[0].p_patches).toMatchObject({
      plan: {
        planned_start_at: null,
        planned_duration_minutes: null,
      },
    });
  });

  it('rejects duration-only patch when existing start is null (400 work_order.plan_invalid, no RPC)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: null,
      planned_duration_minutes: null,
    });
    const svc = makeSvc(deps);

    let caught: unknown = null;
    try {
      await svc.update(
        'wo1',
        { planned_duration_minutes: 90 },
        SYSTEM_ACTOR,
        CRI,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('work_order.plan_invalid');
    expect((caught as AppError).status).toBe(400);
    expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
  });

  it('rejects { start: null, duration: N } in one patch (400 work_order.plan_invalid, no RPC)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-02T09:00:00.000Z',
      planned_duration_minutes: 30,
    });
    const svc = makeSvc(deps);

    let caught: unknown = null;
    try {
      await svc.update(
        'wo1',
        { planned_start_at: null, planned_duration_minutes: 90 },
        SYSTEM_ACTOR,
        CRI,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('work_order.plan_invalid');
    expect((caught as AppError).status).toBe(400);
    expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
  });
});
