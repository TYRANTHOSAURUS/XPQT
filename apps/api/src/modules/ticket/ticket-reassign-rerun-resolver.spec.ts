// TicketService.reassign — audit02 Slice C (P1-1) + Plan A.2 / Commit 4
// post-resolver tenant validation.
//
// Slice C: both reassign branches commit through the canonical
// `set_entity_assignment` v3 RPC (00416) in ONE transaction.
//
//   - MANUAL (no rerun_resolver): p_payload carries the dto target +
//     `reason` + `actor_person_id` and NO `decision` key — v3's
//     reason-gated branch writes the manual routing_decisions row
//     (strategy='manual'/chosen_by='manual_reassign') itself.
//   - RERUN_RESOLVER: `routingService.evaluate(ctx)` is called exactly
//     ONCE (NO pre-clear of the assignment columns), and the result is
//     mapped into a `decision` object (identity map — RoutingEvaluation
//     strategy/chosen_by are byte-identical to v3's allowlist). v3 writes
//     the routing_decisions row from THAT provenance.
//
// In both cases there is NO raw `.from('tickets').update`, NO standalone
// `routing_decisions.insert`, and NO standalone `addActivity` for the
// reassignment. The ticket is NEVER written to an all-null transient
// state (the legacy clear-then-rerun left it permanently unassigned on a
// mid-resolver crash).
//
// Plan A.2 / Commit 4: even though routing tables are tenant-scoped, the
// resolver returns a structured payload — we re-validate the returned id
// before propagating it into the v3 payload.

import { TicketService } from './ticket.service';
import { buildReassignIdempotencyKey } from '@prequest/shared';

const TENANT = { id: 't1', subdomain: 't1' };
const TICKET_ID = 'ticket-1';
const CRID = 'crid-case-1';

const VALID_TEAM = '00000000-0000-4000-8000-00000000aaaa';
const FOREIGN_TEAM = '00000000-0000-4000-8000-0000000fffff';
const NEW_TEAM = '00000000-0000-4000-8000-00000000bbbb';

type Row = Record<string, unknown>;
type RpcCall = { fn: string; args: Record<string, unknown> };

function makeSupabase(rowsByTable: Record<string, Row[]>) {
  const updateCalls: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; row: Row }> = [];
  const rpcCalls: RpcCall[] = [];

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
          // A raw tickets/work_orders UPDATE for the reassignment is a
          // Slice C regression — v3 owns the write.
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

function makeSvc(
  deps: ReturnType<typeof makeSupabase>,
  routingService: unknown,
) {
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u-1',
      person_id: 'p-1',
      tenant_id: TENANT.id,
      has_read_all: false,
      has_write_all: true,
      has_admin: false,
    }),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  // Constructor order (ticket.service.ts:213-227):
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
  return { svc, visibility };
}

function assignCalls(rpcCalls: RpcCall[]) {
  return rpcCalls.filter((c) => c.fn === 'set_entity_assignment');
}

