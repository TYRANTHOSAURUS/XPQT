// Tests for WorkOrderService.reassign — audit02 Slice C (P1-1).
//
// The reassign path commits through the canonical `set_entity_assignment`
// v3 RPC (00416) in ONE transaction. v3 owns the work_orders UPDATE +
// status_category inheritance + command_operations idempotency +
// routing_decisions audit (strategy='manual'/chosen_by='manual_reassign',
// reason-gated) + ticket_activities + ticket_assigned domain event.
//
// What this spec asserts (vs. the legacy raw-write path):
//   - exactly ONE rpc('set_entity_assignment', …) with
//     p_entity_kind:'work_order', the deterministic reassign idempotency
//     key, the target assignment keys + reason + actor_person_id, and NO
//     `decision` key (WO is manual-only — rerun_resolver throws).
//   - NO raw `.from('work_orders').update(...)` for the assignment.
//   - NO standalone routing_decisions / ticket_activities insert (the
//     legacy swallowed try/catch that silently lost the audit on error).
//   - a post-RPC refetch miss yields `notFound`, NOT `forbidden`
//     (closes audit P2-4).
//   - rerun_resolver still throws 501-class unsupported (unchanged).
//   - missing clientRequestId hard-fails (crid is the idempotency seed).

import { AppError } from '../../common/errors';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';
import { buildReassignIdempotencyKey } from '@prequest/shared';

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
const CRID = 'crid-wo-1';
// validateAssigneesInTenant enforces real uuid shape for non-SYSTEM
// actors (tenant-validation.ts). SYSTEM_ACTOR paths skip validation, so
// the other fixtures can keep readable string ids.
const TEAM_X = '00000000-0000-4000-8000-00000000cccc';
const USER_X = '00000000-0000-4000-8000-00000000dddd';
const VENDOR_X = '00000000-0000-4000-8000-00000000eeee';

type RpcCall = { fn: string; args: Record<string, unknown> };

function makeDeps(
  initial: WorkOrderRow,
  options: {
    hasAssignPermission?: boolean;
    teams?: Array<{ id: string; tenant_id: string }>;
    users?: Array<{ id: string; tenant_id: string }>;
    vendors?: Array<{ id: string; tenant_id: string }>;
    // null → simulate a refetch miss after the RPC committed.
    refetchRow?: WorkOrderRow | null;
    rpcError?: { message: string; code?: string } | null;
    // audit02 CR2 / D-A02-4: command_operations success-probe rows keyed
    // by idempotency_key. A `success` row short-circuits the RPC.
    commandOps?: Record<
      string,
      { outcome: string; cached_result: Record<string, unknown> | null } | null
    >;
  } = {},
) {
  let row: WorkOrderRow = { ...initial };
  const rawUpdates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const routingDecisions: Array<Record<string, unknown>> = [];
  const permissionChecks: Array<{ user_id: string; permission: string }> = [];
  const rpcCalls: RpcCall[] = [];
  const commandOpsProbes: Array<Record<string, unknown>> = [];
  let woSelectCalls = 0;

  const teams = options.teams ?? [];
  const users = options.users ?? [];
  const vendors = options.vendors ?? [];
  // `options.refetchRow: null` forces a post-RPC refetch miss; otherwise
  // the refetch reflects the LIVE `row` (after the v3 mock mutated it).
  const refetchMiss = options.refetchRow === null;

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
                  maybeSingle: async () => {
                    woSelectCalls += 1;
                    // 1st select = pre-check existence (always the row);
                    // 2nd+ = post-RPC refetch (null when refetchMiss).
                    if (woSelectCalls === 1) {
                      return { data: { id: row.id }, error: null };
                    }
                    return {
                      data: refetchMiss ? null : { ...row },
                      error: null,
                    };
                  },
                  single: async () => ({ data: { ...row }, error: null }),
                }),
              }),
            }),
            // Any raw work_orders UPDATE for the assignment is a Slice C
            // regression — v3 owns the write.
            update: (patch: Record<string, unknown>) => {
              rawUpdates.push(patch);
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
        // A standalone routing_decisions / ticket_activities insert is a
        // Slice C regression — v3 owns those rows atomically.
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
        if (table === 'command_operations') {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            },
            maybeSingle: async () => {
              commandOpsProbes.push({ ...filters });
              const key = filters.idempotency_key as string;
              return {
                data: options.commandOps?.[key] ?? null,
                error: null,
              };
            },
          };
          return chain as unknown;
        }
        throw new Error(`unexpected table in mock: ${table}`);
      }),
      rpc: jest.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'user_has_permission') {
          permissionChecks.push({
            user_id: args.p_user_id as string,
            permission: args.p_permission as string,
          });
          return { data: !!options.hasAssignPermission, error: null };
        }
        if (fn === 'set_entity_assignment') {
          if (options.rpcError) {
            return { data: null, error: options.rpcError };
          }
          // Simulate v3 applying the assignment so the refetch reflects it.
          const payload = args.p_payload as Record<string, unknown>;
          row = {
            ...row,
            assigned_team_id: (payload.assigned_team_id as string | null) ?? null,
            assigned_user_id: (payload.assigned_user_id as string | null) ?? null,
            assigned_vendor_id: (payload.assigned_vendor_id as string | null) ?? null,
          };
          return { data: { noop: false }, error: null };
        }
        throw new Error(`unexpected rpc in mock: ${fn}`);
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
    rawUpdates,
    activities,
    routingDecisions,
    permissionChecks,
    rpcCalls,
    commandOpsProbes,
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

