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
const NEW_USER = '00000000-0000-4000-8000-00000000cccc';
const NEW_VENDOR = '00000000-0000-4000-8000-00000000dddd';

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
    // D-A02-2: decision carries the resolver's chosen target ids
    // (recordDecision idiom — routing.service.ts:71-73). team target ⇒
    // chosen_team_id set, the other two null.
    expect(decision.chosen_team_id).toBe(NEW_TEAM);
    expect(decision.chosen_user_id).toBeNull();
    expect(decision.chosen_vendor_id).toBeNull();
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

  // ── Target-kind mapping coverage (the silent-mis-assign class) ───────
  // The happy-path test above only exercises target.kind:'team'. The
  // user / vendor / null-target → p_payload mapping
  // (ticket.service.ts:1345-1347 + 1402-1404) is correct by inspection
  // but unprotected: a future edit swapping the assigned_user_id ↔
  // assigned_vendor_id line, or making the resolver-unassigned outcome
  // omit a key instead of sending an explicit null, would pass the whole
  // suite. These pin the exact per-kind payload contract.

  it('rerun_resolver → user target maps to p_payload.assigned_user_id with team/vendor explicitly null (no pre-clear, evaluate once)', async () => {
    const deps = makeSupabase({
      users: [{ id: NEW_USER, tenant_id: TENANT.id }],
    });
    const evalResult = {
      target: { kind: 'user', user_id: NEW_USER },
      chosen_by: 'rule',
      rule_id: 'rule-77',
      rule_name: 'route-to-user',
      strategy: 'rule',
      trace: [{ step: 'rule', matched: true, reason: 'rule 77', target: null }],
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
      { rerun_resolver: true, reason: 'route to user', actor_person_id: 'p-1' },
      'auth-uid',
      CRID,
    );

    expect(routingService.evaluate).toHaveBeenCalledTimes(1);
    // No pre-clear raw update — ticket never in an all-null transient.
    expect(deps.updateCalls).toHaveLength(0);

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const payload = calls[0].args.p_payload as Record<string, unknown>;
    expect(payload.assigned_user_id).toBe(NEW_USER);
    expect(payload.assigned_team_id).toBeNull();
    expect(payload.assigned_vendor_id).toBeNull();
    expect(payload.reason).toBe('route to user');

    // decision still passed through from the evaluation.
    const decision = payload.decision as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.strategy).toBe('rule');
    expect(decision.chosen_by).toBe('rule');
    expect(decision.rule_id).toBe('rule-77');
    // D-A02-2: user target ⇒ chosen_user_id set, team/vendor null.
    expect(decision.chosen_user_id).toBe(NEW_USER);
    expect(decision.chosen_team_id).toBeNull();
    expect(decision.chosen_vendor_id).toBeNull();

    expect(
      deps.insertCalls.filter((c) => c.table === 'routing_decisions'),
    ).toHaveLength(0);
  });

  it('rerun_resolver → vendor target maps to p_payload.assigned_vendor_id with team/user explicitly null', async () => {
    const deps = makeSupabase({
      vendors: [{ id: NEW_VENDOR, tenant_id: TENANT.id }],
    });
    const evalResult = {
      target: { kind: 'vendor', vendor_id: NEW_VENDOR },
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
      { rerun_resolver: true, reason: 'route to vendor', actor_person_id: 'p-1' },
      'auth-uid',
      CRID,
    );

    expect(routingService.evaluate).toHaveBeenCalledTimes(1);
    expect(deps.updateCalls).toHaveLength(0);

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const payload = calls[0].args.p_payload as Record<string, unknown>;
    expect(payload.assigned_vendor_id).toBe(NEW_VENDOR);
    expect(payload.assigned_team_id).toBeNull();
    expect(payload.assigned_user_id).toBeNull();
    expect(payload.reason).toBe('route to vendor');

    const decision = payload.decision as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.strategy).toBe('fixed');
    expect(decision.chosen_by).toBe('request_type_default');
    // D-A02-2: vendor target ⇒ chosen_vendor_id set, team/user null.
    expect(decision.chosen_vendor_id).toBe(NEW_VENDOR);
    expect(decision.chosen_team_id).toBeNull();
    expect(decision.chosen_user_id).toBeNull();

    expect(
      deps.insertCalls.filter((c) => c.table === 'routing_decisions'),
    ).toHaveLength(0);
  });

  it('rerun_resolver → resolver-unassigned (target:null) sends ALL THREE assignment keys PRESENT and each null (00416 key-present-null ⇒ clears; key-omitted ⇒ no-op)', async () => {
    const deps = makeSupabase({});
    // Resolver matched nothing → RoutingEvaluation.target is null. The
    // unassigned outcome MUST clear via key-present-with-null, NOT by
    // omitting the keys: 00416:218-220 treats `p_payload ? 'assigned_*'`
    // as the clear directive (00416:255-257 → key-absent = "no change",
    // key-present-null = "clear"). Omitting keys would silently leave
    // the prior assignment intact.
    const evalResult = {
      target: null,
      chosen_by: 'unassigned',
      rule_id: null,
      rule_name: null,
      strategy: 'auto',
      trace: [{ step: 'unassigned', matched: false, reason: 'no rule', target: null }],
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
      { rerun_resolver: true, reason: 'resolver unassigned', actor_person_id: 'p-1' },
      'auth-uid',
      CRID,
    );

    expect(routingService.evaluate).toHaveBeenCalledTimes(1);
    expect(deps.updateCalls).toHaveLength(0);

    const calls = assignCalls(deps.rpcCalls);
    expect(calls).toHaveLength(1);
    const payload = calls[0].args.p_payload as Record<string, unknown>;
    // ALL THREE keys must be PRESENT (own-property), each value null —
    // this is the clear contract per 00416. `toBeNull()` alone would
    // also pass for an omitted key (undefined !== null but the
    // assertions below pin presence explicitly).
    expect(Object.prototype.hasOwnProperty.call(payload, 'assigned_team_id')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload, 'assigned_user_id')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload, 'assigned_vendor_id')).toBe(true);
    expect(payload.assigned_team_id).toBeNull();
    expect(payload.assigned_user_id).toBeNull();
    expect(payload.assigned_vendor_id).toBeNull();
    expect(payload.reason).toBe('resolver unassigned');

    // decision still passes through (resolver-unassigned is still an
    // audited routing decision — chosen_by:'unassigned').
    const decision = payload.decision as Record<string, unknown>;
    expect(decision).toBeDefined();
    expect(decision.chosen_by).toBe('unassigned');
    expect(decision.strategy).toBe('auto');
    // D-A02-2: result.target=null ⇒ ALL THREE chosen_* null (the resolver
    // chose nobody — provenance must NOT reflect the prior assignment).
    expect(decision.chosen_team_id).toBeNull();
    expect(decision.chosen_user_id).toBeNull();
    expect(decision.chosen_vendor_id).toBeNull();

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

  // ── audit02 CR2 / D-A02-4 — command_operations success-probe ─────────
  // The reassign key `reassign:case:<id>:<crid>` is stable. A retried
  // request with the SAME crid that re-evaluates the resolver before the
  // RPC can hit `payload_mismatch` if routing/ticket state drifted
  // between the original and the retry. Fix: probe command_operations for
  // a `success` row under the stable key BEFORE re-evaluating; if present
  // the canonical write already committed → return the contracted result
  // (getById) WITHOUT re-evaluating / re-calling the RPC.

  it('rerun_resolver retry with a committed command_operations success row: NO evaluate, NO RPC, returns getById result', async () => {
    const crid = 'crid-case-retry';
    const key = buildReassignIdempotencyKey('case', TICKET_ID, crid);
    const deps = makeSupabase({
      command_operations: [
        {
          tenant_id: TENANT.id,
          idempotency_key: key,
          outcome: 'success',
          cached_result: { noop: false },
        },
      ],
    });
    const routingService = {
      evaluate: jest.fn(),
      recordDecision: jest.fn(),
    };
    const { svc } = makeSvc(deps, routingService);

    const ticketRow = {
      id: TICKET_ID,
      tenant_id: TENANT.id,
      ticket_kind: 'case',
      ticket_type_id: null,
      location_id: null,
      asset_id: null,
      priority: 'medium',
      assigned_team_id: NEW_TEAM,
      assigned_user_id: null,
      assigned_vendor_id: null,
      status_category: 'assigned',
    };
    const getByIdSpy = jest
      .spyOn(svc, 'getById')
      .mockResolvedValue(ticketRow as never);

    const result = await svc.reassign(
      TICKET_ID,
      { rerun_resolver: true, reason: 'retry same crid', actor_person_id: 'p-1' },
      'auth-uid',
      crid,
    );

    // Resolver NOT re-run, RPC NOT re-called — the write already committed.
    expect(routingService.evaluate).not.toHaveBeenCalled();
    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
    // Contracted return shape preserved (getById, the original return).
    expect(result).toMatchObject({ id: TICKET_ID });
    // getById was used to produce the return (the visibility-gated
    // pre-read + the final return both call it; the final return is what
    // matters for the contract).
    expect(getByIdSpy).toHaveBeenCalled();
  });

  it('manual reassign retry with a committed command_operations success row: NO RPC, returns getById result', async () => {
    const crid = 'crid-case-manual-retry';
    const key = buildReassignIdempotencyKey('case', TICKET_ID, crid);
    const deps = makeSupabase({
      command_operations: [
        {
          tenant_id: TENANT.id,
          idempotency_key: key,
          outcome: 'success',
          cached_result: { noop: false },
        },
      ],
    });
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
      assigned_team_id: NEW_TEAM,
      assigned_user_id: null,
      assigned_vendor_id: null,
      status_category: 'assigned',
    } as never);

    const result = await svc.reassign(
      TICKET_ID,
      { assigned_team_id: NEW_TEAM, reason: 'manual retry', actor_person_id: 'p-1' },
      'auth-uid',
      crid,
    );

    expect(assignCalls(deps.rpcCalls)).toHaveLength(0);
    expect(result).toMatchObject({ id: TICKET_ID });
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
