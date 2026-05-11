import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { BusinessHoursService } from '../../sla/business-hours.service';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * SlaTimerHandler — drains `sla.timer_recompute_required` outbox events.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 line 2564
 *       (handler contract) + §3.11 (emitter — create_ticket_with_automation
 *       no-approval branch) + §3.5 (emitter — grant_ticket_approval).
 *
 * ── Source-of-truth contract (v8 / C3 sweep) ─────────────────────────────
 *
 * Reads `tickets.sla_id` at FIRE time as the source of truth. The event
 * payload's `sla_policy_id` is a wake-up reference, not authoritative:
 *
 *   - If the ticket has been hard-deleted between emit and fire →
 *     terminal `{ kind: 'ticket_not_found' }` (NOT retry-deadletter;
 *     v9 / P-I5).
 *   - If `ticket.sla_id IS NULL` → no-op `{ kind: 'sla_cleared' }`
 *     (a concurrent reclassify or SLA change blanked the policy).
 *   - If event payload `sla_policy_id` differs from `ticket.sla_id` →
 *     `{ kind: 'stale_event' }` no-op (a more recent change wrote a
 *     different policy; this event is now stale).
 *   - Else: load the canonical sla_policies row by `ticket.sla_id`,
 *     compute `due_at` per timer_type via `BusinessHoursService`, and
 *     call the `start_sla_timers` RPC (migration 00347) which writes
 *     timer rows + UPDATEs ticket due-date columns in one PG tx.
 *
 * ── `started_at` is path-dependent (v9 / P-I2) ────────────────────────────
 *
 * The handler uses `started_at` from the EVENT PAYLOAD, never a hardcoded
 * `now()` or `ticket.created_at`. Per spec:
 *   - post-create emits `started_at = ticket.created_at` (SLA clock starts
 *     when customer asked);
 *   - post-grant emits `started_at = now()` at grant time (customer waited
 *     for approval);
 *   - post-reclassify emits `started_at = now()` at reclassify time.
 *
 * If the payload is missing `started_at` the handler defaults to `now()`
 * to avoid blocking forever on a producer bug — logged as a warning.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * Provided by the `start_sla_timers` RPC's `ON CONFLICT DO NOTHING` against
 * the partial unique index `sla_timers_active_unique_idx` (00346). Worker
 * retries are safe end-to-end.
 *
 * ── Cross-tenant defense (memory: feedback_tenant_id_ultimate_rule) ──────
 *
 * Every read is filtered by `event.tenant_id`. The handler runs inside
 * `TenantContext.run(tenant, ...)` per the worker contract (§4.3) so the
 * RPC sees the right tenant, but `supabase.admin` bypasses RLS — defense-
 * in-depth filtering at every read site.
 */

export interface SlaTimerRecomputePayload {
  /** Tenant — duplicated from event.tenant_id for handler convenience + defense-in-depth. */
  tenant_id: string;
  /** Case (tickets) row id. */
  ticket_id: string;
  /** Emitter's view of the SLA policy. Compared against tickets.sla_id at fire time. */
  sla_policy_id: string;
  /**
   * Path-dependent SLA clock start. Post-create = ticket.created_at;
   * post-grant = now() at grant time; post-reclassify = now() at reclassify time.
   */
  started_at: string;
}

@Injectable()
@OutboxHandler('sla.timer_recompute_required', { version: 1 })
export class SlaTimerHandler implements OutboxEventHandler<SlaTimerRecomputePayload> {
  private readonly log = new Logger(SlaTimerHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly businessHours: BusinessHoursService,
  ) {}

  async handle(event: OutboxEvent<SlaTimerRecomputePayload>): Promise<void> {
    const { tenant_id, ticket_id, sla_policy_id: payload_sla_policy_id, started_at } = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    // event.tenant_id and payload.tenant_id must agree. Mismatch → dead-letter.
    if (tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `sla_timer.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${tenant_id}`,
      );
    }

    // ── 2. Re-read ticket.sla_id (source of truth per v8 / C3) ────────────
    const ticketRes = await this.supabase.admin
      .from('tickets')
      .select('id, tenant_id, sla_id, created_at')
      .eq('id', ticket_id)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (ticketRes.error) {
      // Transient read failure (PG wobble) — retry.
      throw new Error(`sla_timer.ticket_read_failed: ${ticketRes.error.message}`);
    }

    if (!ticketRes.data) {
      // Hard-deleted between emit + fire. Terminal per v9 / P-I5: NOT
      // retry-deadletter. Worker marks processed_reason='handler_ok'.
      this.log.log(`ticket_not_found ticket=${ticket_id} event=${event.id}`);
      return;
    }

    const currentSlaId = ticketRes.data.sla_id as string | null;

    if (!currentSlaId) {
      // The ticket's sla_id has been cleared (concurrent reclassify / SLA
      // change to null). No-op.
      this.log.log(`sla_cleared ticket=${ticket_id} event=${event.id}`);
      return;
    }

    if (currentSlaId !== payload_sla_policy_id) {
      // Stale event — a more recent change wrote a different policy. The
      // newer change emitted its own event which will (eventually) fire
      // with the correct policy. Drop this one.
      this.log.log(
        `stale_event ticket=${ticket_id} payload_sla=${payload_sla_policy_id} current_sla=${currentSlaId} event=${event.id}`,
      );
      return;
    }

    // ── 3. Load the canonical sla_policies row (by ticket.sla_id) ────────
    //
    // v8 / C3 sweep: NEVER trust the event payload's sla_policy_id past
    // this point. We've already confirmed currentSlaId === payload, but
    // a future race could change that; from here on we use currentSlaId.
    const policyRes = await this.supabase.admin
      .from('sla_policies')
      .select(
        'id, tenant_id, response_time_minutes, resolution_time_minutes, business_hours_calendar_id',
      )
      .eq('id', currentSlaId)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (policyRes.error) {
      throw new Error(`sla_timer.policy_read_failed: ${policyRes.error.message}`);
    }

