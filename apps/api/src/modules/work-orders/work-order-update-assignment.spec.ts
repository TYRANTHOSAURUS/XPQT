// Tests for WorkOrderService.updateAssignment — silent-PATCH assignment
// path for child work_orders post-1c.10c. Mock pattern mirrors the other
// work-order specs.

import { BadRequestException } from '@nestjs/common';
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
  const domainEvents: Array<Record<string, unknown>> = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];

  const teams = options.teams ?? [];
  const users = options.users ?? [];
  const vendors = options.vendors ?? [];

  // Helper to build a tenant-scoped lookup chain. The validateAssigneesInTenant
  // helper does .from(table).select('id').eq('id', X).eq('tenant_id', Y).maybeSingle().
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
          // resolveAuthorPersonId queries `users` with .eq('auth_uid', X).eq('tenant_id', Y)
          // — that path returns null (system attribution). validateAssigneesInTenant
          // queries with .eq('id', X).eq('tenant_id', Y). Both look the same from
          // the chain's POV so we need to dispatch on the actual filter column.
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
    domainEvents,
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

describe('WorkOrderService.updateAssignment', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('changes assigned_team_id and emits assignment_changed activity', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'new',
        status_category: 'new',
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-a', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    const result = await svc.updateAssignment(
      'wo1',
      { assigned_team_id: 'team-a' },
      SYSTEM_ACTOR,
    );

    expect(result.assigned_team_id).toBe('team-a');
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({ assigned_team_id: 'team-a' });
    expect(deps.updates[0]).toHaveProperty('updated_at');
    expect(deps.activities).toHaveLength(1);
    expect(deps.activities[0]).toMatchObject({
      tenant_id: TENANT,
      ticket_id: 'wo1',
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'assignment_changed',
        previous: { assigned_team_id: null },
        next: { assigned_team_id: 'team-a' },
      },
    });
    expect(deps.domainEvents).toHaveLength(1);
    expect(deps.domainEvents[0]).toMatchObject({
      event_type: 'ticket_assigned',
      entity_type: 'ticket',
      entity_id: 'wo1',
    });
  });

  it('changes assigned_user_id', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: null,
        assigned_user_id: 'user-old',
        assigned_vendor_id: null,
      },
      { users: [{ id: 'user-new', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    await svc.updateAssignment(
      'wo1',
      { assigned_user_id: 'user-new' },
      SYSTEM_ACTOR,
    );

    expect(deps.updates[0]).toMatchObject({ assigned_user_id: 'user-new' });
  });

  it('changes assigned_vendor_id', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { vendors: [{ id: 'vendor-x', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    await svc.updateAssignment(
      'wo1',
      { assigned_vendor_id: 'vendor-x' },
      SYSTEM_ACTOR,
    );

    expect(deps.updates[0]).toMatchObject({ assigned_vendor_id: 'vendor-x' });
  });

  it('changes multiple fields atomically', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'new',
        status_category: 'new',
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      {
        teams: [{ id: 'team-a', tenant_id: TENANT }],
        users: [{ id: 'user-x', tenant_id: TENANT }],
      },
    );
    const svc = makeSvc(deps);

    await svc.updateAssignment(
      'wo1',
      { assigned_team_id: 'team-a', assigned_user_id: 'user-x' },
      SYSTEM_ACTOR,
    );

    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      assigned_team_id: 'team-a',
      assigned_user_id: 'user-x',
    });
  });

  it('rejects an unknown team id (cross-tenant smuggling defense)', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'new',
        status_category: 'new',
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-a', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.updateAssignment('wo1', { assigned_team_id: 'team-other-tenant' }, SYSTEM_ACTOR),
    ).rejects.toThrow(BadRequestException);

    expect(deps.updates).toHaveLength(0);
  });

  it('does NOT auto-promote new → assigned on first-time assignment', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'new',
        status_category: 'new',
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-a', tenant_id: TENANT }] },
    );
    const svc = makeSvc(deps);

    await svc.updateAssignment(
      'wo1',
      { assigned_team_id: 'team-a' },
      SYSTEM_ACTOR,
    );

    // Status stays as-is — case side doesn't auto-promote on PATCH either.
    expect(deps.updates[0]).not.toHaveProperty('status');
    expect(deps.updates[0]).not.toHaveProperty('status_category');
  });

  it('throws Forbidden when caller lacks tickets.assign and write_all', async () => {
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: null,
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      { teams: [{ id: 'team-a', tenant_id: TENANT }], hasAssignPermission: false },
    );
    deps.visibility.loadContext = jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: false,
    });
    const svc = makeSvc(deps);

    await expect(
      svc.updateAssignment('wo1', { assigned_team_id: 'team-a' }, 'auth-uid-non-admin'),
    ).rejects.toThrow(/tickets\.assign permission required/);

    expect(deps.permissionChecks).toEqual([
      { user_id: 'u1', permission: 'tickets.assign' },
    ]);
    expect(deps.updates).toHaveLength(0);
  });
});
