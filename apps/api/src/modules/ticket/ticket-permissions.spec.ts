// Tests for the per-action permission gates on TicketService.update +
// TicketService.reassign. Layered ON TOP of the existing assertVisible('write')
// floor — case-side now mirrors WorkOrderService for assign + priority changes.
//
// Mock pattern lifted from work-order-update-assignment.spec.ts and
// work-order-update-priority.spec.ts. The TicketService constructor takes
// many more dependencies than WorkOrderService — most are stubbed as
// no-op proxies because the gate runs before any of those paths fire.

import { ForbiddenException } from '@nestjs/common';
import { TicketService, SYSTEM_ACTOR } from './ticket.service';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  priority: string;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  sla_id: string | null;
  title: string;
};

const TENANT = 't1';

function makeDeps(initial: Row, options: { hasPermission?: boolean; has_write_all?: boolean } = {}) {
  let row = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
                single: async () => ({ data: row, error: null }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              row = { ...row, ...patch };
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({ single: async () => ({ data: row, error: null }) }),
                  }),
                  select: () => ({ single: async () => ({ data: row, error: null }) }),
                }),
              };
            },
          } as unknown;
        }
        if (table === 'work_orders') {
          // Parent close guard query path — return empty children list.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => ({
                    async then(cb: (v: { data: Array<{ id: string }>; error: null }) => unknown) {
                      return cb({ data: [], error: null });
                    },
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'routing_decisions') {
          return {
            insert: jest.fn().mockResolvedValue({ data: null, error: null }),
          } as unknown;
        }
        if (table === 'users' || table === 'teams' || table === 'vendors') {
          // Two query shapes hit these tables in TicketService.update:
          //   1. `validateAssigneesInTenant` does
          //      `.select('id').eq('id', X).eq('tenant_id', Y).maybeSingle()` —
          //      should return `{ data: { id: X } }` to clear the validation.
          //   2. `resolveAuthorPersonId` does
          //      `.select(...).eq('auth_uid', X).eq('tenant_id', Y).maybeSingle()` —
          //      should return null (system attribution).
          // The mock can't distinguish by chained .eq column name, so it
          // returns a found-shape row whenever the .eq().eq() chain ends
          // in maybeSingle. The id passed back doesn't have to match —
          // the validator only checks that *something* came back.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: table === 'users' ? null : { id: 'mocked' },
                    error: null,
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        // Catch-all (ticket_activities, domain_events, etc.).
        return {
          insert: (a: Record<string, unknown>) => {
            activities.push(a);
            return {
              select: () => ({
                single: async () => ({ data: { ...a, id: 'generated' }, error: null }),
              }),
            };
          },
        } as unknown;
      }),
      rpc: jest.fn(async (fn: string, args: { p_user_id: string; p_permission: string }) => {
        if (fn !== 'user_has_permission') {
          throw new Error(`unexpected rpc in mock: ${fn}`);
        }
        permissionChecks.push({ user_id: args.p_user_id, permission: args.p_permission });
        return { data: !!options.hasPermission, error: null };
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
    completeTimers: jest.fn().mockResolvedValue(undefined),
    applyWaitingStateTransition: jest.fn().mockResolvedValue(undefined),
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
      has_write_all: !!options.has_write_all,
    }),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };

  return { row: () => row, updates, activities, permissionChecks, supabase, slaService, visibility };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new TicketService(
    deps.supabase as never,
    {} as never, // RoutingService — unused on these gate paths
    deps.slaService as never,
    {} as never, // WorkflowEngineService — unused
    {} as never, // ApprovalService — unused
    deps.visibility as never,
    {
      resolve: jest.fn().mockResolvedValue(null),
      resolveForLocation: jest.fn().mockResolvedValue(null),
      deriveEffectiveLocation: jest.fn().mockResolvedValue(null),
    } as never, // ScopeOverrideResolverService
  );
}

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'c1',
    tenant_id: TENANT,
    ticket_kind: 'case',
    status_category: 'assigned',
    priority: 'medium',
    assigned_team_id: 'team-old',
    assigned_user_id: null,
    assigned_vendor_id: null,
    sla_id: null,
    title: 'old title',
    ...overrides,
  };
}