describe('TicketService.reassign — audit02 Slice C (P1-1)', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue(TENANT);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('manual reassign routes through ONE set_entity_assignment v3 call with reason + actor + NO decision, no raw/standalone writes', async () => {
    const deps = makeSupabase({});
    const routingService = {
      evaluate: jest.fn(),
      recordDecision: jest.fn(),
    };
    const { svc } = makeSvc(deps, routingService);

    jest.spyOn(svc, 'getById').mockResolvedValue({
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
    const addActivitySpy = jest
      .spyOn(svc, 'addActivity')
      .mockResolvedValue(undefined as never);

    await svc.reassign(
      TICKET_ID,
      {
        assigned_team_id: NEW_TEAM,
        reason: 'team handover',
        actor_person_id: 'p-actor',
      },
      'auth-uid',
      CRID,
    );

    // evaluate() NOT called on the manual path.
    expect(routingService.evaluate).not.toHaveBeenCalled();
    expect(routingService.recordDecision).not.toHaveBeenCalled();

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args.p_entity_id).toBe(TICKET_ID);
    expect(args.p_entity_kind).toBe('case');
    expect(args.p_tenant_id).toBe(TENANT.id);
    expect(args.p_actor_user_id).toBe('auth-uid');
    expect(args.p_idempotency_key).toBe(
      buildReassignIdempotencyKey('case', TICKET_ID, CRID),
    );
    const payload = args.p_payload as Record<string, unknown>;
    expect(payload.assigned_team_id).toBe(NEW_TEAM);
    expect(payload.assigned_user_id).toBeNull();
    expect(payload.assigned_vendor_id).toBeNull();
    expect(payload.reason).toBe('team handover');
    expect(payload.actor_person_id).toBe('p-actor');
    // Manual reassign passes NO decision — v3 audits it with the
    // hardcoded manual provenance.
    expect(payload).not.toHaveProperty('decision');

    // No raw tickets UPDATE, no standalone routing_decisions insert, no
    // standalone addActivity for the reassignment.
    expect(deps.updateCalls).toHaveLength(0);
    expect(
      deps.insertCalls.filter((c) => c.table === 'routing_decisions'),
    ).toHaveLength(0);
    expect(addActivitySpy).not.toHaveBeenCalled();
  });

  it('rerun_resolver calls evaluate ONCE, passes a decision built from the result, and never pre-clears the assignment columns', async () => {
    const deps = makeSupabase({
      teams: [{ id: NEW_TEAM, tenant_id: TENANT.id }],
    });
    const evalResult = {
      target: { kind: 'team', team_id: NEW_TEAM },
      chosen_by: 'request_type_default',
      rule_id: null,
      rule_name: null,
      strategy: 'fixed',
      trace: [{ step: 'request_type_default', matched: true, reason: 'rt default', target: null }],
    };
    const routingService = {
      evaluate: jest.fn().mockResolvedValue(evalResult),
      recordDecision: jest.fn(),
    };
    const { svc } = makeSvc(deps, routingService);

    jest.spyOn(svc, 'getById').mockResolvedValue({
      id: TICKET_ID,
      tenant_id: TENANT.id,
      ticket_kind: 'case',
      ticket_type_id: null,
      location_id: 'loc-1',
      asset_id: null,
      priority: 'high',
      assigned_team_id: VALID_TEAM,
      assigned_user_id: null,
      assigned_vendor_id: null,
      status_category: 'assigned',
    } as never);
    jest.spyOn(svc, 'addActivity').mockResolvedValue(undefined as never);

    await svc.reassign(
      TICKET_ID,
      { rerun_resolver: true, reason: 'try again', actor_person_id: 'p-1' },
      'auth-uid',
      CRID,
    );

    // evaluate called EXACTLY once. recordDecision NOT called (v3 owns
    // the audit row now).
    expect(routingService.evaluate).toHaveBeenCalledTimes(1);
    expect(routingService.recordDecision).not.toHaveBeenCalled();

    // NO pre-clear raw update of the assignment columns — the ticket is
    // never written to an all-null transient state.
    expect(deps.updateCalls).toHaveLength(0);

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const payload = calls[0].args.p_payload as Record<string, unknown>;
    expect(payload.assigned_team_id).toBe(NEW_TEAM);
    expect(payload.reason).toBe('try again');

    // decision is built from the evaluation — identity map (strategy /
    // chosen_by are byte-identical to v3's allowlist).
    const decision = payload.decision as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.strategy).toBe('fixed');
    expect(decision.chosen_by).toBe('request_type_default');
    expect(decision.rule_id).toBeNull();
    expect(decision.trace).toEqual(evalResult.trace);
    expect(decision.context).toMatchObject({
      request_type_id: null,
      domain: null,
      priority: 'high',
      asset_id: null,
      location_id: 'loc-1',
    });
    // strategy/chosen_by must be inside v3's allowlist.
    expect(['asset', 'location', 'fixed', 'auto', 'rule']).toContain(
      decision.strategy,
    );
    expect([
      'rule', 'asset_override', 'asset_type_default', 'location_team',
      'parent_location_team', 'space_group_team', 'domain_fallback',
      'request_type_default', 'scope_override', 'scope_override_unassigned',
      'policy_row', 'policy_default', 'unassigned',
    ]).toContain(decision.chosen_by);

    // No standalone routing_decisions / addActivity for the reassignment.
    expect(
      deps.insertCalls.filter((c) => c.table === 'routing_decisions'),
    ).toHaveLength(0);
  });

  it('rejects when the routing resolver returns a cross-tenant team_id (Plan A.2 — before the v3 write)', async () => {
    const deps = makeSupabase({
      // Resolver returned FOREIGN_TEAM; teams table only has it under
      // another tenant → validateAssigneesInTenant rejects.
      teams: [{ id: FOREIGN_TEAM, tenant_id: 'other-tenant' }],
    });
    const routingService = {
      evaluate: jest.fn().mockResolvedValue({
        target: { kind: 'team', team_id: FOREIGN_TEAM },
        chosen_by: 'request_type_default',
        rule_id: null,
        rule_name: null,
        strategy: 'fixed',
        trace: [],
      }),
      recordDecision: jest.fn(),
    };
    const { svc } = makeSvc(deps, routingService);

    jest.spyOn(svc, 'getById').mockResolvedValue({
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
    jest.spyOn(svc, 'addActivity').mockResolvedValue(undefined as never);

    let caught: unknown = null;
    try {
      await svc.reassign(
        TICKET_ID,
        { rerun_resolver: true, reason: 'try again', actor_person_id: 'p-1' },
        'auth-uid',
        CRID,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error).message).toEqual(
      expect.stringContaining('assigned_team_id'),
    );
    // Rejected BEFORE the v3 write — no set_entity_assignment fired.
    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
    expect(deps.updateCalls).toHaveLength(0);
  });

  it('hard-fails when clientRequestId is missing (crid is the idempotency seed)', async () => {
    const deps = makeSupabase({});
    const routingService = { evaluate: jest.fn(), recordDecision: jest.fn() };
    const { svc } = makeSvc(deps, routingService);

    jest.spyOn(svc, 'getById').mockResolvedValue({
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

    await expect(
      svc.reassign(
        TICKET_ID,
        { assigned_team_id: NEW_TEAM, reason: 'handover' },
        'auth-uid',
        // no crid
      ),
    ).rejects.toThrow(/X-Client-Request-Id/);

    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
  });
});
