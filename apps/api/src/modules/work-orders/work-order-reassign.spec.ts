// Tests for WorkOrderService.reassign — audited assignment change with a
// reason.
//
// Audit-02 P1-1 cutover (2026-05-16): reassign no longer does 3 raw
// writes (assignment UPDATE + routing_decisions insert + activity
// insert) with try/catch-swallowed audit errors. It now makes ONE
// atomic `set_entity_assignment` (00327 v2) RPC call — the
// routing_decisions row (`manual` / `manual_reassign`, entity_kind +
// work_order_id set explicitly inside the RPC), the `reassigned`
// activity, the `ticket_assigned` domain event, and command_operations
// idempotency are all written inside the Postgres function (invisible
// to this mock). These specs therefore assert the RPC contract (correct
// args / payload / idempotency key) rather than the raw mock writes.
//
// P2-4: a null post-RPC refetch now throws `notFound`, not `forbidden`.

import { AppError } from '../../common/errors';
import { buildReassignIdempotencyKey } from '@prequest/shared';
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
    // Simulate the post-RPC refetch returning no row (P2-4).
    refetchMissing?: boolean;
  } = {},
) {
  let row: WorkOrderRow = { ...initial };
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];
  const assignmentRpcCalls: Array<Record<string, unknown>> = [];

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
                  maybeSingle: async () => ({
                    data: options.refetchMissing ? null : { ...row },
                    error: null,
                  }),
                  single: async () => ({ data: { ...row }, error: null }),
                }),
              }),
            }),
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
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      rpc: jest.fn(
        async (
          fn: string,
          args: Record<string, unknown>,
        ): Promise<{ data: unknown; error: unknown }> => {
          if (fn === 'user_has_permission') {
            const a = args as { p_user_id: string; p_permission: string };
            permissionChecks.push({ user_id: a.p_user_id, permission: a.p_permission });
            return { data: !!options.hasAssignPermission, error: null };
          }
          if (fn === 'set_entity_assignment') {
            assignmentRpcCalls.push(args);
            // Reflect the new assignee onto the row so the post-RPC
            // refetch returns the committed state.
            const payload = (args.p_payload ?? {}) as Record<string, unknown>;
            row = {
              ...row,
              assigned_team_id: (payload.assigned_team_id as string | null) ?? null,
              assigned_user_id: (payload.assigned_user_id as string | null) ?? null,
              assigned_vendor_id: (payload.assigned_vendor_id as string | null) ?? null,
            };
            return { data: { noop: false }, error: null };
          }
          throw new Error(`unexpected rpc in mock: ${fn}`);
        },
      ),
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
    permissionChecks,
    assignmentRpcCalls,
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

const CRID = 'crid-wo-reassign-1';

describe('WorkOrderService.reassign', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reassigns to a new team via one atomic set_entity_assignment RPC', async () => {
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
      CRID,
    );

    expect(result.assigned_team_id).toBe('team-new');

    // Exactly one set_entity_assignment call — the RPC writes the
    // routing_decisions / activity / domain-event rows atomically inside
    // Postgres (not visible to this mock).
    expect(deps.assignmentRpcCalls).toHaveLength(1);
    const call = deps.assignmentRpcCalls[0];
    expect(call).toMatchObject({
      p_entity_id: 'wo1',
      p_entity_kind: 'work_order',
      p_tenant_id: TENANT,
      // SYSTEM_ACTOR collapses to null actor.
      p_actor_user_id: null,
      p_idempotency_key: buildReassignIdempotencyKey('work_order', 'wo1', CRID),
      p_payload: {
        reason,
        actor_person_id: 'p-actor',
        assigned_team_id: 'team-new',
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
    });
  });

  it('rejects when reason is missing or empty (no RPC call)', async () => {
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
        CRID,
      ),
    ).rejects.toThrow(AppError);

    await expect(
      svc.reassign(
        'wo1',
        { assigned_team_id: 'team-new', reason: '   ' },
        SYSTEM_ACTOR,
        CRID,
      ),
    ).rejects.toThrow(AppError);

    expect(deps.assignmentRpcCalls).toHaveLength(0);
  });

  it('rejects when X-Client-Request-Id is missing (no RPC call)', async () => {
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
        { assigned_team_id: 'team-new', reason: 'cover' },
        SYSTEM_ACTOR,
        // no clientRequestId
      ),
    ).rejects.toThrow(AppError);

    expect(deps.assignmentRpcCalls).toHaveLength(0);
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
        CRID,
      ),
    ).rejects.toThrow(/tickets\.assign/);

    expect(deps.permissionChecks).toEqual([
      { user_id: 'u1', permission: 'tickets.assign' },
    ]);
    expect(deps.assignmentRpcCalls).toHaveLength(0);
  });

  it('rejects rerun_resolver mode (deferred — unchanged by the P1-1 cutover)', async () => {
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
        {
          assigned_team_id: 'team-new',
          reason: 'rerun please',
          rerun_resolver: true,
        },
        SYSTEM_ACTOR,
        CRID,
      ),
    ).rejects.toThrow(AppError);

    await expect(
      svc.reassign(
        'wo1',
        {
          assigned_team_id: 'team-new',
          reason: 'rerun please',
          rerun_resolver: true,
        },
        SYSTEM_ACTOR,
        CRID,
      ),
    ).rejects.toThrow(/rerun_resolver is not yet supported/);

    expect(deps.assignmentRpcCalls).toHaveLength(0);
  });

  it('throws notFound (not forbidden) when the post-RPC refetch returns no row (P2-4)', async () => {
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
      { teams: [{ id: 'team-new', tenant_id: TENANT }], refetchMissing: true },
    );
    const svc = makeSvc(deps);

    let caught: unknown = null;
    try {
      await svc.reassign(
        'wo1',
        { assigned_team_id: 'team-new', reason: 'cover', actor_person_id: 'p-actor' },
        SYSTEM_ACTOR,
        CRID,
      );
    } catch (e) {
      caught = e;
    }

    // The RPC committed; a null refetch is a not-found shape, not a
    // permission failure. Was `forbidden('work_order.no_longer_accessible')`.
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('work_order.not_found');
    expect(deps.assignmentRpcCalls).toHaveLength(1);
  });
});
