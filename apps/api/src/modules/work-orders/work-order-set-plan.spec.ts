// Tests for WorkOrderService.setPlan — the plandate edit path for child
// work orders post-1c.10c. The legacy `TicketService.setPlan` writes to the
// (now case-only) tickets table and is silently broken end-to-end since the
// Plan SidebarGroup only renders for `ticket_kind === 'work_order'`. These
// tests cover the replacement.
//
// Mock shape mirrors `work-order-sla-edit.spec.ts`: hand-rolled Supabase
// chain, dispatch on table name in `from()`. SYSTEM_ACTOR is used to skip
// the visibility/permission gates and keep the tests focused on the
// service's own logic (validation, no-op fast-path, update payload, activity
// emission).

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
  let row: WorkOrderRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'work_orders') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  // Both the load-by-id and the post-update refetch land
                  // here. Returns a fresh snapshot of `row` so the second
                  // read sees the merged state from `update()`.
                  maybeSingle: async () => ({ data: { ...row }, error: null }),
                  single: async () => ({ data: { ...row }, error: null }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              row = { ...row, ...(patch as Partial<WorkOrderRow>) };
              const second = {
                then: (
                  resolve: (v: { data: null; error: null }) => unknown,
                  reject: (e: unknown) => unknown,
                ) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
              };
              return { eq: () => ({ eq: () => second }) };
            },
          } as unknown;
        }
        if (table === 'users') {
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
        if (table === 'ticket_activities') {
          return {
            insert: async (a: Record<string, unknown>) => {
              activities.push(a);
              return { error: null };
            },
          } as unknown;
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      // setPlan never invokes user_has_permission — plandate has no
      // danger-permission gate (codex round 1's gate only applied to SLA).
      // The rpc surface is here so an accidental call would surface loudly.
      rpc: jest.fn(async (fn: string) => {
        throw new Error(`unexpected rpc in setPlan mock: ${fn}`);
      }),
    },
  };

  // SLA service isn't touched by setPlan; provide stubs so the constructor
  // is happy and any accidental call throws.
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
    updates,
    activities,
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

describe('WorkOrderService.setPlan', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('accepts plan + duration on a work_order and emits plan_changed activity', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: null,
      planned_duration_minutes: null,
    });
    const svc = makeSvc(deps);

    const startsAt = '2026-05-02T09:00:00.000Z';
    const result = await svc.setPlan('wo1', startsAt, 60, SYSTEM_ACTOR);

    expect(result.planned_start_at).toBe(startsAt);
    expect(result.planned_duration_minutes).toBe(60);
    // Update payload carries the plan fields + explicit updated_at (work_orders
    // has no auto-trigger for it post-1c.10c — codex round 1 finding ported
    // from updateSla).
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      planned_start_at: startsAt,
      planned_duration_minutes: 60,
    });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities).toHaveLength(1);
    expect(deps.activities[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'plan_changed',
        previous: { planned_start_at: null, planned_duration_minutes: null },
        next: { planned_start_at: startsAt, planned_duration_minutes: 60 },
      },
    });
  });

  it('accepts plannedStartAt = null (clear plan) and forces duration to null', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-02T09:00:00.000Z',
      planned_duration_minutes: 60,
    });
    const svc = makeSvc(deps);

    // Caller sends a positive duration alongside a null start; the service
    // must clear duration too (the matching legacy behavior — duration
    // without a start makes no sense).
    const result = await svc.setPlan('wo1', null, 90, SYSTEM_ACTOR);

    expect(result.planned_start_at).toBeNull();
    expect(result.planned_duration_minutes).toBeNull();
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      planned_start_at: null,
      planned_duration_minutes: null,
    });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities[0]).toMatchObject({
      metadata: {
        event: 'plan_changed',
        previous: {
          planned_start_at: '2026-05-02T09:00:00.000Z',
          planned_duration_minutes: 60,
        },
        next: { planned_start_at: null, planned_duration_minutes: null },
      },
    });
  });

  it('does NOT write or emit activity if both fields are unchanged', async () => {
    const startsAt = '2026-05-02T09:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 60,
    });
    const svc = makeSvc(deps);

    // Same values — fast-path: refetch the row but no UPDATE, no activity.
    const result = await svc.setPlan('wo1', startsAt, 60, SYSTEM_ACTOR);

    expect(result.planned_start_at).toBe(startsAt);
    expect(result.planned_duration_minutes).toBe(60);
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('throws BadRequestException on invalid timestamp / non-positive duration', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: null,
      planned_duration_minutes: null,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.setPlan('wo1', 'not-a-date', 60, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    await expect(
      svc.setPlan('wo1', '2026-05-02T09:00:00.000Z', 0, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    await expect(
      svc.setPlan('wo1', '2026-05-02T09:00:00.000Z', -5, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    await expect(
      svc.setPlan('wo1', '2026-05-02T09:00:00.000Z', 1.5, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    // Codex round 2: Number.isInteger(1e15) is true; without a cap a caller
    // could pass a value that overflows the int4 column. Service rejects.
    await expect(
      svc.setPlan('wo1', '2026-05-02T09:00:00.000Z', 60 * 24 * 365 + 1, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    // Confirm validation stopped before any side effects.
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  // Codex round 2 + full-review #5: cover the edge cases of the no-op
  // fast-path. The 'both equal' case is above; we also need to confirm
  // the fast-path does NOT trigger when only one field matches.

  it('writes when start matches but duration changes', async () => {
    const startsAt = '2026-05-02T09:00:00.000Z';
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: startsAt,
      planned_duration_minutes: 60,
    });
    const svc = makeSvc(deps);

    await svc.setPlan('wo1', startsAt, 90, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ planned_duration_minutes: 90 });
    expect(deps.activities).toHaveLength(1);
  });

  it('writes when duration matches but start changes', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      planned_start_at: '2026-05-02T09:00:00.000Z',
      planned_duration_minutes: 60,
    });
    const svc = makeSvc(deps);

    const newStart = '2026-05-03T10:00:00.000Z';
    await svc.setPlan('wo1', newStart, 60, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ planned_start_at: newStart });
    expect(deps.activities).toHaveLength(1);
  });

  // Codex round 2 NEW finding: the no-op fast-path used `===` on raw timestamp
  // strings. Postgres returns a different STRING form than the caller sent
  // for the same instant (e.g. caller `2026-05-04T13:00:00.000Z`, DB returns
  // `2026-05-04T13:00:00+00:00`). A naive `===` would mistakenly trigger a
  // write + spurious activity. The fix normalizes via Date.parse before
  // comparing — this test locks the fix in.
  it('treats timestamps with same instant but different string forms as equal (no-op)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      // DB-style string with `+00:00` offset
      planned_start_at: '2026-05-02T09:00:00+00:00',
      planned_duration_minutes: 60,
    });
    const svc = makeSvc(deps);

    // Caller sends the equivalent `Z`-suffixed form
    await svc.setPlan('wo1', '2026-05-02T09:00:00.000Z', 60, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });
});
