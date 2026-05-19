// Plan A.2 / Commit 4 regression — ticket reassign(rerun_resolver=true)
// post-resolver tenant validation.
//
// Gap map §work-order.service.ts:1763 attributed the
// rerunAssignmentResolver gap to work-orders, but the work-order side
// throws for `rerun_resolver: true`. The actual rerun_resolver path
// lives in ticket.service.ts (case side). This spec covers that real
// surface: even though routing tables are tenant-scoped, the resolver
// returns a structured payload that we validate before propagating it
// into the atomic set_entity_assignment RPC.
//
// Audit-02 P1-1 cutover (2026-05-16): the rerun path is now
// resolver-FIRST (no clear-then-write), records the single rich
// routing_decisions row via RoutingService.recordDecision, then calls
// set_entity_assignment WITHOUT `reason`. The tenant-validation guard
// (this spec's subject) still fires before the RPC. P1-4: the entry
// gate is now `assertCanPlan` (was `assertVisible('write')`).

import { TicketService } from './ticket.service';

const TENANT = { id: 't1', subdomain: 't1' };
const TICKET_ID = 'ticket-1';

const VALID_TEAM = '00000000-0000-4000-8000-00000000aaaa';
const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';

type Row = Record<string, unknown>;

function makeSupabase(rowsByTable: Record<string, Row[]>) {
  const updateCalls: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; row: Row }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => {
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
    };
    return chain;
  }

  return {
    updateCalls,
    insertCalls,
    rpcCalls,
    supabase: {
      admin: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push({ fn, args });
          return { data: { noop: false }, error: null };
        },
        from: (table: string) => ({
          select: () => buildSelectChain(table),
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: null, error: null }),
              then: (onFulfilled: (v: { data: null; error: null }) => unknown) => {
                updateCalls.push({ table, patch });
                return Promise.resolve({ data: null, error: null }).then(onFulfilled);
              },
            }),
          }),
          insert: (row: Row) => {
            insertCalls.push({ table, row });
            return {
              select: () => ({
                single: async () => ({ data: { ...row, id: 'inserted-1' }, error: null }),
              }),
              then: (onFulfilled: (v: { data: null; error: null }) => unknown) =>
                Promise.resolve({ data: null, error: null }).then(onFulfilled),
            };
          },
        }),
      },
    },
  };
}

