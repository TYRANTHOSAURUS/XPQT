// Tests for WorkOrderService.updatePriority — the priority edit path for
// child work_orders post-1c.10c. Mock pattern mirrors the other work-order
// specs.

import { BadRequestException } from '@nestjs/common';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  priority: string;
};

const TENANT = 't1';

function makeDeps(
  initial: WorkOrderRow,
  options: { hasChangePermission?: boolean } = {},
) {
  let row: WorkOrderRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];

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
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      rpc: jest.fn(async (fn: string, args: { p_user_id: string; p_permission: string }) => {
        if (fn !== 'user_has_permission') {
          throw new Error(`unexpected rpc in mock: ${fn}`);
        }
        permissionChecks.push({ user_id: args.p_user_id, permission: args.p_permission });
        return { data: !!options.hasChangePermission, error: null };
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

  return { row: () => row, updates, activities, permissionChecks, supabase, slaService, visibility };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new WorkOrderService(
    deps.supabase as never,
    deps.slaService as never,
    deps.visibility as never,
  );
}

describe('WorkOrderService.updatePriority', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('accepts a priority change and emits priority_changed activity', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      priority: 'medium',
    });
    const svc = makeSvc(deps);

    const result = await svc.updatePriority('wo1', 'high', SYSTEM_ACTOR);

    expect(result.priority).toBe('high');
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ priority: 'high' });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities).toHaveLength(1);
    expect(deps.activities[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'priority_changed',
        previous: 'medium',
        next: 'high',
      },
    });
  });

  it('no-ops when priority is unchanged', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      priority: 'high',
    });
    const svc = makeSvc(deps);

    const result = await svc.updatePriority('wo1', 'high', SYSTEM_ACTOR);

    expect(result.priority).toBe('high');
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('rejects an invalid priority value', async () => {
    const deps = makeDeps({
      id: 'wo1',
      tenant_id: TENANT,
      priority: 'medium',
    });
    const svc = makeSvc(deps);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc.updatePriority('wo1', 'urgent' as any, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('throws Forbidden when caller lacks tickets.change_priority and write_all', async () => {
    const deps = makeDeps(
      { id: 'wo1', tenant_id: TENANT, priority: 'medium' },
      { hasChangePermission: false },
    );
    deps.visibility.loadContext = jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: false,
    });
    const svc = makeSvc(deps);

    await expect(svc.updatePriority('wo1', 'high', 'auth-uid-non-admin')).rejects.toThrow(
      /tickets\.change_priority/,
    );

    expect(deps.permissionChecks).toEqual([
      { user_id: 'u1', permission: 'tickets.change_priority' },
    ]);
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });
});
