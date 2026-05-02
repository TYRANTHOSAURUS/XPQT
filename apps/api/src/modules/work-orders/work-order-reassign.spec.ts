// Tests for WorkOrderService.reassign — audited assignment change with a
// reason. Distinct from updateAssignment because it writes a routing_decisions
// row (entity_kind='work_order') and an internal-visibility activity.

import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

type WorkOrderRow = {
  id: string;
  tenant_id: string;
  status: string;
  status_category: string;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
};

const TENANT = 't1';

function makeDeps(
  initial: WorkOrderRow,
  options: {
    hasAssignPermission?: boolean;
    teams?: Array<{ id: string; tenant_id: string }>;
    users?: Array<{ id: string; tenant_id: string }>;
    vendors?: Array<{ id: string; tenant_id: string }>;
  } = {},
) {
  let row: WorkOrderRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const routingDecisions: Array<Record<string, unknown>> = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];

  const teams = options.teams ?? [];
  const users = options.users ?? [];
  const vendors = options.vendors ?? [];

  const tenantLookup = (matches: Array<{ id: string; tenant_id: string }>) => ({
    select: () => ({
      eq: (_col1: string, val1: string) => ({
        eq: (_col2: string, val2: string) => ({
          maybeSingle: async () => {
            const hit = matches.find((m) => m.id === val1 && m.tenant_id === val2);
            return { data: hit ? { id: hit.id } : null, error: null };
          },
        }),
      }),
    }),
  });

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
        if (table === 'teams') return tenantLookup(teams) as unknown;
        if (table === 'vendors') return tenantLookup(vendors) as unknown;
        if (table === 'users') {
          return {
            select: () => ({
              eq: (col1: string, val1: string) => ({
                eq: (_col2: string, val2: string) => ({
                  maybeSingle: async () => {
                    if (col1 === 'id') {
                      const hit = users.find((u) => u.id === val1 && u.tenant_id === val2);
                      return { data: hit ? { id: hit.id } : null, error: null };
                    }
                    return { data: null, error: null };
                  },
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
        if (table === 'routing_decisions') {
          return {
            insert: async (rd: Record<string, unknown>) => {
              routingDecisions.push(rd);
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
        return { data: !!options.hasAssignPermission, error: null };
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
    routingDecisions,
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

describe('WorkOrderService.reassign', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('reassigns to a new team and writes a routing_decisions row with the reason', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: 'team-old',
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-new', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    const reason = 'Reassigned team from Old to New for cover';
    const result = await svc.reassign(
      'wo1',
      {
        assigned_team_id: 'team-new',
        reason,
        actor_person_id: 'p-actor',
      },
      SYSTEM_ACTOR,
    );

    expect(result.assigned_team_id).toBe('team-new');
    // The work_orders update clears all three fields then sets the new one.
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      assigned_team_id: 'team-new',
      assigned_user_id: null,
      assigned_vendor_id: null,
    });
    expect(deps.updates[0]).toHaveProperty('updated_at');

    // routing_decisions row carries entity_kind='work_order' + work_order_id
    // (the 00230 derive trigger only handles cases via tickets table — we
    // MUST set polymorphic columns explicitly for work_orders).
    expect(deps.routingDecisions).toHaveLength(1);
    expect(deps.routingDecisions[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      entity_kind: 'work_order',
      work_order_id: 'wo1',
      strategy: 'manual',
      chosen_by: 'manual_reassign',
      chosen_team_id: 'team-new',
      chosen_user_id: null,
      chosen_vendor_id: null,
      context: {
        reason,
        previous: { team: 'team-old', user: null, vendor: null },
        actor: 'p-actor',
      },
    });
    // trace contains the manual_reassign step with the reason
    const trace = (deps.routingDecisions[0] as { trace: Array<Record<string, unknown>> }).trace;
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      step: 'manual_reassign',
      matched: true,
      reason,
      by: 'p-actor',
    });

    // Activity row is internal-visibility (not 'system') because the reason
    // is human-authored — surfaces in timeline as a note. Reason in content.
    expect(deps.activities).toHaveLength(1);
    expect(deps.activities[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      activity_type: 'system_event',
      visibility: 'internal',
      content: reason,
      author_person_id: 'p-actor',
      metadata: {
        event: 'reassigned',
        previous: { team: 'team-old', user: null, vendor: null },
        next: { kind: 'team', id: 'team-new' },
        mode: 'manual_reassign',
        reason,
      },
    });
  });

  it('rejects when reason is missing or empty', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: 'team-old',
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-new', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.reassign(
        'wo1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { assigned_team_id: 'team-new' } as any,
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      svc.reassign(
        'wo1',
        { assigned_team_id: 'team-new', reason: '   ' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(deps.updates).toHaveLength(0);
    expect(deps.routingDecisions).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('throws Forbidden when caller lacks tickets.assign and write_all', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: 'team-old',
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-new', tenant_id: TENANT }], hasAssignPermission: false },
    );
    deps.visibility.loadContext = jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: false,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.reassign(
        'wo1',
        {
          assigned_team_id: 'team-new',
          reason: 'try',
        },
        'auth-uid-non-admin',
      ),
    ).rejects.toThrow(/tickets\.assign/);

    expect(deps.permissionChecks).toEqual([
      { user_id: 'u1', permission: 'tickets.assign' },
    ]);
    expect(deps.updates).toHaveLength(0);
    expect(deps.routingDecisions).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('rejects rerun_resolver mode with 501 NotImplemented (deferred to a future slice)', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: 'team-old',
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-new', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    // 501 NotImplemented (not 400 BadRequest) — the request is well-formed,
    // the resource just doesn't implement that mode yet.
    await expect(
      svc.reassign(
        'wo1',
        {
          assigned_team_id: 'team-new',
          reason: 'rerun please',
          rerun_resolver: true,
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(NotImplementedException);

    await expect(
      svc.reassign(
        'wo1',
        {
          assigned_team_id: 'team-new',
          reason: 'rerun please',
          rerun_resolver: true,
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/rerun_resolver is not yet supported/);

    expect(deps.updates).toHaveLength(0);
    expect(deps.routingDecisions).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });
});
