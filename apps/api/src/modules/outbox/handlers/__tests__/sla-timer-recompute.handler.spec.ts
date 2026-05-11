import { SlaTimerHandler, type SlaTimerRecomputePayload } from '../sla-timer-recompute.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { BusinessHoursService } from '../../../sla/business-hours.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * B.2.A.Step12 — `SlaTimerHandler.handle` tests (F-IMP-1).
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 line 2564 +
 *       §3.11 (emitter — create_ticket_with_automation no-approval) +
 *       §3.5 (emitter — grant_ticket_approval).
 *
 * Flow under test:
 *   1. tenant_id smuggling defense (event.tenant_id vs payload.tenant_id)
 *   2. Re-read tickets.sla_id as SoT (v8 / C3)
 *   3. Stale-event / sla_cleared / ticket_not_found terminal no-ops
 *   4. Load sla_policies (terminal dead-letter on missing)
 *   5. Optional calendar load
 *   6. Compute due_at via BusinessHoursService (terminal if it crashes)
 *   7. RPC start_sla_timers (success or error)
 *   8. Error classification — terminal → DeadLetterError, transient → Error
 */

const TENANT_ID = 'a1111111-1111-4111-8111-111111111111';
const EVENT_ID = 'a2222222-2222-4222-8222-222222222222';
const TICKET_ID = 'a3333333-3333-4333-8333-333333333333';
const SLA_ID = 'a4444444-4444-4444-8444-444444444444';
const OTHER_SLA_ID = 'a5555555-5555-4555-8555-555555555555';

function makeEvent(
  overrides: Partial<OutboxEvent<SlaTimerRecomputePayload>> = {},
  payloadOverrides: Partial<SlaTimerRecomputePayload> = {},
): OutboxEvent<SlaTimerRecomputePayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'sla.timer_recompute_required',
    event_version: 1,
    aggregate_type: 'ticket',
    aggregate_id: TICKET_ID,
    payload: {
      tenant_id: TENANT_ID,
      ticket_id: TICKET_ID,
      sla_policy_id: SLA_ID,
      started_at: '2026-05-11T10:00:00Z',
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: 'sla.timer_recompute_required:' + TICKET_ID + ':create',
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
  ticketRow?: { id: string; tenant_id: string; sla_id: string | null; created_at: string } | null;
  ticketError?: { message: string };
  policyRow?: {
    response_time_minutes: number | null;
    resolution_time_minutes: number | null;
    business_hours_calendar_id: string | null;
  } | null;
  policyError?: { message: string };
  rpcResponse?: { timers_inserted?: number } | null;
  rpcError?: { code?: string; message: string };
}

interface CapturedCalls {
  fromTables: string[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
}

function makeSupabase(opts: FakeSupabaseOpts) {
  const captured: CapturedCalls = { fromTables: [], rpcCalls: [] };

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
    if (table === 'sla_policies') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.policyRow ?? null,
                error: opts.policyError ?? null,
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'business_hours_calendars') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
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

function makeBusinessHours(opts: { crash?: boolean } = {}): BusinessHoursService {
  return {
    addBusinessMinutes: jest.fn((_cal, start: Date, minutes: number) => {
      if (opts.crash) throw new Error('business_hours_internal_error');
      return new Date(start.getTime() + minutes * 60_000);
    }),
  } as unknown as BusinessHoursService;
}

describe('SlaTimerHandler.handle (B.2.A.Step12 §3.9.3 — F-IMP-1)', () => {
  describe('happy path', () => {
    it('reads ticket.sla_id, loads policy, computes due_at, calls start_sla_timers RPC', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: 480,
          business_hours_calendar_id: null,
        },
        rpcResponse: { timers_inserted: 2 },
      });
      const bh = makeBusinessHours();
      const handler = new SlaTimerHandler(supabase.service, bh);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(1);
      const call = supabase.captured.rpcCalls[0];
      expect(call.fn).toBe('start_sla_timers');
      const args = call.args as {
        p_tenant_id: string;
        p_ticket_id: string;
        p_sla_policy_id: string;
        p_timers: Array<{ timer_type: string }>;
        p_started_at: string;
      };
      expect(args.p_tenant_id).toBe(TENANT_ID);
      expect(args.p_ticket_id).toBe(TICKET_ID);
      expect(args.p_sla_policy_id).toBe(SLA_ID);
      expect(args.p_timers.map((t) => t.timer_type).sort()).toEqual([
        'resolution',
        'response',
      ]);
      // codex-S12-I2: handler must forward the path-dependent started_at
      // from the event payload to the RPC so persisted started_at matches
      // the value used to compute due_at.
      expect(args.p_started_at).toBe(new Date('2026-05-11T10:00:00Z').toISOString());
    });
  });

  describe('terminal no-ops (return void without RPC)', () => {
    it('returns void on ticket_not_found (hard-delete between emit + fire)', async () => {
      const supabase = makeSupabase({ ticketRow: null });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void on sla_cleared (ticket.sla_id is null)', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: null,
          created_at: '2026-05-11T10:00:00Z',
        },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void on stale_event (payload sla_policy_id != ticket.sla_id)', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: OTHER_SLA_ID, // ticket moved to a different policy
          created_at: '2026-05-11T10:00:00Z',
        },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });
  });

  describe('terminal dead-letters', () => {
    it('dead-letters on tenant smuggling (event.tenant_id != payload.tenant_id)', async () => {
      const supabase = makeSupabase({});
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      const event = makeEvent({}, { tenant_id: 'b9999999-9999-4999-8999-999999999999' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.fromTables).not.toContain('tickets');
    });

    it('dead-letters on policy_not_found (policy hard-deleted post-emit)', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: null, // hard-deleted
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('dead-letters when policy has neither response nor resolution targets', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: {
          response_time_minutes: null,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('dead-letters on invalid started_at in payload', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      const event = makeEvent({}, { started_at: 'not-a-date' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on RPC terminal codes (e.g. ticket_not_found from PG-side guard)', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
        rpcError: {
          code: 'P0002',
          message: 'start_sla_timers.ticket_not_found: id=…',
        },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('transient (worker retries)', () => {
    it('throws plain Error on tickets read wobble (not DeadLetterError)', async () => {
      const supabase = makeSupabase({ ticketError: { message: 'connection wobble' } });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection wobble/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });

    it('throws plain Error on policy read wobble', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyError: { message: 'lock timeout' },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toThrow(/lock timeout/);
    });

    it('surfaces BusinessHoursService crash as a (transient) Error', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours({ crash: true }));
      await expect(handler.handle(makeEvent())).rejects.toThrow(/business_hours_internal_error/);
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('throws plain Error on RPC connection-class error', async () => {
      const supabase = makeSupabase({
        ticketRow: {
          id: TICKET_ID,
          tenant_id: TENANT_ID,
          sla_id: SLA_ID,
          created_at: '2026-05-11T10:00:00Z',
        },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
        rpcError: { code: '08000', message: 'connection refused' },
      });
      const handler = new SlaTimerHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection refused/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });
  });
});
