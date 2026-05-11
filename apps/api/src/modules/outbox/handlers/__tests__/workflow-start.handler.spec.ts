import {
  WorkflowStartHandler,
  type WorkflowStartRequiredPayload,
} from '../workflow-start.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { WorkflowEngineService } from '../../../workflow/workflow-engine.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * B.2.A.Step12 — `WorkflowStartHandler.handle` tests (F-IMP-1).
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 line 2567 +
 *       §3.11 (emitter — create_ticket_with_automation no-approval) +
 *       §3.5 (grant_ticket_approval) + §3.10 (reclassify_ticket).
 *
 * Flow under test:
 *   1. tenant_id smuggling defense (event.tenant_id vs payload.tenant_id)
 *   2. Re-read tickets.workflow_id as SoT (v8 / C3)
 *   3. Stale-event / no_workflow / ticket_not_found terminal no-ops
 *   4. Pre-check workflow_instances for already-active
 *   5. WorkflowEngineService.startForTicket — null → DeadLetter,
 *      23505 → already_started_via_race, transient → Error
 */

const TENANT_ID = 'b1111111-1111-4111-8111-111111111111';
const EVENT_ID = 'b2222222-2222-4222-8222-222222222222';
const TICKET_ID = 'b3333333-3333-4333-8333-333333333333';
const WORKFLOW_ID = 'b4444444-4444-4444-8444-444444444444';
const OTHER_WORKFLOW_ID = 'b5555555-5555-4555-8555-555555555555';
const INSTANCE_ID = 'b6666666-6666-4666-8666-666666666666';

function makeEvent(
  overrides: Partial<OutboxEvent<WorkflowStartRequiredPayload>> = {},
  payloadOverrides: Partial<WorkflowStartRequiredPayload> = {},
): OutboxEvent<WorkflowStartRequiredPayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'workflow.start_required',
    event_version: 1,
    aggregate_type: 'ticket',
    aggregate_id: TICKET_ID,
    payload: {
      tenant_id: TENANT_ID,
      ticket_id: TICKET_ID,
      workflow_definition_id: WORKFLOW_ID,
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: 'workflow.start_required:' + TICKET_ID + ':create',
    enqueued_at: '2026-05-11T09:59:00Z',
    available_at: '2026-05-11T09:59:00Z',
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

interface FakeSupabaseOpts {
  ticketRow?: { id: string; tenant_id: string; workflow_id: string | null } | null;
  ticketError?: { message: string };
  existingInstance?: { id: string; status: string } | null;
  existingError?: { message: string };
}

function makeSupabase(opts: FakeSupabaseOpts) {
  const captured = { fromTables: [] as string[] };

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
      };
    }
    if (table === 'workflow_instances') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({
                maybeSingle: async () => ({
                  data: opts.existingInstance ?? null,
                  error: opts.existingError ?? null,
                }),
              }),
            }),
          }),
        }),
      };
    }
    throw new Error('unexpected table: ' + table);
  });

  return {
    captured,
    service: { admin: { from } } as never,
  };
}

interface FakeEngineOpts {
  instance?: { id: string } | null;
  throwUniqueViolation?: boolean;
  throwTransient?: string;
  throwDeadLetter?: string;
}

function makeWorkflowEngine(opts: FakeEngineOpts = {}): WorkflowEngineService {
  return {
    startForTicket: jest.fn(async () => {
      if (opts.throwDeadLetter) {
        throw new DeadLetterError(opts.throwDeadLetter);
      }
      if (opts.throwUniqueViolation) {
        const err = new Error('duplicate key value violates unique constraint "workflow_instances_active_unique_idx"') as Error & {
          code: string;
        };
        err.code = '23505';
        throw err;
      }
      if (opts.throwTransient) {
        throw new Error(opts.throwTransient);
      }
      return opts.instance ?? null;
    }),
  } as unknown as WorkflowEngineService;
}

describe('WorkflowStartHandler.handle (B.2.A.Step12 §3.9.3 — F-IMP-1)', () => {
  describe('happy path', () => {
    it('reads ticket.workflow_id, pre-checks instances, calls startForTicket on success', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingInstance: null,
      });
      const engine = makeWorkflowEngine({ instance: { id: INSTANCE_ID } });
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(engine.startForTicket).toHaveBeenCalledWith(TICKET_ID, WORKFLOW_ID);
    });
  });

  describe('terminal no-ops (return void without engine call)', () => {
    it('returns void on ticket_not_found (hard-delete between emit + fire)', async () => {
      const supabase = makeSupabase({ ticketRow: null });
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(engine.startForTicket).not.toHaveBeenCalled();
    });

    it('returns void on no_workflow (ticket.workflow_id is null)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: null },
      });
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(engine.startForTicket).not.toHaveBeenCalled();
    });

    it('returns void on stale_event (payload workflow_definition_id != ticket.workflow_id)', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          workflow_id: OTHER_WORKFLOW_ID, // ticket has been reclassified to a different workflow
        },
      });
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(engine.startForTicket).not.toHaveBeenCalled();
    });

    it('returns void when pre-check finds an active workflow_instances row (already_started)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingInstance: { id: INSTANCE_ID, status: 'active' },
      });
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(engine.startForTicket).not.toHaveBeenCalled();
    });

    it('returns void on already_started_via_race (23505 caught from startForTicket INSERT)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingInstance: null, // pre-check missed; INSERT raced
      });
      const engine = makeWorkflowEngine({ throwUniqueViolation: true });
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(engine.startForTicket).toHaveBeenCalledTimes(1);
    });
  });

  describe('terminal dead-letters', () => {
    it('dead-letters on tenant smuggling (event.tenant_id != payload.tenant_id)', async () => {
      const supabase = makeSupabase({});
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      const event = makeEvent({}, { tenant_id: 'b9999999-9999-4999-8999-999999999999' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.fromTables).not.toContain('tickets');
    });

    it('dead-letters when startForTicket returns null (definition missing / empty graph / no trigger)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingInstance: null,
      });
      const engine = makeWorkflowEngine({ instance: null });
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('re-throws DeadLetterError raised by startForTicket', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingInstance: null,
      });
      const engine = makeWorkflowEngine({ throwDeadLetter: 'workflow.invalid_graph' });
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('transient (worker retries)', () => {
    it('throws plain Error on tickets read wobble', async () => {
      const supabase = makeSupabase({ ticketError: { message: 'connection wobble' } });
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection wobble/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });

    it('throws plain Error on workflow_instances read wobble', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingError: { message: 'lock timeout' },
      });
      const engine = makeWorkflowEngine();
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/lock timeout/);
    });

    it('wraps a generic startForTicket crash as transient Error (not DeadLetter)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, workflow_id: WORKFLOW_ID },
        existingInstance: null,
      });
      const engine = makeWorkflowEngine({ throwTransient: 'engine_internal_error' });
      const handler = new WorkflowStartHandler(supabase.service, engine);
      await expect(handler.handle(makeEvent())).rejects.toThrow(/engine_internal_error/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });
  });
});