describe('TicketService — per-action permission gates', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, subdomain: TENANT });
  });

  describe('update', () => {
    it('throws Forbidden when caller lacks tickets.change_priority and write_all', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await expect(
        svc.update('c1', { priority: 'high' }, 'auth-uid-non-admin'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        svc.update('c1', { priority: 'high' }, 'auth-uid-non-admin'),
      ).rejects.toThrow(/tickets\.change_priority permission required/);

      // First check is for tickets.change_priority (priority change is the
      // only mutation requested).
      expect(deps.permissionChecks[0]).toEqual({
        user_id: 'u1',
        permission: 'tickets.change_priority',
      });
      expect(deps.updates).toHaveLength(0);
    });

    it('throws Forbidden when caller lacks tickets.assign and write_all (assigned_team_id)', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await expect(
        svc.update('c1', { assigned_team_id: '33333333-3333-3333-3333-333333333333' }, 'auth-uid-non-admin'),
      ).rejects.toThrow(/tickets\.assign permission required/);

      expect(deps.permissionChecks[0]).toEqual({
        user_id: 'u1',
        permission: 'tickets.assign',
      });
      expect(deps.updates).toHaveLength(0);
    });

    it('throws Forbidden when caller lacks tickets.assign and write_all (assigned_user_id)', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await expect(
        svc.update('c1', { assigned_user_id: '44444444-4444-4444-4444-444444444444' }, 'auth-uid-non-admin'),
      ).rejects.toThrow(/tickets\.assign permission required/);
      expect(deps.updates).toHaveLength(0);
    });

    it('throws Forbidden when caller lacks tickets.assign and write_all (assigned_vendor_id)', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await expect(
        svc.update('c1', { assigned_vendor_id: '55555555-5555-5555-5555-555555555555' }, 'auth-uid-non-admin'),
      ).rejects.toThrow(/tickets\.assign permission required/);
      expect(deps.updates).toHaveLength(0);
    });

    it('does NOT trigger a permission gate when only updating title', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.update('c1', { title: 'new title' }, 'auth-uid-non-admin');

      // No user_has_permission RPC fired — the gate is fully skipped when the
      // DTO carries only fields that don't trigger assign or priority.
      expect(deps.permissionChecks).toHaveLength(0);
      expect(deps.updates).toHaveLength(1);
      expect(deps.updates[0]).toMatchObject({ title: 'new title' });
    });

    it('skips permission checks entirely when caller has tickets.write_all override', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: true });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        { priority: 'high', assigned_team_id: '33333333-3333-3333-3333-333333333333' },
        'auth-uid-admin',
      );

      // write_all short-circuits both per-action RPCs.
      expect(deps.permissionChecks).toHaveLength(0);
      expect(deps.updates).toHaveLength(1);
    });

    it('SYSTEM_ACTOR bypasses all gates', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        { priority: 'high', assigned_team_id: '33333333-3333-3333-3333-333333333333' },
        SYSTEM_ACTOR,
      );

      // No visibility loadContext, no permission RPC, no assertVisible.
      expect(deps.visibility.loadContext).not.toHaveBeenCalled();
      expect(deps.visibility.assertVisible).not.toHaveBeenCalled();
      expect(deps.permissionChecks).toHaveLength(0);
      expect(deps.updates).toHaveLength(1);
    });

    it('passes the gate when caller has tickets.change_priority granted', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: true, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.update('c1', { priority: 'high' }, 'auth-uid-agent');

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.change_priority' },
      ]);
      expect(deps.updates).toHaveLength(1);
      expect(deps.updates[0]).toMatchObject({ priority: 'high' });
    });

    it('passes the gate when caller has tickets.assign granted', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: true, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.update('c1', { assigned_team_id: '33333333-3333-3333-3333-333333333333' }, 'auth-uid-agent');

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.assign' },
      ]);
      expect(deps.updates).toHaveLength(1);
      expect(deps.updates[0]).toMatchObject({ assigned_team_id: '33333333-3333-3333-3333-333333333333' });
    });

    it('runs both permission checks when DTO carries both priority + assignment changes', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: true, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.update(
        'c1',
        { priority: 'high', assigned_team_id: '33333333-3333-3333-3333-333333333333' },
        'auth-uid-agent',
      );

      // Both RPCs fire; order: change_priority then assign.
      const kinds = deps.permissionChecks.map((c) => c.permission).sort();
      expect(kinds).toEqual(['tickets.assign', 'tickets.change_priority']);
    });
  });

  describe('reassign', () => {
    it('throws Forbidden when caller lacks tickets.assign and write_all', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await expect(
        svc.reassign(
          'c1',
          { assigned_team_id: '33333333-3333-3333-3333-333333333333', reason: 'team handover' },
          'auth-uid-non-admin',
        ),
      ).rejects.toThrow(/tickets\.assign permission required/);

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.assign' },
      ]);
      // No mutation should have happened.
      expect(deps.updates).toHaveLength(0);
    });

    it('skips the permission RPC when caller has tickets.write_all', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: true });
      const svc = makeSvc(deps);

      await svc.reassign(
        'c1',
        { assigned_team_id: '33333333-3333-3333-3333-333333333333', reason: 'team handover' },
        'auth-uid-admin',
      );

      expect(deps.permissionChecks).toHaveLength(0);
      // Mutation went through.
      expect(deps.updates.length).toBeGreaterThan(0);
    });

    it('SYSTEM_ACTOR bypasses the gate', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: false, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.reassign(
        'c1',
        { assigned_team_id: '33333333-3333-3333-3333-333333333333', reason: 'workflow auto-route' },
        SYSTEM_ACTOR,
      );

      expect(deps.visibility.loadContext).not.toHaveBeenCalled();
      expect(deps.visibility.assertVisible).not.toHaveBeenCalled();
      expect(deps.permissionChecks).toHaveLength(0);
    });

    it('passes the gate when caller has tickets.assign granted', async () => {
      const deps = makeDeps(baseRow(), { hasPermission: true, has_write_all: false });
      const svc = makeSvc(deps);

      await svc.reassign(
        'c1',
        { assigned_team_id: '33333333-3333-3333-3333-333333333333', reason: 'team handover' },
        'auth-uid-agent',
      );

      expect(deps.permissionChecks).toEqual([
        { user_id: 'u1', permission: 'tickets.assign' },
      ]);
      expect(deps.updates.length).toBeGreaterThan(0);
    });
  });
});