describe('TicketService.reassign(rerun_resolver=true) — Plan A.2 tenant validation', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects when the routing resolver returns a cross-tenant team_id', async () => {
    // The routing tables are tenant-scoped, but the resolver result is a
    // structured payload — defense-in-depth requires re-validating the
    // returned id before propagating. Simulates a routing rule import or
    // test-time override that points at a foreign team.

    const deps = makeSupabase({
      // Resolver returned FOREIGN_TEAM; teams table only has it under
      // another tenant → validateAssigneesInTenant rejects.
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });

    // Stub out everything except the resolver-rerun branch.
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        person_id: 'p-1',
        tenant_id: TENANT.id,
        has_read_all: false,
        has_write_all: true,
        has_admin: false,
      }),
      // P1-4: reassign now gates on the planning floor, not write.
      assertCanPlan: jest.fn().mockResolvedValue(undefined),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };

    const routingService = {
      evaluate: jest.fn().mockResolvedValue({
        target: { kind: 'team', team_id: FOREIGN_TEAM },
        chosen_by: 'request_type_default',
        rule_id: null,
        rule_name: null,
        strategy: 'fixed',
        trace: [],
      }),
      recordDecision: jest.fn().mockResolvedValue(undefined),
    };

    // Constructor order (ticket.service.ts:177-185):
    //   supabase, routing, sla, workflow, approval, visibility, scopeOverrides
    const svc = new TicketService(
      deps.supabase as never,
      routingService as never,
      {} as never, // sla
      {} as never, // workflow
      {} as never, // approval
      visibility as never,
      {} as never, // scopeOverrides
    );

    // Stub getById to return the current case state.
    jest
      .spyOn(svc, 'getById')
      .mockResolvedValue({
        id: TICKET_ID,
        tenant_id: TENANT.id,
        ticket_kind: 'case',
        ticket_type_id: null,
        location_id: null,
        asset_id: null,
        priority: 'medium',
        assigned_team_id: VALID_TEAM,
        assigned_user_id: null,
        assigned_vendor_id: null,
        status_category: 'assigned',
      } as never);

    // Stub addActivity (called once after the routing-decision insert).
    jest.spyOn(svc, 'addActivity').mockResolvedValue(undefined as never);

    let caught: unknown = null;
    try {
      await svc.reassign(
        TICKET_ID,
        {
          rerun_resolver: true,
          reason: 'try again',
          actor_person_id: 'p-1',
        },
        'auth-uid',
        'crid-rerun-1',
      );
    } catch (e) {
      caught = e;
    }
    // The validator throws BadRequestException — message names the field
    // since validateAssigneesInTenant uses its own error wording.
    expect(caught).toBeTruthy();
    expect((caught as Error).message).toEqual(
      expect.stringContaining('assigned_team_id'),
    );
  });

  it('happy path: RPC called WITHOUT reason, recordDecision AFTER the RPC with {reason,actor} (audit-02 P1-1 FORK-1a)', async () => {
    const deps = makeSupabase({
      teams: [{ id: VALID_TEAM, tenant_id: TENANT.id }],
    });

    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        person_id: 'p-1',
        tenant_id: TENANT.id,
        has_read_all: false,
        has_write_all: true,
        has_admin: false,
      }),
      assertCanPlan: jest.fn().mockResolvedValue(undefined),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };

    // recordDecision captures how many RPC calls had already happened at
    // its invocation time — proves it runs AFTER set_entity_assignment.
    let rpcCountWhenRecordDecisionCalled = -1;
    const routingService = {
      evaluate: jest.fn().mockResolvedValue({
        target: { kind: 'team', team_id: VALID_TEAM },
        chosen_by: 'request_type_default',
        rule_id: null,
        rule_name: null,
        strategy: 'fixed',
        trace: [],
      }),
      recordDecision: jest.fn().mockImplementation(async () => {
        rpcCountWhenRecordDecisionCalled = deps.rpcCalls.length;
      }),
    };

    const svc = new TicketService(
      deps.supabase as never,
      routingService as never,
      {} as never,
      {} as never,
      {} as never,
      visibility as never,
      {} as never,
    );

    jest.spyOn(svc, 'getById').mockResolvedValue({
      id: TICKET_ID,
      tenant_id: TENANT.id,
      ticket_kind: 'case',
      ticket_type_id: null,
      location_id: null,
      asset_id: null,
      priority: 'medium',
      assigned_team_id: null,
      assigned_user_id: 'u-old',
      assigned_vendor_id: null,
      status_category: 'assigned',
    } as never);
    jest.spyOn(svc, 'addActivity').mockResolvedValue(undefined as never);

    await svc.reassign(
      TICKET_ID,
      { rerun_resolver: true, reason: 'try again', actor_person_id: 'p-1' },
      'auth-uid',
      'crid-rerun-2',
    );

    // Exactly one set_entity_assignment RPC, kind=case, idempotency key
    // shaped reassign:case:<id>:<crid>, payload carries the resolved
    // assignee but NO `reason` (FORK-1a: reason is suppressed from the RPC
    // so it does not write a duplicate `manual` routing_decisions row).
    const sea = deps.rpcCalls.filter((c) => c.fn === 'set_entity_assignment');
    expect(sea).toHaveLength(1);
    expect(sea[0].args.p_entity_kind).toBe('case');
    expect(sea[0].args.p_idempotency_key).toBe(
      `reassign:case:${TICKET_ID}:crid-rerun-2`,
    );
    const payload = sea[0].args.p_payload as Record<string, unknown>;
    expect(payload.assigned_team_id).toBe(VALID_TEAM);
    expect(payload.assigned_user_id).toBeNull();
    expect('reason' in payload).toBe(false);

    // recordDecision: exactly once, AFTER the RPC, with the human reason
    // + actor under the SAME keys the RPC's manual path uses.
    expect(routingService.recordDecision).toHaveBeenCalledTimes(1);
    expect(rpcCountWhenRecordDecisionCalled).toBeGreaterThanOrEqual(1);
    const rdArgs = routingService.recordDecision.mock.calls[0];
    expect(rdArgs[3]).toEqual({ reason: 'try again', actor: 'p-1' });

    // No duplicate routing_decisions written directly from TS.
    expect(
      deps.insertCalls.filter((c) => c.table === 'routing_decisions'),
    ).toHaveLength(0);
  });

  it('audit-02 D-A02-4: command_operations success-probe short-circuits the rerun_resolver path BEFORE the resolver + RPC (no payload_mismatch poison on retry)', async () => {
    // A prior request under the SAME crid already committed
    // (command_operations success). A retry must NOT re-run the resolver
    // (which could re-pick a drifted target if routing config changed) and
    // must NOT re-call set_entity_assignment with a recomputed payload —
    // that's the payload_mismatch poison D-A02-4 closes. It returns the
    // contracted getById shape instead.
    const deps = makeSupabase({
      command_operations: [
        {
          tenant_id: TENANT.id,
          idempotency_key: `reassign:case:${TICKET_ID}:crid-rerun-3`,
          outcome: 'success',
          cached_result: { noop: false },
        },
      ],
      teams: [{ id: VALID_TEAM, tenant_id: TENANT.id }],
    });

    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: 'u-1',
        person_id: 'p-1',
        tenant_id: TENANT.id,
        has_read_all: false,
        has_write_all: true,
        has_admin: false,
      }),
      assertCanPlan: jest.fn().mockResolvedValue(undefined),
      assertVisible: jest.fn().mockResolvedValue(undefined),
    };

    const routingService = {
      evaluate: jest.fn(),
      recordDecision: jest.fn(),
    };

    const svc = new TicketService(
      deps.supabase as never,
      routingService as never,
      {} as never,
      {} as never,
      {} as never,
      visibility as never,
      {} as never,
    );

    jest.spyOn(svc, 'getById').mockResolvedValue({
      id: TICKET_ID,
      tenant_id: TENANT.id,
      ticket_kind: 'case',
      assigned_team_id: VALID_TEAM,
      assigned_user_id: null,
      assigned_vendor_id: null,
      status_category: 'assigned',
    } as never);
    const addActivitySpy = jest
      .spyOn(svc, 'addActivity')
      .mockResolvedValue(undefined as never);

    const result = await svc.reassign(
      TICKET_ID,
      { rerun_resolver: true, reason: 'retry', actor_person_id: 'p-1' },
      'auth-uid',
      'crid-rerun-3',
    );

    // Short-circuited: resolver NOT re-run, RPC NOT re-called,
    // recordDecision NOT re-run, no second activity — no recompute, no
    // payload_mismatch. Contracted getById shape still returned.
    expect(routingService.evaluate).not.toHaveBeenCalled();
    expect(routingService.recordDecision).not.toHaveBeenCalled();
    expect(addActivitySpy).not.toHaveBeenCalled();
    expect(
      deps.rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
    ).toHaveLength(0);
    expect((result as { id: string }).id).toBe(TICKET_ID);
  });
});
