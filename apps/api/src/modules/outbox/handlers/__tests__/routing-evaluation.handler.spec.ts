import {
  RoutingEvaluationHandler,
  type RoutingEvaluationRequiredPayload,
} from '../routing-evaluation.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { RoutingService } from '../../../routing/routing.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * audit02 Slice D (P1-2) + B.2.A.Step11 — `RoutingEvaluationHandler.handle` tests.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 lines 2783-2786 +
 *       §3.10 step 10 (emitter — reclassify_ticket) + §3.9.2
 *       (routing_status state machine).
 *       docs/follow-ups/audits/02-tickets-work-orders.md P1-2.
 *
 * audit02 Slice D changes (P1-2):
 *   • set_entity_assignment is ALWAYS called (all outcomes, all paths) with
 *     p_payload.clear_routing_status='true' + p_payload.decision — v3 owns
 *     both the routing_status clear and the routing_decisions row atomically.
 *   • The handler NO LONGER performs a standalone tickets.update({routing_status})
 *     call (the cross-tx window between assignment + status-clear is now
 *     structurally impossible — v3 commits both in one PG transaction).
 *   • The handler NO LONGER performs a standalone routing_decisions.insert
 *     in the success path — v3 writes it via the decision key.
 *   • p_entity_kind is hardcoded 'case' by contract (5 producers, all case-only:
 *     migrations 00354–00358). A non-case entity dead-letters immediately.
 *
 * Flow under test:
 *   1. tenant_id smuggling defense
 *   2. Re-read tickets row (terminal no-op on missing)
 *   3. Load request_type.domain
 *   4. Call RoutingService.evaluate
 *   5. set_entity_assignment ALWAYS (with clear_routing_status:'true' + decision)
 *   6. No standalone routing_decisions.insert in success path
 *   7. No standalone tickets.update({routing_status:'idle'}) in success path
 *   8. Non-case entity dead-letters immediately (fail-closed)
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
}

