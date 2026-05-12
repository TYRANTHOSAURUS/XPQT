// Tests for WorkOrderService.update — optimistic-lock check on plan_version.
//
// P1-2 (handoff §3 + migration 00382): when the dto includes
// `plan_version` AND any of the five trigger-tracked columns is in the
// patch (planned_start_at, planned_duration_minutes, assigned_team_id /
// _user_id / _vendor_id), the service reads the row's current
// plan_version and rejects with 409 `planning.version_conflict` on
// mismatch. The conflict body carries `serverVersion` (current_version)
// + `clientVersion` (what the caller passed) per AppErrors.conflict.
//
// What this spec asserts:
//   1. Stale plan_version + plan-touching patch → AppError code
//      `planning.version_conflict` + status 409 + serverVersion +
//      clientVersion populated. RPC not called.
//   2. Matching plan_version + plan-touching patch → RPC fires; no
//      conflict thrown.
//   3. Stale plan_version + assignment-only patch → 409 (trigger fires
//      on assignment columns too).
//   4. plan_version supplied + non-trigger-column patch (status only) →
//      check is skipped (status flip shouldn't conflict on a stale
//      plan_version a caller didn't intend to touch).
//   5. plan_version NOT supplied + plan patch → no check, RPC fires
//      (back-compat: detail-page edits don't pay the round-trip).

import { AppError } from '../../common/errors';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  planned_start_at: string | null;
  planned_duration_minutes: number | null;
  plan_version: number;
};

const TENANT = 't1';
const CRI = 'cri-version-test';

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
        if (table === 'teams' || table === 'users' || table === 'vendors') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: 'mocked' }, error: null }),
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
        if (fn === 'user_has_permission') {
          return { data: true, error: null };
        }
        throw new Error(`unexpected rpc in version-test mock: ${fn}`);
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn(),
    pauseTimers: jest.fn(),
    resumeTimers: jest.fn(),
    completeTimers: jest.fn(),
    startTimers: jest.fn(),
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

function combinedCalls(rpcCalls: RpcCall[]): Array<Record<string, unknown>> {
  return rpcCalls
    .filter((c) => c.fn === 'update_entity_combined')
    .map((c) => c.args);
}

describe('WorkOrderService.update — plan_version optimistic-lock', () => {
  beforeEach(() => {
    jest
      .spyOn(
        require('../../common/tenant-context').TenantContext,
        'current',
      )
      .mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stale plan_version + plan patch → 409 planning.version_conflict; RPC not called', async () => {
    const startsAt = '2026-05-12T10:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 60,
      plan_version: 5,
    });
    const svc = makeSvc(deps);

    let caught: AppError | null = null;
    try {
      await svc.update(
        'wo1',
        {
          planned_start_at: '2026-05-13T10:00:00.000Z',
          plan_version: 3,
        },
        SYSTEM_ACTOR,
        CRI,
      );
    } catch (err) {
      caught = err as AppError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('planning.version_conflict');
    expect(caught?.status).toBe(409);
    expect(caught?.serverVersion).toBe('5');
    expect(caught?.clientVersion).toBe('3');
    expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
  });

  it('matching plan_version + plan patch → RPC fires; no conflict', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-12T10:00:00.000Z',
      planned_duration_minutes: 60,
      plan_version: 5,
    });
    const svc = makeSvc(deps);

    await svc.update(
      'wo1',
      {
        planned_start_at: '2026-05-13T10:00:00.000Z',
        plan_version: 5,
      },
      SYSTEM_ACTOR,
      CRI,
    );

    expect(combinedCalls(deps.rpcCalls)).toHaveLength(1);
  });

  it('stale plan_version + assignment patch → 409 (trigger fires on assignment too)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: null,
      planned_duration_minutes: null,
      plan_version: 7,
    });
    const svc = makeSvc(deps);

    let caught: AppError | null = null;
    try {
      await svc.update(
        'wo1',
        {
          assigned_user_id: '00000000-0000-0000-0000-000000000001',
          plan_version: 6,
        },
        SYSTEM_ACTOR,
        CRI,
      );
    } catch (err) {
      caught = err as AppError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('planning.version_conflict');
    expect(caught?.serverVersion).toBe('7');
    expect(combinedCalls(deps.rpcCalls)).toHaveLength(0);
  });

  it('plan_version supplied + status-only patch (no trigger column) → check skipped, RPC fires', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: null,
      planned_duration_minutes: null,
      plan_version: 7,
    });
    const svc = makeSvc(deps);

    // Stale plan_version is irrelevant — status doesn't touch the trigger
    // columns, so the lock check doesn't fire. This is the back-compat
    // guarantee: detail-page status flips never see version conflicts.
    await svc.update(
      'wo1',
      {
        status: 'in_progress',
        status_category: 'in_progress',
        plan_version: 1,
      },
      SYSTEM_ACTOR,
      CRI,
    );

    expect(combinedCalls(deps.rpcCalls)).toHaveLength(1);
  });

  it('plan_version omitted + plan patch → no check, RPC fires (back-compat)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-12T10:00:00.000Z',
      planned_duration_minutes: 60,
      plan_version: 5,
    });
    const svc = makeSvc(deps);

    await svc.update(
      'wo1',
      { planned_start_at: '2026-05-13T10:00:00.000Z' },
      SYSTEM_ACTOR,
      CRI,
    );

    expect(combinedCalls(deps.rpcCalls)).toHaveLength(1);
  });

  it('plan_version match + plan patch forwards p_expected_plan_version to RPC (00384)', async () => {
    // Codex remediation: the authoritative compare lives inside the RPC
    // under SELECT FOR UPDATE. The TS pre-check stays as a fast-fail but
    // the load-bearing gate is the RPC. Assert the new arg is plumbed
    // through.
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-12T10:00:00.000Z',
      planned_duration_minutes: 60,
      plan_version: 5,
    });
    const svc = makeSvc(deps);

    await svc.update(
      'wo1',
      {
        planned_start_at: '2026-05-13T10:00:00.000Z',
        plan_version: 5,
      },
      SYSTEM_ACTOR,
      CRI,
    );

    const calls = combinedCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].p_expected_plan_version).toBe(5);
  });

  it('plan_version omitted + plan patch sends p_expected_plan_version=null (00384)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-12T10:00:00.000Z',
      planned_duration_minutes: 60,
      plan_version: 5,
    });
    const svc = makeSvc(deps);

    await svc.update(
      'wo1',
      { planned_start_at: '2026-05-13T10:00:00.000Z' },
      SYSTEM_ACTOR,
      CRI,
    );

    const calls = combinedCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].p_expected_plan_version).toBeNull();
  });
});
