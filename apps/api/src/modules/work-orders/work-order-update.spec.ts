// Tests for WorkOrderService.update — the orchestrator that backs the
// single `PATCH /work-orders/:id` endpoint (plan-reviewer P1). The
// orchestrator's job is to dispatch a union DTO to the existing per-field
// service methods (`updateSla`, `setPlan`, `updateStatus`, `updatePriority`,
// `updateAssignment`) so each field's gate, no-op fast-path, and side
// effects are reused unchanged. The per-field methods themselves are
// covered by their own specs (`work-order-sla-edit.spec.ts`,
// `work-order-set-plan.spec.ts`, etc.).
//
// Strategy: spy on the per-field methods directly and assert which one(s)
// got called for each DTO shape. We don't reach into Supabase here — the
// per-field specs already prove the underlying behavior. This spec is the
// dispatch contract.

import { BadRequestException } from '@nestjs/common';
import {
  WorkOrderService,
  SYSTEM_ACTOR,
  type WorkOrderRow,
} from './work-order.service';

const TENANT = 't1';

function makeRow(overrides: Partial<WorkOrderRow> = {}): WorkOrderRow {
  return {
    id: 'wo1',
    tenant_id: TENANT,
    sla_id: null,
    planned_start_at: null,
    planned_duration_minutes: null,
    status: 'assigned',
    status_category: 'assigned',
    priority: 'medium',
    assigned_team_id: null,
    assigned_user_id: null,
    assigned_vendor_id: null,
    ...overrides,
  } as WorkOrderRow;
}

interface RefetchCall {
  table: string;
  id: string;
  tenant: string;
}

function makeSvc(refetchedRow: WorkOrderRow = makeRow()) {
  const refetchCalls: RefetchCall[] = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => ({
        select: () => ({
          eq: (_c1: string, v1: string) => ({
            eq: (_c2: string, v2: string) => ({
              maybeSingle: async () => {
                refetchCalls.push({ table, id: v1, tenant: v2 });
                return { data: { ...refetchedRow }, error: null };
              },
            }),
          }),
        }),
      })),
      rpc: jest.fn(),
    },
  };

  // SlaService + visibility are unused here because we spy on the per-field
  // methods (which is where they get touched). Stub them to throw if anyone
  // bypasses the spy.
  const slaService = {
    restartTimers: jest.fn(),
    pauseTimers: jest.fn(),
    resumeTimers: jest.fn(),
    completeTimers: jest.fn(),
    startTimers: jest.fn(),
    applyWaitingStateTransition: jest.fn(),
  };
  const visibility = {
    loadContext: jest.fn(),
    assertCanPlan: jest.fn(),
  };

  const svc = new WorkOrderService(
    supabase as never,
    slaService as never,
    visibility as never,
  );

  // Spy on every per-field method. The orchestrator delegates to these;
  // the spy lets us assert which one was called with what args.
  const spies = {
    updateSla: jest.spyOn(svc, 'updateSla').mockResolvedValue(makeRow({ sla_id: 'sla-x' })),
    setPlan: jest.spyOn(svc, 'setPlan').mockResolvedValue(makeRow({ planned_start_at: '2026-05-04T13:00:00.000Z' })),
    updateStatus: jest.spyOn(svc, 'updateStatus').mockResolvedValue(makeRow({ status: 'in_progress', status_category: 'in_progress' })),
    updatePriority: jest.spyOn(svc, 'updatePriority').mockResolvedValue(makeRow({ priority: 'high' })),
    updateAssignment: jest.spyOn(svc, 'updateAssignment').mockResolvedValue(makeRow({ assigned_user_id: 'u9' })),
    updateMetadata: jest.spyOn(svc, 'updateMetadata').mockResolvedValue(makeRow({ title: 'updated' })),
  };

  return { svc, spies, supabase, refetchCalls };
}

