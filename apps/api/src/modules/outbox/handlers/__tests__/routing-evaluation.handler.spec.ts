import {
  RoutingEvaluationHandler,
  type RoutingEvaluationRequiredPayload,
} from '../routing-evaluation.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { RoutingService } from '../../../routing/routing.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * B.2.A.Step11 — `RoutingEvaluationHandler.handle` tests.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 lines 2783-2786 +
 *       §3.10 step 10 (emitter — reclassify_ticket) + §3.9.2
 *       (routing_status state machine).
 *
 * Flow under test:
 *   1. tenant_id smuggling defense
 *   2. Re-read tickets row (terminal no-op on missing)
 *   3. Load request_type.domain
 *   4. Call RoutingService.evaluate
 *   5. set_entity_assignment ALWAYS called on non-failure paths
 *      (audit-02 P1-2): assignee keys included only when a new target
 *      applies; clear_routing_status:true always — the routing_status
 *      clear is folded into the RPC's atomic tx (no raw post-RPC update)
 *   6. Always insert routing_decisions audit row (entity_kind/case_id
 *      set explicitly — P2-2 tail, handler is case-only)
 *   7. tickets.routing_status='failed' on error (markRoutingFailure);
 *      the 'idle' clear is inside the RPC, not a separate update
 */

const TENANT_ID = 'e1111111-1111-4111-8111-111111111111';
const EVENT_ID = 'e2222222-2222-4222-8222-222222222222';
const TICKET_ID = 'e3333333-3333-4333-8333-333333333333';
const REQUEST_TYPE_ID = 'e4444444-4444-4444-8444-444444444444';
const TEAM_ID = 'e5555555-5555-4555-8555-555555555555';
const OTHER_TEAM_ID = 'e6666666-6666-4666-8666-666666666666';

function makeEvent(
  overrides: Partial<OutboxEvent<RoutingEvaluationRequiredPayload>> = {},
  payloadOverrides: Partial<RoutingEvaluationRequiredPayload> = {},
): OutboxEvent<RoutingEvaluationRequiredPayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'routing.evaluation_required',
    event_version: 1,
    aggregate_type: 'ticket',
    aggregate_id: TICKET_ID,
    payload: {
      tenant_id: TENANT_ID,
      ticket_id: TICKET_ID,
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: 'routing.evaluation_required:' + TICKET_ID + ':reclassify',
    enqueued_at: '2026-05-11T11:59:00Z',
    available_at: '2026-05-11T11:59:00Z',
    processed_at: null,
    processed_reason: null,
    claim_token: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
    dead_lettered_at: null,
    ...overrides,
  };
}

interface TicketRow {
  id: string;
  tenant_id: string;
  ticket_type_id: string | null;
  location_id: string | null;
  asset_id: string | null;
  priority: string | null;
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  routing_status: string;
}

interface FakeSupabaseOpts {
  ticketRow?: TicketRow | null;
  ticketError?: { message: string };
  requestTypeRow?: { domain: string | null } | null;
  rpcResponse?: unknown;
  rpcError?: { code?: string; message: string };
  // audit-02 D-A02-4: the command_operations success-probe. Default
  // (undefined) → no row → probe returns null → handler proceeds to
  // re-evaluate exactly as before (every pre-existing test relies on
  // this default — zero behaviour change for them). A row with
  // outcome='success' short-circuits; 'in_progress' falls through.
  commandOpRow?: { outcome: string; cached_result: unknown } | null;
  commandOpError?: { message: string };
}