function assignCalls(rpcCalls: RpcCall[]) {
  return rpcCalls.filter((c) => c.fn === 'set_entity_assignment');
}

describe('WorkOrderService.reassign — audit02 Slice C (P1-1)', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes a team reassign through ONE set_entity_assignment v3 call with the deterministic key and no raw/swallowed writes', async () => {
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

    // Exactly ONE set_entity_assignment RPC, kind=work_order.
    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args.p_entity_id).toBe('wo1');
    expect(args.p_entity_kind).toBe('work_order');
    expect(args.p_tenant_id).toBe(TENANT);
    // SYSTEM_ACTOR collapses to null actor.
    expect(args.p_actor_user_id).toBeNull();
    expect(args.p_idempotency_key).toBe(
      buildReassignIdempotencyKey('work_order', 'wo1', CRID),
    );

    const payload = args.p_payload as Record<string, unknown>;
    expect(payload.assigned_team_id).toBe('team-new');
    expect(payload.assigned_user_id).toBeNull();
    expect(payload.assigned_vendor_id).toBeNull();
    expect(payload.reason).toBe(reason);
    expect(payload.actor_person_id).toBe('p-actor');
    // WO is manual-only — NEVER a `decision` key.
    expect(payload).not.toHaveProperty('decision');

    // No raw work_orders UPDATE, no standalone routing_decisions /
    // ticket_activities insert — v3 owns all of it atomically.
    expect(deps.rawUpdates).toHaveLength(0);
    expect(deps.routingDecisions).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  // ── Target-kind mapping coverage (the silent-mis-assign class) ───────
  // The team test above only exercises assigned_team_id. The
  // user / vendor manual mapping (work-order.service.ts:950-952 →
  // p_payload 1008-1010) is correct by inspection but unprotected: a
  // future edit swapping the assigned_user_id ↔ assigned_vendor_id line
  // would pass the rest of the suite. The WO reassign payload sends ALL
  // THREE assignment keys explicitly (the matched kind → its id, the
  // other two → explicit null) so v3 performs a clean overwrite.

  it('routes a user reassign through v3 with p_payload.assigned_user_id set and team/vendor explicitly null', async () => {
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
      {
        users: [{ id: USER_X, tenant_id: TENANT }],
        hasAssignPermission: true,
      },
    );
    const svc = makeSvc(deps);

    const result = await svc.reassign(
      'wo1',
      { assigned_user_id: USER_X, reason: 'assign to a specific tech', actor_person_id: 'p-actor' },
      'auth-uid-9',
      CRID,
    );

    expect(result.assigned_user_id).toBe(USER_X);

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args.p_entity_kind).toBe('work_order');
    const payload = args.p_payload as Record<string, unknown>;
    expect(payload.assigned_user_id).toBe(USER_X);
    expect(payload.assigned_team_id).toBeNull();
    expect(payload.assigned_vendor_id).toBeNull();
    expect(payload.reason).toBe('assign to a specific tech');
    expect(payload.actor_person_id).toBe('p-actor');
    // WO is manual-only — NEVER a `decision` key.
    expect(payload).not.toHaveProperty('decision');

    expect(deps.rawUpdates).toHaveLength(0);
    expect(deps.routingDecisions).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('routes a vendor reassign through v3 with p_payload.assigned_vendor_id set and team/user explicitly null', async () => {
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
      {
        vendors: [{ id: VENDOR_X, tenant_id: TENANT }],
        hasAssignPermission: true,
      },
    );
    const svc = makeSvc(deps);

    const result = await svc.reassign(
      'wo1',
      { assigned_vendor_id: VENDOR_X, reason: 'outsource to external vendor' },
      'auth-uid-9',
      CRID,
    );

    expect(result.assigned_vendor_id).toBe(VENDOR_X);

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const payload = calls[0].args.p_payload as Record<string, unknown>;
    expect(payload.assigned_vendor_id).toBe(VENDOR_X);
    expect(payload.assigned_team_id).toBeNull();
    expect(payload.assigned_user_id).toBeNull();
    expect(payload.reason).toBe('outsource to external vendor');
    expect(payload).not.toHaveProperty('decision');

    expect(deps.rawUpdates).toHaveLength(0);
    expect(deps.routingDecisions).toHaveLength(0);
    expect(deps.activities).toHaveLength(0);
  });

  it('non-SYSTEM actor forwards the auth uid as p_actor_user_id', async () => {
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
      {
        teams: [{ id: TEAM_X, tenant_id: TENANT }],
        hasAssignPermission: true,
      },
    );
    const svc = makeSvc(deps);

    await svc.reassign(
      'wo1',
      { assigned_team_id: TEAM_X, reason: 'cover' },
      'auth-uid-7',
      CRID,
    );

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_actor_user_id).toBe('auth-uid-7');
  });

  it('rejects when reason is missing or empty — before any RPC', async () => {
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

    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
    expect(deps.rawUpdates).toHaveLength(0);
  });

  it('hard-fails when clientRequestId is missing (crid is the idempotency seed)', async () => {
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
        // no crid
      ),
    ).rejects.toThrow(/X-Client-Request-Id/);

    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
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
        { assigned_team_id: 'team-new', reason: 'try' },
        'auth-uid-non-admin',
        CRID,
      ),
    ).rejects.toThrow(/tickets\.assign/);

    expect(deps.permissionChecks).toEqual([
      { user_id: 'u1', permission: 'tickets.assign' },
    ]);
    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
  });

  it('rejects rerun_resolver mode with 501-class unsupported (unchanged — WO is manual-only)', async () => {
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
        { assigned_team_id: 'team-new', reason: 'rerun please', rerun_resolver: true },
        SYSTEM_ACTOR,
        CRID,
      ),
    ).rejects.toThrow(/rerun_resolver is not yet supported/);

    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
  });

  it('a post-RPC refetch miss yields notFound (NOT forbidden) — closes audit P2-4', async () => {
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
      {
        teams: [{ id: 'team-new', tenant_id: TENANT }],
        // Pre-check returns a row (existence ok), but the post-RPC
        // refetch returns null → must be notFound, never forbidden.
        refetchRow: null,
      },
    );
    const svc = makeSvc(deps);

    let caught: unknown = null;
    try {
      await svc.reassign(
        'wo1',
        { assigned_team_id: 'team-new', reason: 'cover' },
        SYSTEM_ACTOR,
        CRID,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const code = (caught as AppError & { code?: string }).code;
    // notFound, not forbidden.
    expect(String(code)).not.toMatch(/no_longer_accessible|forbidden/i);
    expect(String((caught as Error).message)).not.toMatch(/no longer accessible/i);
  });

  it('maps a v3 RPC error through mapRpcErrorToAppError', async () => {
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
      {
        teams: [{ id: 'team-new', tenant_id: TENANT }],
        rpcError: { message: 'command_operations.payload_mismatch', code: 'P0001' },
      },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.reassign(
        'wo1',
        { assigned_team_id: 'team-new', reason: 'cover' },
        SYSTEM_ACTOR,
        CRID,
      ),
    ).rejects.toThrow(AppError);
  });

  // ── audit02 CR2 / D-A02-4 — command_operations success-probe ─────────
  // WO manual reassign is payload-stable, but the uniform guard is
  // applied for consistency/defense-in-depth: a retry with the SAME crid
  // that finds a committed command_operations success row returns the
  // contracted refetched row WITHOUT re-calling the RPC.
  it('retry with a committed command_operations success row: NO RPC, returns the refetched work_order row', async () => {
    const crid = 'crid-wo-retry';
    const key = buildReassignIdempotencyKey('work_order', 'wo1', crid);
    const deps = makeDeps(
      {
        id: 'wo1',
        tenant_id: TENANT,
        status: 'assigned',
        status_category: 'assigned',
        assigned_team_id: 'team-new',
        assigned_user_id: null,
        assigned_vendor_id: null,
      },
      {
        teams: [{ id: 'team-new', tenant_id: TENANT }],
        commandOps: {
          [key]: { outcome: 'success', cached_result: { noop: false } },
        },
      },
    );
    const svc = makeSvc(deps);

    const result = await svc.reassign(
      'wo1',
      { assigned_team_id: 'team-new', reason: 'retry same crid' },
      SYSTEM_ACTOR,
      crid,
    );

    // RPC NOT re-called — the canonical write already committed.
    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
    // Contracted return shape: the refetched work_order row.
    expect(result).toMatchObject({ id: 'wo1' });
    // Probe was tenant-scoped on the stable reassign key.
    expect(deps.commandOpsProbes).toHaveLength(1);
    expect(deps.commandOpsProbes[0]).toMatchObject({
      tenant_id: TENANT,
      idempotency_key: key,
    });
  });
});