interface CapturedCalls {
  fromTables: string[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
  inserts: Array<{ table: string; row: unknown }>;
  updates: Array<{ table: string; patch: unknown }>;
}

function makeSupabase(opts: FakeSupabaseOpts) {
  const captured: CapturedCalls = {
    fromTables: [],
    rpcCalls: [],
    inserts: [],
    updates: [],
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
  strategy?: string;
  rule_id?: string | null;
  trace?: unknown[];
  throwError?: string;
}

function makeRoutingService(opts: FakeRoutingOpts = {}): RoutingService {
  return {
    evaluate: jest.fn(async () => {
      if (opts.throwError) throw new Error(opts.throwError);
      return {
        target: opts.target ?? null,
        chosen_by: opts.chosen_by ?? 'unassigned',
        rule_id: opts.rule_id ?? null,
        rule_name: null,
        strategy: opts.strategy ?? (opts.target ? opts.target.kind : 'auto'),
        trace: opts.trace ?? [{ step: 'request_type_default', matched: false, reason: 'no default', target: null }],
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

describe('RoutingEvaluationHandler.handle (audit02 Slice D P1-2 + B.2.A.Step11 §3.9.3)', () => {
  describe('audit02 Slice D — P1-2 invariants', () => {
    it('always calls set_entity_assignment with clear_routing_status:"true" on team target', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
        strategy: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const assignmentCalls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(assignmentCalls).toHaveLength(1);
      const args = assignmentCalls[0].args as { p_payload: Record<string, unknown> };
      expect(args.p_payload.clear_routing_status).toBe('true');
    });

    it('always calls set_entity_assignment with p_payload.decision matching the evaluation result (team target)', async () => {
      const trace = [{ step: 'rule', matched: true, reason: 'rule matched', target: { kind: 'team', team_id: TEAM_ID } }];
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
        strategy: 'rule',
        rule_id: null,
        trace,
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const assignmentCalls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(assignmentCalls).toHaveLength(1);
      const args = assignmentCalls[0].args as { p_payload: Record<string, unknown> };
      const decision = args.p_payload.decision as Record<string, unknown>;
      expect(decision).toBeDefined();
      expect(decision.strategy).toBe('rule');
      expect(decision.chosen_by).toBe('rule');
      expect(decision.rule_id).toBeNull();
      expect(decision.trace).toEqual(trace);
      // context mirrors RoutingService.recordDecision shape
      expect((decision.context as Record<string, unknown>).request_type_id).toBe(REQUEST_TYPE_ID);
      expect((decision.context as Record<string, unknown>).outbox_event_id).toBe(EVENT_ID);
    });

    it('does NOT perform a standalone tickets.update({routing_status}) — v3 owns the clear atomically (no second write outside tx)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      // No standalone tickets.update call for routing_status — v3 handles it.
      const ticketUpdates = supabase.captured.updates.filter((u) => u.table === 'tickets');
      expect(ticketUpdates).toHaveLength(0);
    });

    it('does NOT perform a standalone routing_decisions.insert in the success path — v3 owns it via p_payload.decision', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      // No standalone routing_decisions.insert in the success path.
      const decisionInserts = supabase.captured.inserts.filter(
        (i) => i.table === 'routing_decisions',
      );
      expect(decisionInserts).toHaveLength(0);
    });

    it('unassigned outcome: still calls set_entity_assignment with clear_routing_status + decision (no assignee keys), no standalone writes', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({ target: null, chosen_by: 'unassigned', strategy: 'auto' });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const assignmentCalls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(assignmentCalls).toHaveLength(1);
      const args = assignmentCalls[0].args as { p_payload: Record<string, unknown> };
      expect(args.p_payload.clear_routing_status).toBe('true');
      expect(args.p_payload.decision).toBeDefined();
      // No standalone writes.
      expect(supabase.captured.updates.filter((u) => u.table === 'tickets')).toHaveLength(0);
      expect(supabase.captured.inserts.filter((i) => i.table === 'routing_decisions')).toHaveLength(0);
    });

    it('target matches current: still calls set_entity_assignment (for the directives), no standalone writes', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket({ assigned_team_id: TEAM_ID }),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const assignmentCalls = supabase.captured.rpcCalls.filter(
        (c) => c.fn === 'set_entity_assignment',
      );
      expect(assignmentCalls).toHaveLength(1);
      expect(supabase.captured.updates.filter((u) => u.table === 'tickets')).toHaveLength(0);
      expect(supabase.captured.inserts.filter((i) => i.table === 'routing_decisions')).toHaveLength(0);
    });

    it('fail-closed guard: dead-letters if payload entity_kind is somehow not "case" (impossible per F11 — producers 00354-00358 are case-only)', async () => {
      const supabase = makeSupabase({ ticketRow: baseTicket(), requestTypeRow: { domain: null } });
      const routing = makeRoutingService({ target: null, chosen_by: 'unassigned' });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      const event = makeEvent({}, { tenant_id: TENANT_ID, ticket_id: TICKET_ID } as Partial<RoutingEvaluationRequiredPayload>);
      // Inject entity_kind override to simulate a contract violation.
      (event.payload as unknown as Record<string, unknown>).entity_kind = 'work_order';
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('happy paths', () => {
    it('routes to a new team: calls set_entity_assignment with team + clear_routing_status + decision, no standalone writes', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);

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
      // audit02 Slice D: clear_routing_status + decision folded into v3 tx.
      expect(args.p_payload.clear_routing_status).toBe('true');
      expect(args.p_payload.decision).toBeDefined();
      // codex-S11-I2: handler does NOT pass `reason`.
      expect(args.p_payload.reason).toBeUndefined();

      // audit02 Slice D P1-2: NO standalone routing_decisions.insert (v3 owns it).
      expect(supabase.captured.inserts.filter((i) => i.table === 'routing_decisions')).toHaveLength(0);
      // audit02 Slice D P1-2: NO standalone tickets.update({routing_status}) (v3 owns it).
      expect(supabase.captured.updates.filter((u) => u.table === 'tickets')).toHaveLength(0);
    });

    it('unassigned outcome: calls set_entity_assignment (directives only), no standalone writes (v5/I4)', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket(),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({ target: null, chosen_by: 'unassigned' });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      expect(
        supabase.captured.rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
      ).toHaveLength(1);
      expect(
        supabase.captured.inserts.filter((i) => i.table === 'routing_decisions'),
      ).toHaveLength(0);
      expect(
        supabase.captured.updates.filter((u) => u.table === 'tickets'),
      ).toHaveLength(0);
    });

    it('target matches current assignee: still calls set_entity_assignment for directives, no standalone writes', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket({ assigned_team_id: TEAM_ID }),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      expect(
        supabase.captured.rpcCalls.filter((c) => c.fn === 'set_entity_assignment'),
      ).toHaveLength(1);
      expect(
        supabase.captured.inserts.filter((i) => i.table === 'routing_decisions'),
      ).toHaveLength(0);
    });

    it('target differs from current (different team): set_entity_assignment fires with both assignment keys + directives', async () => {
      const supabase = makeSupabase({
        ticketRow: baseTicket({ assigned_team_id: OTHER_TEAM_ID }),
        requestTypeRow: { domain: 'facilities' },
      });
      const routing = makeRoutingService({
        target: { kind: 'team', team_id: TEAM_ID },
        chosen_by: 'rule',
      });
      const handler = new RoutingEvaluationHandler(supabase.service, routing);

      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();

      const calls = supabase.captured.rpcCalls.filter((c) => c.fn === 'set_entity_assignment');
      expect(calls).toHaveLength(1);
      const args = calls[0].args as { p_payload: Record<string, unknown> };
      expect(args.p_payload.assigned_team_id).toBe(TEAM_ID);
      expect(args.p_payload.clear_routing_status).toBe('true');
      expect(args.p_payload.decision).toBeDefined();
    });
  });

  describe('terminal no-ops', () => {
    it('returns void on ticket_not_found (hard-delete between emit + fire)', async () => {
      const supabase = makeSupabase({ ticketRow: null });
      const routing = makeRoutingService();
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(routing.evaluate).not.toHaveBeenCalled();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });
  });

  describe('terminal dead-letters', () => {
    it('dead-letters on tenant smuggling', async () => {
      const supabase = makeSupabase({});
      const routing = makeRoutingService();
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
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
      const handler = new RoutingEvaluationHandler(supabase.service, routing);

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
      const handler = new RoutingEvaluationHandler(supabase.service, routing);

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
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection wobble/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
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
      const handler = new RoutingEvaluationHandler(supabase.service, routing);
      await handler.handle(makeEvent({ id: 'aaaaaaaa-1111-4111-8111-111111111111' }));
      const call = supabase.captured.rpcCalls.find((c) => c.fn === 'set_entity_assignment');
      const args = call!.args as { p_idempotency_key: string };
      expect(args.p_idempotency_key).toBe('routing-evaluation:aaaaaaaa-1111-4111-8111-111111111111');
    });
  });
});
