// Tests for WorkOrderService.updateSla — the SLA edit path for child work
// orders post-1c.10c. These three scenarios are direct ports of the
// it.skip'd cases in `apps/api/src/modules/ticket/ticket-sla-edit.spec.ts`
// (which became obsolete when TicketService.update went case-only).
//
// Mock shape mirrors `bundle-visibility.service.spec.ts` and
// `ticket-sla-edit.spec.ts`: hand-rolled Supabase chain, dispatch on table
// name in `from()`. Builder methods chain back to themselves; resolution
// happens at `.maybeSingle()` / `.single()`.

import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  sla_id: string | null;
};

const TENANT = 't1';

function makeDeps(
  initial: WorkOrderRow,
  slaPolicies: Array<{ id: string; tenant_id: string }> = [],
  options: { hasOverridePermission?: boolean } = {},
) {
  let row: WorkOrderRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];

  // Track the table name across the chain so `update()` knows which table
  // it's updating (work_orders vs ticket_activities).
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'work_orders') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  // Both paths use .maybeSingle: the initial load-by-id and
                  // the post-restartTimers refetch. Returns a fresh snapshot
                  // of `row` so post-update reads see the merged state.
                  maybeSingle: async () => ({ data: { ...row }, error: null }),
                  single: async () => ({ data: { ...row }, error: null }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              row = { ...row, ...(patch as Partial<WorkOrderRow>) };
              // Post-update chain is `.eq().eq()` (no trailing .select()) —
              // the second .eq is a thenable that resolves to {data,error}.
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
        if (table === 'sla_policies') {
          return {
            select: () => ({
              eq: (_col1: string, val1: string) => ({
                eq: (_col2: string, val2: string) => ({
                  maybeSingle: async () => {
                    const hit = slaPolicies.find(
                      (p) => p.id === val1 && p.tenant_id === val2,
                    );
                    return { data: hit ? { id: hit.id } : null, error: null };
                  },
                }),
              }),
            }),
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
      // user_has_permission RPC — invoked by the danger-permission gate when
      // a non-SYSTEM_ACTOR caller without write_all attempts an SLA edit.
      rpc: jest.fn(async (fn: string, args: { p_user_id: string; p_permission: string }) => {
        if (fn !== 'user_has_permission') {
          throw new Error(`unexpected rpc in mock: ${fn}`);
        }
        permissionChecks.push({ user_id: args.p_user_id, permission: args.p_permission });
        return { data: !!options.hasOverridePermission, error: null };
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
    updates,
    activities,
    permissionChecks,
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

describe('WorkOrderService.updateSla', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('accepts sla_id change on a work_order and restarts timers', async () => {
    const deps = makeDeps(
      { id: 'wo1', tenant_id: TENANT, sla_id: 'sla-old' },
      [{ id: 'sla-new', tenant_id: TENANT }],
    );
    const svc = makeSvc(deps);

    const result = await svc.updateSla('wo1', 'sla-new', SYSTEM_ACTOR);

    expect(result.sla_id).toBe('sla-new');
    expect(deps.slaService.restartTimers).toHaveBeenCalledTimes(1);
    expect(deps.slaService.restartTimers).toHaveBeenCalledWith('wo1', TENANT, 'sla-new');
    // Update payload carries sla_id + updated_at (codex round 1: explicit
    // updated_at because work_orders has no auto-trigger post-1c.10c).
    expect(deps.updates[0]).toMatchObject({ sla_id: 'sla-new' });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'sla_changed',
        from_sla_id: 'sla-old',
        to_sla_id: 'sla-new',
      },
    });
  });

  it('accepts sla_id = null (clear SLA)', async () => {
    const deps = makeDeps({ id: 'wo1', tenant_id: TENANT, sla_id: 'sla-old' });
    const svc = makeSvc(deps);

    const result = await svc.updateSla('wo1', null, SYSTEM_ACTOR);

    expect(result.sla_id).toBeNull();
    expect(deps.slaService.restartTimers).toHaveBeenCalledTimes(1);
    expect(deps.slaService.restartTimers).toHaveBeenCalledWith('wo1', TENANT, null);
    expect(deps.updates[0]).toMatchObject({ sla_id: null });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities[0]).toMatchObject({
      metadata: {
        event: 'sla_changed',
        from_sla_id: 'sla-old',
        to_sla_id: null,
      },
    });
  });

  it('does NOT restart timers if sla_id is unchanged', async () => {
    const deps = makeDeps({ id: 'wo1', tenant_id: TENANT, sla_id: 'sla-x' });
    const svc = makeSvc(deps);

    const result = await svc.updateSla('wo1', 'sla-x', SYSTEM_ACTOR);

    expect(result.sla_id).toBe('sla-x');
    expect(deps.slaService.restartTimers).not.toHaveBeenCalled();
    expect(deps.updates).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  // Codex round 1 finding #1: SLA reassignment is danger:true in the
  // permission catalog. Plain assignees / vendors must NOT be able to
  // change SLA via assertCanPlan visibility alone; the gate also requires
  // sla.override OR tickets.write_all.
  it('throws Forbidden when caller lacks sla.override and write_all', async () => {
    const deps = makeDeps(
      { id: 'wo1', tenant_id: TENANT, sla_id: 'sla-old' },
      [{ id: 'sla-new', tenant_id: TENANT }],
      { hasOverridePermission: false },
    );
    // Override the visibility mock so loadContext returns has_write_all=false
    // (default in the makeDeps helper sets it true; here we want a non-admin).
    deps.visibility.loadContext = jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: false,
    });
    const svc = makeSvc(deps);

    await expect(svc.updateSla('wo1', 'sla-new', 'auth-uid-non-admin')).rejects.toThrow(
      /sla\.override permission required/,
    );

    // Confirm the gate ran the right RPC and stopped before mutating anything.
    expect(deps.permissionChecks).toEqual([
      { user_id: 'u1', permission: 'sla.override' },
    ]);
    expect(deps.updates).toHaveLength(0);
    expect(deps.slaService.restartTimers).not.toHaveBeenCalled();
    expect(deps.activities).toHaveLength(0);
  });
});