interface CapturedCalls {
  fromTables: string[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
  inserts: Array<{ table: string; row: unknown }>;
  updates: Array<{ table: string; patch: unknown }>;
  // audit-02 D-A02-4: the .eq() filters the success-probe applied, so
  // tests can assert it is tenant-scoped (tenant_id + idempotency_key).
  commandOpProbes: Array<Record<string, unknown>>;
}

/**
 * audit-02 Code-I1: the routing_decisions audit inserts moved from
 * supabase-js (`this.supabase.admin.from('routing_decisions').insert`) to a
 * raw parameterised insert via the injected DbService
 * (`this.db.query(sql, params)`) so the handler can append an
 * `ON CONFLICT ... DO NOTHING` matching the 00429 partial unique index.
 *
 * FakeDb reconstructs the inserted row from the positional `$1..$12`
 * params (mirroring the production column order) and pushes it into the
 * SAME `captured.inserts` array the supabase-js mock used — so every
 * existing routing_decisions assertion below keeps working unchanged. The
 * `rowsToReturn` knob simulates the ON CONFLICT outcome: a non-empty array
 * = inserted (rowCount 1), `[]` = conflict-skipped (idempotent replay).
 * `throwError` simulates a genuine DB error to exercise the preserved
 * throw (Site 1) / warn-only (Site 2) error semantics.
 */
interface FakeDbOpts {
  rowsToReturn?: { id: string }[];
  throwError?: string;
}

function makeDb(captured: CapturedCalls, opts: FakeDbOpts = {}) {
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (/insert\s+into\s+public\.routing_decisions/i.test(sql)) {
      // Reconstruct the row from positional params (production order:
      // tenant_id, ticket_id, entity_kind, case_id, strategy,
      // chosen_team_id, chosen_user_id, chosen_vendor_id, chosen_by,
      // rule_id, trace, context). trace/context arrive JSON-stringified
      // (the handler does JSON.stringify before the ::jsonb cast) — parse
      // them back so the existing object assertions keep working.
      const row = {
        tenant_id: params[0],
        ticket_id: params[1],
        entity_kind: params[2],
        case_id: params[3],
        strategy: params[4],
        chosen_team_id: params[5],
        chosen_user_id: params[6],
        chosen_vendor_id: params[7],
        chosen_by: params[8],
        rule_id: params[9],
        trace: JSON.parse(params[10] as string),
        context: JSON.parse(params[11] as string),
      };
      captured.inserts.push({ table: 'routing_decisions', row });
      if (opts.throwError) throw new Error(opts.throwError);
      return { rows: opts.rowsToReturn ?? [{ id: 'rd-1' }], rowCount: 0 };
    }
    throw new Error('unexpected db.query sql: ' + sql);
  });
  return { query } as never;
}

function makeSupabase(opts: FakeSupabaseOpts) {
  const captured: CapturedCalls = {
    fromTables: [],
    rpcCalls: [],
    inserts: [],
    updates: [],
    commandOpProbes: [],
  };

  const from = jest.fn((table: string) => {
    captured.fromTables.push(table);

    if (table === 'tickets') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.ticketRow ?? null,
                error: opts.ticketError ?? null,
              }),
            }),
          }),
        }),
        update: (patch: unknown) => {
          captured.updates.push({ table, patch });
          return {
            eq: () => ({
              eq: async () => ({ data: null, error: null }),
            }),
          };
        },
      };
    }
    if (table === 'request_types') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.requestTypeRow ?? null,
                error: null,
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'routing_decisions' || table === 'ticket_activities') {
      return {
        insert: async (row: unknown) => {
          captured.inserts.push({ table, row });
          return { data: null, error: null };
        },
      };
    }
    if (table === 'command_operations') {
      // audit-02 D-A02-4 success-probe:
      //   .select('outcome, cached_result').eq('tenant_id', t)
      //     .eq('idempotency_key', k).maybeSingle()
      const filters: Record<string, unknown> = {};
      const chain = {
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        maybeSingle: async () => {
          captured.commandOpProbes.push({ ...filters });
          return {
            data: opts.commandOpRow ?? null,
            error: opts.commandOpError ?? null,
          };
        },
      };
      return { select: () => chain };
    }
    throw new Error('unexpected table: ' + table);
  });

  const rpc = jest.fn(async (fn: string, args: unknown) => {
    captured.rpcCalls.push({ fn, args });
    if (opts.rpcError) return { data: null, error: opts.rpcError };
    return { data: opts.rpcResponse ?? null, error: null };
  });

  return {
    captured,
    service: { admin: { from, rpc } } as never,
  };
}

interface FakeRoutingOpts {
  target?: { kind: 'team'; team_id: string } | { kind: 'user'; user_id: string } | { kind: 'vendor'; vendor_id: string } | null;
  chosen_by?: string;
  throwError?: string;
}

function makeRoutingService(opts: FakeRoutingOpts = {}): RoutingService {
  return {
    evaluate: jest.fn(async () => {
      if (opts.throwError) throw new Error(opts.throwError);
      return {
        target: opts.target ?? null,
        chosen_by: opts.chosen_by ?? 'unassigned',
        rule_id: null,
        rule_name: null,
        strategy: opts.target ? opts.target.kind : 'auto',
        trace: [{ step: 'request_type_default', matched: false, reason: 'no default', target: null }],
      };
    }),
  } as unknown as RoutingService;
}

function baseTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: TICKET_ID,
    tenant_id: TENANT_ID,
    ticket_type_id: REQUEST_TYPE_ID,
    location_id: null,
    asset_id: null,
    priority: 'medium',
    assigned_team_id: null,
    assigned_user_id: null,
    assigned_vendor_id: null,
    routing_status: 'pending',
    ...overrides,
  };
}

describe('RoutingEvaluationHandler.handle (B.2.A.Step11 §3.9.3)', () => {
  describe('happy paths', () => {
    it('routes to a new team: calls set_entity_assignment (clear_routing_status folded in) + writes routing_decisions, NO raw tickets.update', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      expect(routing.evaluate).toHaveBeenCalledTimes(1);

      // set_entity_assignment RPC was called with the resolved team.
      const assignmentCalls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(assignmentCalls).toHaveLength(1);
      const args = assignmentCalls[0].args as {
        p_entity_id: string;
        p_entity_kind: string;
        p_payload: Record<string, unknown>;
        p_idempotency_key: string;
      };
      expect(args.p_entity_id).toBe(TICKET_ID);
      expect(args.p_entity_kind).toBe('case');
      expect(args.p_idempotency_key).toBe('routing-evaluation:' + EVENT_ID);
      expect(args.p_payload.assigned_team_id).toBe(TEAM_ID);
      expect(args.p_payload.assigned_user_id).toBeNull();
      expect(args.p_payload.assigned_vendor_id).toBeNull();
      // codex-S11-I2 remediation: handler does NOT pass `reason` —
      // doing so would trigger set_entity_assignment's manual-reassign
      // audit branch and write a duplicate routing_decisions row
      // classified as `manual_reassign`. The handler writes its own
      // resolver-audit row at step 6 with `chosen_by='rule'` (or whatever
      // the evaluation produced).
      expect(args.p_payload.reason).toBeUndefined();
      // audit-02 P1-2: routing_status clear is folded INTO the RPC tx via
      // the v3 opt-in flag — atomic with the assignment, no separate raw
      // post-RPC tickets.update.
      expect(args.p_payload.clear_routing_status).toBe(true);

      // routing_decisions row inserted.
      const decisionInserts = supabase.captured.inserts.filter(
        (i) => i.table === 'routing_decisions',
      );
      expect(decisionInserts).toHaveLength(1);
      const decision = decisionInserts[0].row as {
        chosen_team_id: string | null;
        chosen_by: string;
        context: { outbox_event_id: string };
      };
      expect(decision.chosen_team_id).toBe(TEAM_ID);
      expect(decision.chosen_by).toBe('rule');
      expect(decision.context.outbox_event_id).toBe(EVENT_ID);
      // P2-2 tail: entity_kind/case_id set explicitly (no derive-trigger
      // reliance at this case-only site).
      const decisionRow = decisionInserts[0].row as {
        entity_kind: string;
        case_id: string;
      };
      expect(decisionRow.entity_kind).toBe('case');
      expect(decisionRow.case_id).toBe(TICKET_ID);

      // audit-02 P1-2: NO raw post-RPC tickets.update — the clear is
      // folded into the atomic RPC tx (asserted via the payload flag).
      const ticketUpdates = supabase.captured.updates.filter((u) => u.table === 'tickets');
      expect(ticketUpdates).toHaveLength(0);
    });

    it('unassigned outcome: set_entity_assignment STILL called (clear_routing_status, assignee keys omitted so standing assignment preserved), routing_decisions row written (v5/I4)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({ target: null, chosen_by: 'unassigned' });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      // audit-02 P1-2: RPC is now ALWAYS called so routing_status clear is
      // atomic. Assignee keys are OMITTED (key-absent = "no change" in the
      // RPC) — an unassigned outcome must not wipe a standing assignee.
      const calls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(calls).toHaveLength(1);
      const payload = (calls[0].args as { p_payload: Record<string, unknown> })
        .p_payload;
      expect(payload.clear_routing_status).toBe(true);
      expect(payload).not.toHaveProperty('assigned_team_id');
      expect(payload).not.toHaveProperty('assigned_user_id');
      expect(payload).not.toHaveProperty('assigned_vendor_id');
      expect(
        supabase.captured.inserts.filter((i) => i.table === 'routing_decisions'),
      ).toHaveLength(1);
      // No raw tickets.update — clear folded into the RPC.
      expect(
        supabase.captured.updates.filter((u) => u.table === 'tickets'),
      ).toHaveLength(0);
    });

    it('target matches current assignee: set_entity_assignment STILL called (assignee keys omitted) so routing_status clear stays atomic, routing_decisions written', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket({ assigned_team_id: TEAM_ID }),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      // audit-02 P1-2: previously this path skipped the RPC and did a raw
      // tickets.update. Now the RPC is called WITHOUT assignee keys
      // (key-absent = no change) + clear_routing_status — the RPC's v3
      // no-op fast path is skipped because the flag is set, so the
      // routing_status clear is atomic even when assignees are unchanged.
      const calls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(calls).toHaveLength(1);
      const payload = (calls[0].args as { p_payload: Record<string, unknown> })
        .p_payload;
      expect(payload.clear_routing_status).toBe(true);
      expect(payload).not.toHaveProperty('assigned_team_id');
      expect(
        supabase.captured.inserts.filter((i) => i.table === 'routing_decisions'),
      ).toHaveLength(1);
      expect(
        supabase.captured.updates.filter((u) => u.table === 'tickets'),
      ).toHaveLength(0);
    });

    it('target differs from current (different team): set_entity_assignment fires', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket({ assigned_team_id: OTHER_TEAM_ID }),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      expect(
        supabase.captured.rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
      ).toHaveLength(1);
    });
  });

  describe('terminal no-ops', () => {
    it('returns void on ticket_not_found (hard-delete between emit + fire)', async () => {
      const supabase = makeSupabase({ ticketRow: null });
      const routing = makeRoutingService();
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(routing.evaluate).not.toHaveBeenCalled();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });
  });

  describe('terminal dead-letters', () => {
    it('dead-letters on tenant smuggling', async () => {
      const supabase = makeSupabase({});
      const routing = makeRoutingService();
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );
      const event = makeEvent({}, { tenant_id: 'f9999999-9999-4999-8999-999999999999' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.fromTables).not.toContain('tickets');
    });
  });

  describe('failure paths (record failure, return normally)', () => {
    it('resolver throws: marks routing_status=failed + writes activity breadcrumb + writes routing_decisions audit row (Step11 F-CRIT-2), does NOT throw', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({ throwError: 'rule_evaluation_crashed' });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const failureUpdate = supabase.captured.updates.find(
        (u) => u.table === 'tickets' && (u.patch as { routing_status: string }).routing_status === 'failed',
      );
      expect(failureUpdate).toBeDefined();
      expect(
        (failureUpdate!.patch as { routing_failure_reason: string }).routing_failure_reason,
      ).toMatch(/rule_evaluation_crashed/);
      // activity breadcrumb recorded.
      const activity = supabase.captured.inserts.find((i) => i.table === 'ticket_activities');
      expect(activity).toBeDefined();
      expect((activity!.row as { metadata: { event: string } }).metadata.event).toBe(
        'routing_evaluation_failed',
      );

      // Step11 F-CRIT-2: routing_decisions audit row written on the
      // failure path (mirroring the doc comment on markRoutingFailure).
      const decisionInserts = supabase.captured.inserts.filter(
        (i) => i.table === 'routing_decisions',
      );
      expect(decisionInserts).toHaveLength(1);
      const decision = decisionInserts[0].row as {
        tenant_id: string;
        ticket_id: string;
        chosen_by: string;
        chosen_team_id: string | null;
        chosen_user_id: string | null;
        chosen_vendor_id: string | null;
        strategy: string;
        context: { outbox_event_id: string; failure_reason: string };
      };
      expect(decision.tenant_id).toBe(TENANT_ID);
      expect(decision.ticket_id).toBe(TICKET_ID);
      expect(decision.chosen_by).toBe('auto_routing_failed');
      expect(decision.chosen_team_id).toBeNull();
      expect(decision.chosen_user_id).toBeNull();
      expect(decision.chosen_vendor_id).toBeNull();
      expect(decision.strategy).toBe('failed');
      expect(decision.context.outbox_event_id).toBe(EVENT_ID);
      expect(decision.context.failure_reason).toMatch(/rule_evaluation_crashed/);
    });

    it('set_entity_assignment RPC error: marks routing_status=failed + writes activity breadcrumb + writes routing_decisions audit row (Step11 F-CRIT-2)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
        rpcError: { code: '42501', message: 'validate_assignees_in_tenant.assigned_team_id_not_in_tenant' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const failureUpdate = supabase.captured.updates.find(
        (u) => u.table === 'tickets' && (u.patch as { routing_status: string }).routing_status === 'failed',
      );
      expect(failureUpdate).toBeDefined();

      // Step11 F-CRIT-2: routing_decisions ROW written by markRoutingFailure
      // is the failure breadcrumb (chosen_by='auto_routing_failed'). This
      // is distinct from the success-path insert (which never fires here
      // because the assignment RPC failed before we reached the always-
      // insert success block). One failure row, never the success row.
      const decisionInserts = supabase.captured.inserts.filter(
        (i) => i.table === 'routing_decisions',
      );
      expect(decisionInserts).toHaveLength(1);
      const decision = decisionInserts[0].row as {
        chosen_by: string;
        strategy: string;
        context: { outbox_event_id: string; failure_reason: string };
      };
      expect(decision.chosen_by).toBe('auto_routing_failed');
      expect(decision.strategy).toBe('failed');
      expect(decision.context.failure_reason).toMatch(
        /validate_assignees_in_tenant\.assigned_team_id_not_in_tenant/,
      );
    });
  });

  describe('transient retries', () => {
    it('throws plain Error on tickets read wobble', async () => {
      const supabase = makeSupabase({ ticketError: { message: 'connection wobble' } });
      const routing = makeRoutingService();
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection wobble/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('audit-02 D-A02-4 — command_operations success-probe + retryable/terminal RPC-error split', () => {
    it('success-probe short-circuits BEFORE re-evaluate + RPC: log+return (outbox ACK), no resolver, no RPC, no audit insert', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
        // A prior delivery already committed under the stable key.
        commandOpRow: {
          outcome: 'success',
          cached_result: { entity_id: TICKET_ID, noop: false },
        },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      // Did NOT re-run the resolver, did NOT re-call the RPC, did NOT
      // re-insert the routing_decisions audit row — the poisoning
      // recompute never ran.
      expect(routing.evaluate).not.toHaveBeenCalled();
      expect(
        supabase.captured.rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
      ).toHaveLength(0);
      expect(
        supabase.captured.inserts.filter((i) => i.table === 'routing_decisions'),
      ).toHaveLength(0);
      // No failure was recorded — this is a genuine completed delivery.
      expect(
        supabase.captured.updates.filter(
          (u) =>
            u.table === 'tickets' &&
            (u.patch as { routing_status?: string }).routing_status === 'failed',
        ),
      ).toHaveLength(0);
    });

    it('success-probe is tenant-scoped (tenant_id + idempotency_key — the command_operations PK)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: null },
        commandOpRow: { outcome: 'success', cached_result: null },
      });
      const routing = makeRoutingService();
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await handler.handle(makeEvent());

      expect(supabase.captured.commandOpProbes).toHaveLength(1);
      expect(supabase.captured.commandOpProbes[0]).toEqual({
        tenant_id: TENANT_ID,
        idempotency_key: 'routing-evaluation:' + EVENT_ID,
      });
    });

    it("in_progress does NOT short-circuit — handler proceeds to re-evaluate + RPC (concurrent worker holds the key)", async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
        commandOpRow: { outcome: 'in_progress', cached_result: null },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      await handler.handle(makeEvent());

      expect(routing.evaluate).toHaveBeenCalledTimes(1);
      expect(
        supabase.captured.rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
      ).toHaveLength(1);
    });

    it('TRANSIENT RPC error (unknown.server_error): THROWS (outbox redelivers), does NOT markRoutingFailure, does NOT write routing_status=failed', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
        // Unparseable / unregistered message → mapRpcErrorToAppError
        // returns unknown.server_error → RETRYABLE.
        rpcError: { code: '08006', message: 'connection to server lost' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      const event = makeEvent();
      await expect(handler.handle(event)).rejects.toThrow(
        /routing_evaluation\.assignment_rpc_transient/,
      );
      // A non-DeadLetterError → the worker treats it as transient (retry).
      await expect(handler.handle(event)).rejects.not.toBeInstanceOf(
        DeadLetterError,
      );
      // Crucially: routing_status was NOT flipped to 'failed' for a
      // recoverable blip (the pre-fix bug terminally consumed the event).
      expect(
        supabase.captured.updates.filter(
          (u) =>
            u.table === 'tickets' &&
            (u.patch as { routing_status?: string }).routing_status === 'failed',
        ),
      ).toHaveLength(0);
    });

    it('TERMINAL RPC error (registered business/validation code): markRoutingFailure + return (event consumed) — unchanged contract', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
        // Registered <ns>.<spec> code → TERMINAL.
        rpcError: {
          code: 'P0001',
          message: 'command_operations.payload_mismatch',
        },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );

      // Returns normally (event consumed) — NOT thrown.
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      const failureUpdate = supabase.captured.updates.find(
        (u) =>
          u.table === 'tickets' &&
          (u.patch as { routing_status?: string }).routing_status === 'failed',
      );
      expect(failureUpdate).toBeDefined();
    });
  });

  describe('idempotency key shape', () => {
    it('derives p_idempotency_key from the event id', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: null },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured),
      );
      await handler.handle(makeEvent({ id: 'aaaaaaaa-1111-4111-8111-111111111111' }));
      const call = supabase.captured.rpcCalls.find((c) => c.fn === 'set_entity_assignment');
      const args = call!.args as { p_idempotency_key: string };
      expect(args.p_idempotency_key).toBe('routing-evaluation:aaaaaaaa-1111-4111-8111-111111111111');
    });
  });

  // ── audit-02 Code-I1 — outbox-redelivery idempotency ────────────────
  //
  // The routing_decisions audit insert now goes through a raw
  // `INSERT ... ON CONFLICT (tenant_id, (context->>'outbox_event_id'),
  // chosen_by) WHERE context ? 'outbox_event_id' DO NOTHING` (00429). On a
  // redelivered event the second insert is conflict-skipped (zero rows
  // returned). These tests pin the PRESERVED per-site error semantics plus
  // the ADDED conflict→success path.
  describe('Code-I1 outbox-redelivery idempotency', () => {
    it('Site 1 success path: conflict-skipped (0 rows) is treated as SUCCESS — does NOT throw, does NOT warn', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      // db returns [] → ON CONFLICT DO NOTHING skipped the row (replay).
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured, { rowsToReturn: [] }),
      );
      const warnSpy = jest.spyOn(
        (handler as never as { log: { warn: (m: string) => void } }).log,
        'warn',
      );
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      // The handler still attempted the insert (captured) but the conflict
      // skip is NOT escalated to a throw or a warn.
      expect(
        supabase.captured.inserts.filter((i) => i.table === 'routing_decisions'),
      ).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('Site 1 success path: a GENUINE db error still THROWS (preserved retry contract)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured, { throwError: 'connection reset by peer' }),
      );
      await expect(handler.handle(makeEvent())).rejects.toThrow(
        /audit_insert_failed.*connection reset by peer/,
      );
    });

    it('Site 2 markRoutingFailure: conflict-skipped (0 rows) is SILENT success — no throw, no warn', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({ throwError: 'rule_evaluation_crashed' });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured, { rowsToReturn: [] }),
      );
      const warnSpy = jest.spyOn(
        (handler as never as { log: { warn: (m: string) => void } }).log,
        'warn',
      );
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      // Failure breadcrumb insert attempted (the sentinel row), conflict
      // skip not warned.
      const fails = supabase.captured.inserts.filter(
        (i) =>
          i.table === 'routing_decisions' &&
          (i.row as { chosen_by: string }).chosen_by === 'auto_routing_failed',
      );
      expect(fails).toHaveLength(1);
      expect(
        warnSpy.mock.calls.filter((c) => /routing_decisions insert failed/.test(String(c[0]))),
      ).toHaveLength(0);
    });

    it('Site 2 markRoutingFailure: a GENUINE db error stays WARN-ONLY (does NOT throw — would wedge the outbox)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({ throwError: 'rule_evaluation_crashed' });
      const handler = new RoutingEvaluationHandler(
        supabase.service,
        routing,
        makeDb(supabase.captured, { throwError: 'pg pool exhausted' }),
      );
      const warnSpy = jest.spyOn(
        (handler as never as { log: { warn: (m: string) => void } }).log,
        'warn',
      );
      // Must NOT throw — the failure-recording path swallows insert errors.
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(
        warnSpy.mock.calls.some((c) =>
          /routing_decisions insert failed.*pg pool exhausted/.test(String(c[0])),
        ),
      ).toBe(true);
    });
  });
});