    if (!policyRes.data) {
      // The policy was hard-deleted while the event was queued. Terminal —
      // a future replay can't fix it. Dead-letter so it shows up on triage.
      throw new DeadLetterError(
        `sla_timer.policy_not_found_in_tenant: policy=${currentSlaId} tenant=${event.tenant_id}`,
      );
    }

    const policy = policyRes.data as {
      response_time_minutes: number | null;
      resolution_time_minutes: number | null;
      business_hours_calendar_id: string | null;
    };

    // ── 4. Load calendar (defensive — same path as SlaService.loadCalendar) ─
    let calendar: import('../../sla/business-hours.service').BusinessHoursCalendar | null = null;
    if (policy.business_hours_calendar_id) {
      const calRes = await this.supabase.admin
        .from('business_hours_calendars')
        .select('time_zone, working_hours, holidays')
        .eq('id', policy.business_hours_calendar_id)
        .eq('tenant_id', event.tenant_id)
        .maybeSingle();
      if (calRes.error) {
        throw new Error(`sla_timer.calendar_read_failed: ${calRes.error.message}`);
      }
      calendar = (calRes.data as import('../../sla/business-hours.service').BusinessHoursCalendar | null) ?? null;
    }

    // ── 5. Compute due_at for each timer_type via BusinessHoursService ───
    //
    // started_at is path-dependent (v9 / P-I2). Use the payload value.
    // If missing (producer bug), default to now() and log a warning.
    let startedAt: Date;
    if (started_at) {
      startedAt = new Date(started_at);
      if (Number.isNaN(startedAt.getTime())) {
        throw new DeadLetterError(
          `sla_timer.started_at_invalid: '${started_at}' is not a valid ISO timestamp`,
        );
      }
    } else {
      this.log.warn(
        `started_at missing on payload; defaulting to now() — producer bug. event=${event.id}`,
      );
      startedAt = new Date();
    }

    const timers: Array<{
      timer_type: 'response' | 'resolution';
      target_minutes: number;
      due_at: string;
      business_hours_calendar_id: string | null;
    }> = [];

    if (policy.response_time_minutes && policy.response_time_minutes > 0) {
      const responseDue = this.businessHours.addBusinessMinutes(
        calendar,
        startedAt,
        policy.response_time_minutes,
      );
      timers.push({
        timer_type: 'response',
        target_minutes: policy.response_time_minutes,
        due_at: responseDue.toISOString(),
        business_hours_calendar_id: policy.business_hours_calendar_id,
      });
    }

    if (policy.resolution_time_minutes && policy.resolution_time_minutes > 0) {
      const resolutionDue = this.businessHours.addBusinessMinutes(
        calendar,
        startedAt,
        policy.resolution_time_minutes,
      );
      timers.push({
        timer_type: 'resolution',
        target_minutes: policy.resolution_time_minutes,
        due_at: resolutionDue.toISOString(),
        business_hours_calendar_id: policy.business_hours_calendar_id,
      });
    }

    if (timers.length === 0) {
      // Policy has neither response nor resolution targets. Terminal
      // no-op — admin must reconfigure the policy. Dead-letter so the
      // misconfiguration surfaces on triage.
      throw new DeadLetterError(
        `sla_timer.policy_has_no_targets: policy=${currentSlaId} has neither response_time_minutes nor resolution_time_minutes`,
      );
    }

    // ── 6. Call start_sla_timers RPC (00347) — atomic INSERT + UPDATE ────
    const rpcRes = await this.supabase.admin.rpc('start_sla_timers', {
      p_tenant_id: event.tenant_id,
      p_ticket_id: ticket_id,
      p_sla_policy_id: currentSlaId,
      p_timers: timers,
    });

    if (rpcRes.error) {
      throw this.classifyRpcError(rpcRes.error, event);
    }

    this.log.log(
      `recomputed ticket=${ticket_id} sla=${currentSlaId} inserted=${(rpcRes.data as { timers_inserted?: number })?.timers_inserted ?? '?'} event=${event.id}`,
    );
  }

  /**
   * Terminal taxonomy (codes raised by 00347 + 00340 validate_entity_in_tenant):
   *  - start_sla_timers.ticket_not_found      — ticket hard-deleted; terminal.
   *  - start_sla_timers.timers_required       — empty payload; handler bug; terminal.
   *  - start_sla_timers.unknown_timer_type    — handler bug; terminal.
   *  - validate_entity_in_tenant.sla_policy_not_in_tenant — cross-tenant; terminal.
   *
   * Anything else (PG connection wobble, lock timeout) is transient.
   */
  private classifyRpcError(
    rpcError: { code?: string; message: string; details?: string | null },
    event: OutboxEvent<SlaTimerRecomputePayload>,
  ): Error {
    const message = rpcError.message ?? '';
    const TERMINAL_TOKENS = [
      'start_sla_timers.ticket_not_found',
      'start_sla_timers.timers_required',
      'start_sla_timers.unknown_timer_type',
      'validate_entity_in_tenant.sla_policy_not_in_tenant',
    ];
    for (const token of TERMINAL_TOKENS) {
      if (message.includes(token)) {
        return new DeadLetterError(
          `start_sla_timers terminal error for event=${event.id} ticket=${event.payload.ticket_id}: ${message}`,
        );
      }
    }
    return new Error(
      `start_sla_timers transient error for event=${event.id} ticket=${event.payload.ticket_id}: ${message}`,
    );
  }
}
