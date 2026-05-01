// Tests for WorkOrderService.updateStatus — the status / status_category /
// waiting_reason edit path for child work_orders post-1c.10c. Mock pattern
// mirrors `work-order-set-plan.spec.ts` and `work-order-sla-edit.spec.ts`:
// hand-rolled Supabase chain, dispatch on table name in `from()`. SYSTEM_ACTOR
// is used to skip the visibility/permission gates for success-path tests.

import { BadRequestException } from '@nestjs/common';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  sla_id: string | null;
  status: string;
  status_category: string;
  waiting_reason: string | null;
  resolved_at: string | null;
  closed_at: string | null;
};

const TENANT = 't1';

function makeDeps(initial: WorkOrderRow) {
  let row: WorkOrderRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const domainEvents: Array<Record<string, unknown>> = [];

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
        if (table === 'domain_events') {
          return {
            insert: async (e: Record<string, unknown>) => {
              domainEvents.push(e);
              return { error: null };
            },
          } as unknown;
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      rpc: jest.fn(async (fn: string) => {
        throw new Error(`unexpected rpc in mock: ${fn}`);
      }),
    },
  };

  // Code-review C3: stub `applyWaitingStateTransition` rather than reimplement
  // the SlaService body inside the test. The previous mock duplicated the
  // real method's logic, which meant changes to the real SlaService (e.g.
  // C1's tenant-scoped sla_policies lookup) could leave these tests green
  // while production diverged. Behavior tests for the helper now live in
  // sla.service.spec.ts; here we only verify that WorkOrderService.updateStatus
  // forwards the right args to the helper.
  const slaService: {
    restartTimers: jest.Mock;
    pauseTimers: jest.Mock;
    resumeTimers: jest.Mock;
    completeTimers: jest.Mock;
    startTimers: jest.Mock;
    applyWaitingStateTransition: jest.Mock;
  } = {
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
    completeTimers: jest.fn().mockResolvedValue(undefined),
    startTimers: jest.fn().mockResolvedValue(undefined),
    applyWaitingStateTransition: jest.fn().mockResolvedValue(undefined),
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: true,
    }),
    assertCanPlan: jest.fn().mockResolvedValue(undefined),
  };

  return { row: () => row, updates, activities, domainEvents, supabase, slaService, visibility };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new WorkOrderService(
    deps.supabase as never,
    deps.slaService as never,
    deps.visibility as never,
  );
}

describe('WorkOrderService.updateStatus', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('accepts a status_category transition (assigned → in_progress) and emits status_changed activity', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: null,
      status: 'assigned',
      status_category: 'assigned',
      waiting_reason: null,
      resolved_at: null,
      closed_at: null,
    });
    const svc = makeSvc(deps);

    const result = await svc.updateStatus(
      'wo1',
      { status_category: 'in_progress', status: 'in_progress' },
      SYSTEM_ACTOR,
    );

    expect(result.status_category).toBe('in_progress');
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      status_category: 'in_progress',
      status: 'in_progress',
    });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities).toHaveLength(1);
    expect(deps.activities[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'status_changed',
        previous: { status_category: 'assigned', status: 'assigned' },
        next: { status_category: 'in_progress', status: 'in_progress' },
      },
    });
    // Domain event ticket_status_changed (same name as case side).
    expect(deps.domainEvents).toHaveLength(1);
    expect(deps.domainEvents[0]).toMatchObject({
      tenant_id: TENANT,
      event_type: 'ticket_status_changed',
      entity_type: 'ticket',
      entity_id: 'wo1',
    });
  });

  it('synthesizes resolved_at when entering resolved category', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: null,
      status: 'in_progress',
      status_category: 'in_progress',
      waiting_reason: null,
      resolved_at: null,
      closed_at: null,
    });
    const svc = makeSvc(deps);

    await svc.updateStatus('wo1', { status_category: 'resolved' }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toHaveProperty('resolved_at');
    expect(typeof (deps.updates[0] as { resolved_at: unknown }).resolved_at).toBe('string');
  });

  it('synthesizes closed_at when entering closed category', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: null,
      status: 'resolved',
      status_category: 'resolved',
      waiting_reason: null,
      resolved_at: '2026-04-30T12:00:00.000Z',
      closed_at: null,
    });
    const svc = makeSvc(deps);

    await svc.updateStatus('wo1', { status_category: 'closed' }, SYSTEM_ACTOR);

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toHaveProperty('closed_at');
    expect(typeof (deps.updates[0] as { closed_at: unknown }).closed_at).toBe('string');
  });

  // Code-review C3: this is the WO surface's contract for the SLA helper —
  // "when status_category or waiting_reason changes on a WO with an SLA,
  // forward (entityId, tenantId, before, after) to slaService.applyWaitingStateTransition".
  // The pause/resume/policy-lookup behavior itself is owned by SlaService and
  // covered by sla.service.spec.ts.
  it('forwards before/after snapshots to slaService.applyWaitingStateTransition on a waiting transition', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: 'sla-x',
      status: 'in_progress',
      status_category: 'in_progress',
      waiting_reason: null,
      resolved_at: null,
      closed_at: null,
    });
    const svc = makeSvc(deps);

    await svc.updateStatus(
      'wo1',
      { status_category: 'waiting', waiting_reason: 'vendor' },
      SYSTEM_ACTOR,
    );

    expect(deps.slaService.applyWaitingStateTransition).toHaveBeenCalledTimes(1);
    expect(deps.slaService.applyWaitingStateTransition).toHaveBeenCalledWith(
      'wo1',
      TENANT,
      { status_category: 'in_progress', waiting_reason: null, sla_id: 'sla-x' },
      { status_category: 'waiting', waiting_reason: 'vendor', sla_id: 'sla-x' },
    );
  });

  it('does NOT call applyWaitingStateTransition when neither status_category nor waiting_reason changes', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: 'sla-x',
      status: 'in_progress',
      status_category: 'in_progress',
      waiting_reason: null,
      resolved_at: null,
      closed_at: null,
    });
    const svc = makeSvc(deps);

    // status changes but status_category + waiting_reason do not.
    await svc.updateStatus('wo1', { status: 'in_progress_b' }, SYSTEM_ACTOR);

    expect(deps.slaService.applyWaitingStateTransition).not.toHaveBeenCalled();
  });

  it('no-ops when all provided fields equal current values', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: null,
      status: 'in_progress',
      status_category: 'in_progress',
      waiting_reason: null,
      resolved_at: null,
      closed_at: null,
    });
    const svc = makeSvc(deps);

    const result = await svc.updateStatus(
      'wo1',
      { status: 'in_progress', status_category: 'in_progress' },
      SYSTEM_ACTOR,
    );

    expect(result.status_category).toBe('in_progress');
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
    expect(deps.domainEvents).toHaveLength(0);
  });

  it('rejects an empty DTO (no fields to change)', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      sla_id: null,
      status: 'in_progress',
      status_category: 'in_progress',
      waiting_reason: null,
      resolved_at: null,
      closed_at: null,
    });
    const svc = makeSvc(deps);

    await expect(svc.updateStatus('wo1', {}, SYSTEM_ACTOR)).rejects.toThrow(
      BadRequestException,
    );
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });
});
