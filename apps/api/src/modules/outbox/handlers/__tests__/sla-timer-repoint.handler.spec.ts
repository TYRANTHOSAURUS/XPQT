import {
  SlaTimerRepointHandler,
  type SlaTimerRepointedPayload,
} from '../sla-timer-repoint.handler';
import { DeadLetterError } from '../../dead-letter.error';
import type { BusinessHoursService } from '../../../sla/business-hours.service';
import type { OutboxEvent } from '../../outbox.types';

/**
 * B.2.A.Step11 — `SlaTimerRepointHandler.handle` tests.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 lines 2771-2777 +
 *       §3.10 step 10 (emitter — reclassify_ticket).
 *
 * Mirrors the SlaTimerHandler test shape (commit 7faf6a23):
 *   1. tenant_id smuggling defense (event.tenant_id vs payload.tenant_id)
 *   2. Re-read tickets.sla_id as SoT (v8 / C3)
 *   3. Stale-event / sla_cleared / ticket_not_found terminal no-ops
 *   4. Load sla_policies (terminal dead-letter on missing)
 *   5. Optional calendar load
 *   6. Compute due_at via BusinessHoursService (terminal if it crashes)
 *   7. RPC repoint_sla_timer (success or error)
 *   8. Error classification — terminal → DeadLetterError, transient → Error
 */

const TENANT_ID = 'c1111111-1111-4111-8111-111111111111';
const EVENT_ID = 'c2222222-2222-4222-8222-222222222222';
const TICKET_ID = 'c3333333-3333-4333-8333-333333333333';
const SLA_ID = 'c4444444-4444-4444-8444-444444444444';
const OTHER_SLA_ID = 'c5555555-5555-4555-8555-555555555555';

function makeEvent(
  overrides: Partial<OutboxEvent<SlaTimerRepointedPayload>> = {},
  payloadOverrides: Partial<SlaTimerRepointedPayload> = {},
): OutboxEvent<SlaTimerRepointedPayload> {
  return {
    id: EVENT_ID,
    tenant_id: TENANT_ID,
    event_type: 'sla.timer_repointed_required',
    event_version: 1,
    aggregate_type: 'ticket',
    aggregate_id: TICKET_ID,
    payload: {
      tenant_id: TENANT_ID,
      ticket_id: TICKET_ID,
      sla_policy_id: SLA_ID,
      started_at: '2026-05-11T12:00:00Z',
      ...payloadOverrides,
    },
    payload_hash: 'hash',
    idempotency_key: 'sla.timer_repointed_required:' + TICKET_ID + ':reclassify',
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

interface FakeSupabaseOpts {
  ticketRow?: { id: string; tenant_id: string; sla_id: string | null } | null;
  ticketError?: { message: string };
  policyRow?: {
    response_time_minutes: number | null;
    resolution_time_minutes: number | null;
    business_hours_calendar_id: string | null;
  } | null;
  policyError?: { message: string };
  rpcResponse?: { kind?: string; timers_inserted?: number; timers_stopped?: number } | null;
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
    return { data: opts.rpcResponse ?? { kind: 'repointed' }, error: null };
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

describe('SlaTimerRepointHandler.handle (B.2.A.Step11 §3.9.3)', () => {
  describe('happy path', () => {
    it('reads ticket.sla_id, loads policy, computes due_at, calls repoint_sla_timer RPC with p_started_at', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: 480,
          business_hours_calendar_id: null,
        },
        rpcResponse: { kind: 'repointed', timers_inserted: 2, timers_stopped: 1 },
      });
      const bh = makeBusinessHours();
      const handler = new SlaTimerRepointHandler(supabase.service, bh);
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(1);
      const call = supabase.captured.rpcCalls[0];
      expect(call.fn).toBe('repoint_sla_timer');
      const args = call.args as {
        p_tenant_id: string;
        p_ticket_id: string;
        p_sla_policy_id: string;
        p_timers: Array<{ timer_type: string }>;
        p_reason: string;
        p_started_at: string;
      };
      expect(args.p_tenant_id).toBe(TENANT_ID);
      expect(args.p_ticket_id).toBe(TICKET_ID);
      expect(args.p_sla_policy_id).toBe(SLA_ID);
      expect(args.p_timers.map((t) => t.timer_type).sort()).toEqual(['resolution', 'response']);
      expect(args.p_reason).toBe('reclassified');
      // Step11-C1: handler must forward the path-dependent started_at to
      // the RPC so persisted started_at matches the value used to compute
      // due_at.
      expect(args.p_started_at).toBe(new Date('2026-05-11T12:00:00Z').toISOString());
    });

    it('passes already_repointed through as a normal success', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
        rpcResponse: { kind: 'already_repointed', timers_inserted: 0, timers_stopped: 0 },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(1);
    });
  });

  describe('terminal no-ops (return void without RPC)', () => {
    it('returns void on ticket_not_found (hard-delete between emit + fire)', async () => {
      const supabase = makeSupabase({ ticketRow: null });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void on sla_cleared (ticket.sla_id is null)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: null },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('returns void on stale_event (payload sla_policy_id != ticket.sla_id)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: OTHER_SLA_ID },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });
  });

  describe('terminal dead-letters', () => {
    it('dead-letters on tenant smuggling (event.tenant_id != payload.tenant_id)', async () => {
      const supabase = makeSupabase({});
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      const event = makeEvent({}, { tenant_id: 'd9999999-9999-4999-8999-999999999999' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.fromTables).not.toContain('tickets');
    });

    it('dead-letters on policy_not_found', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: null,
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('dead-letters when policy has neither response nor resolution targets', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: null,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('dead-letters on invalid started_at', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      const event = makeEvent({}, { started_at: 'not-a-date' });
      await expect(handler.handle(event)).rejects.toBeInstanceOf(DeadLetterError);
    });

    it('dead-letters on RPC terminal codes (ticket_not_found from PG)', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
        rpcError: { code: 'P0002', message: 'repoint_sla_timer.ticket_not_found: id=…' },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(DeadLetterError);
    });
  });

  describe('transient (worker retries)', () => {
    it('throws plain Error on tickets read wobble', async () => {
      const supabase = makeSupabase({ ticketError: { message: 'connection wobble' } });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection wobble/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });

    it('throws plain Error on policy read wobble', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyError: { message: 'lock timeout' },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toThrow(/lock timeout/);
    });

    it('surfaces BusinessHoursService crash as transient', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
      });
      const handler = new SlaTimerRepointHandler(
        supabase.service,
        makeBusinessHours({ crash: true }),
      );
      await expect(handler.handle(makeEvent())).rejects.toThrow(/business_hours_internal_error/);
      expect(supabase.captured.rpcCalls).toHaveLength(0);
    });

    it('throws plain Error on RPC connection-class error', async () => {
      const supabase = makeSupabase({
        ticketRow: { id: TICKET_ID, tenant_id: TENANT_ID, sla_id: SLA_ID },
        policyRow: {
          response_time_minutes: 60,
          resolution_time_minutes: null,
          business_hours_calendar_id: null,
        },
        rpcError: { code: '08000', message: 'connection refused' },
      });
      const handler = new SlaTimerRepointHandler(supabase.service, makeBusinessHours());
      await expect(handler.handle(makeEvent())).rejects.toThrow(/connection refused/);
      await expect(handler.handle(makeEvent())).rejects.not.toBeInstanceOf(DeadLetterError);
    });
  });
});