describe('WorkOrderService.update (orchestrator)', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches sla_id-only call to updateSla and nothing else', async () => {
    const { svc, spies } = makeSvc();
    const row = await svc.update('wo1', { sla_id: 'sla-x' }, SYSTEM_ACTOR);

    expect(spies.updateSla).toHaveBeenCalledTimes(1);
    expect(spies.updateSla).toHaveBeenCalledWith('wo1', 'sla-x', SYSTEM_ACTOR);
    expect(spies.setPlan).not.toHaveBeenCalled();
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.updatePriority).not.toHaveBeenCalled();
    expect(spies.updateAssignment).not.toHaveBeenCalled();
    expect(row.sla_id).toBe('sla-x');
  });

  it('dispatches plan-only call to setPlan with both fields', async () => {
    const { svc, spies } = makeSvc();
    await svc.update(
      'wo1',
      { planned_start_at: '2026-05-04T13:00:00.000Z', planned_duration_minutes: 60 },
      SYSTEM_ACTOR,
    );

    expect(spies.setPlan).toHaveBeenCalledTimes(1);
    expect(spies.setPlan).toHaveBeenCalledWith(
      'wo1',
      '2026-05-04T13:00:00.000Z',
      60,
      SYSTEM_ACTOR,
    );
    expect(spies.updateSla).not.toHaveBeenCalled();
    expect(spies.updateStatus).not.toHaveBeenCalled();
  });

  it('dispatches status-only call to updateStatus with the provided status fields', async () => {
    const { svc, spies } = makeSvc();
    await svc.update(
      'wo1',
      { status_category: 'in_progress', status: 'in_progress' },
      SYSTEM_ACTOR,
    );

    expect(spies.updateStatus).toHaveBeenCalledTimes(1);
    expect(spies.updateStatus).toHaveBeenCalledWith(
      'wo1',
      { status: 'in_progress', status_category: 'in_progress' },
      SYSTEM_ACTOR,
    );
    expect(spies.updatePriority).not.toHaveBeenCalled();
  });

  it('dispatches priority-only call to updatePriority', async () => {
    const { svc, spies } = makeSvc();
    await svc.update('wo1', { priority: 'high' }, SYSTEM_ACTOR);

    expect(spies.updatePriority).toHaveBeenCalledTimes(1);
    expect(spies.updatePriority).toHaveBeenCalledWith('wo1', 'high', SYSTEM_ACTOR);
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.updateAssignment).not.toHaveBeenCalled();
  });

  it('dispatches assignment-only call to updateAssignment with only the supplied keys', async () => {
    const { svc, spies } = makeSvc();
    await svc.update('wo1', { assigned_user_id: 'u9' }, SYSTEM_ACTOR);

    expect(spies.updateAssignment).toHaveBeenCalledTimes(1);
    expect(spies.updateAssignment).toHaveBeenCalledWith(
      'wo1',
      { assigned_user_id: 'u9' },
      SYSTEM_ACTOR,
    );
    expect(spies.updatePriority).not.toHaveBeenCalled();
  });

  it('dispatches assignment with explicit nulls (clearing) preserved as null, not stripped', async () => {
    const { svc, spies } = makeSvc();
    await svc.update(
      'wo1',
      { assigned_team_id: null, assigned_user_id: 'u9' },
      SYSTEM_ACTOR,
    );

    expect(spies.updateAssignment).toHaveBeenCalledWith(
      'wo1',
      { assigned_team_id: null, assigned_user_id: 'u9' },
      SYSTEM_ACTOR,
    );
  });

  it('dispatches multi-field call (status + priority + assignment) to all three methods, in order', async () => {
    const { svc, spies, refetchCalls } = makeSvc(
      makeRow({
        status: 'in_progress',
        status_category: 'in_progress',
        priority: 'high',
        assigned_user_id: 'u9',
      }),
    );
    const row = await svc.update(
      'wo1',
      {
        status_category: 'in_progress',
        status: 'in_progress',
        priority: 'high',
        assigned_user_id: 'u9',
      },
      SYSTEM_ACTOR,
    );

    expect(spies.updateStatus).toHaveBeenCalledTimes(1);
    expect(spies.updatePriority).toHaveBeenCalledTimes(1);
    expect(spies.updateAssignment).toHaveBeenCalledTimes(1);

    // Order: SLA → plan → status → priority → assignment.
    const order = [
      spies.updateSla.mock.invocationCallOrder[0],
      spies.setPlan.mock.invocationCallOrder[0],
      spies.updateStatus.mock.invocationCallOrder[0],
      spies.updatePriority.mock.invocationCallOrder[0],
      spies.updateAssignment.mock.invocationCallOrder[0],
    ].filter((n) => typeof n === 'number');
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);

    // Multi-field calls refetch once at the end so the response reflects
    // every side effect.
    expect(refetchCalls).toHaveLength(1);
    expect(refetchCalls[0]).toEqual({ table: 'work_orders', id: 'wo1', tenant: TENANT });
    expect(row.status_category).toBe('in_progress');
    expect(row.priority).toBe('high');
    expect(row.assigned_user_id).toBe('u9');
  });

  it('rejects an empty DTO', async () => {
    const { svc, spies } = makeSvc();
    await expect(svc.update('wo1', {}, SYSTEM_ACTOR)).rejects.toThrow(BadRequestException);
    expect(spies.updateSla).not.toHaveBeenCalled();
    expect(spies.setPlan).not.toHaveBeenCalled();
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.updatePriority).not.toHaveBeenCalled();
    expect(spies.updateAssignment).not.toHaveBeenCalled();
    expect(spies.updateMetadata).not.toHaveBeenCalled();
  });

  it('dispatches metadata-only call to updateMetadata with all 5 metadata fields', async () => {
    // Slice 3.1: title / description / cost / tags / watchers go to a single
    // updateMetadata branch. Verifies dispatcher detection + correct DTO
    // narrowing. The non-metadata branches must NOT fire.
    const { svc, spies } = makeSvc();
    await svc.update(
      'wo1',
      {
        title: 'new title',
        description: 'new desc',
        cost: 250,
        tags: ['a', 'b'],
        watchers: ['p1'],
      },
      SYSTEM_ACTOR,
    );

    expect(spies.updateMetadata).toHaveBeenCalledTimes(1);
    expect(spies.updateMetadata).toHaveBeenCalledWith(
      'wo1',
      {
        title: 'new title',
        description: 'new desc',
        cost: 250,
        tags: ['a', 'b'],
        watchers: ['p1'],
      },
      SYSTEM_ACTOR,
    );
    expect(spies.updateSla).not.toHaveBeenCalled();
    expect(spies.setPlan).not.toHaveBeenCalled();
    expect(spies.updateStatus).not.toHaveBeenCalled();
    expect(spies.updatePriority).not.toHaveBeenCalled();
    expect(spies.updateAssignment).not.toHaveBeenCalled();
  });

  it('dispatches a metadata + status mix (multi-field)', async () => {
    // Status before metadata in the dispatch order so status side effects
    // (resolved_at synthesis, timer pause/resume) settle before the
    // metadata bulk write.
    const { svc, spies } = makeSvc();
    await svc.update(
      'wo1',
      { status: 'in_progress', status_category: 'in_progress', title: 'updated' },
      SYSTEM_ACTOR,
    );

    expect(spies.updateStatus).toHaveBeenCalledTimes(1);
    expect(spies.updateMetadata).toHaveBeenCalledTimes(1);
    // Order assertion: status fires before metadata.
    const statusOrder = spies.updateStatus.mock.invocationCallOrder[0];
    const metadataOrder = spies.updateMetadata.mock.invocationCallOrder[0];
    expect(statusOrder).toBeLessThan(metadataOrder);
  });

  it('rejects a null DTO', async () => {
    const { svc } = makeSvc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(svc.update('wo1', null as any, SYSTEM_ACTOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('SYSTEM_ACTOR forwards as-is to per-field methods (which bypass gates internally)', async () => {
    const { svc, spies } = makeSvc();
    await svc.update('wo1', { sla_id: 'sla-x', priority: 'high' }, SYSTEM_ACTOR);

    expect(spies.updateSla).toHaveBeenCalledWith('wo1', 'sla-x', SYSTEM_ACTOR);
    expect(spies.updatePriority).toHaveBeenCalledWith('wo1', 'high', SYSTEM_ACTOR);
  });

  it('forwards a real auth uid to per-field methods so their gates fire', async () => {
    const { svc, spies } = makeSvc();
    await svc.update('wo1', { sla_id: 'sla-x' }, 'auth-uid-real');

    expect(spies.updateSla).toHaveBeenCalledWith('wo1', 'sla-x', 'auth-uid-real');
  });

  it('propagates a Forbidden from the SLA branch and never invokes downstream branches', async () => {
    const { svc, spies } = makeSvc();
    spies.updateSla.mockReset().mockRejectedValue(
      new (require('@nestjs/common').ForbiddenException)(
        'sla.override permission required to change a work order SLA',
      ),
    );

    await expect(
      svc.update('wo1', { sla_id: 'sla-x', priority: 'high' }, 'auth-uid-no-sla'),
    ).rejects.toThrow(/sla\.override permission required/);

    // Priority dispatch was downstream of SLA in the apply order — must not
    // have fired after the SLA gate failed.
    expect(spies.updatePriority).not.toHaveBeenCalled();
  });

  it('propagates a Forbidden from the priority branch (tickets.change_priority denied)', async () => {
    const { svc, spies } = makeSvc();
    spies.updatePriority.mockReset().mockRejectedValue(
      new (require('@nestjs/common').ForbiddenException)(
        'tickets.change_priority permission required to change a work order priority',
      ),
    );

    await expect(
      svc.update('wo1', { priority: 'high' }, 'auth-uid-no-priority'),
    ).rejects.toThrow(/tickets\.change_priority permission required/);
  });

  it('propagates a Forbidden from the assignment branch (tickets.assign denied)', async () => {
    const { svc, spies } = makeSvc();
    spies.updateAssignment.mockReset().mockRejectedValue(
      new (require('@nestjs/common').ForbiddenException)(
        'tickets.assign permission required to change a work order assignment',
      ),
    );

    await expect(
      svc.update('wo1', { assigned_user_id: 'u9' }, 'auth-uid-no-assign'),
    ).rejects.toThrow(/tickets\.assign permission required/);
  });
});
