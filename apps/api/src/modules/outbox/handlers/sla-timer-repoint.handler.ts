import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { BusinessHoursService } from '../../sla/business-hours.service';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * SlaTimerRepointHandler — drains `sla.timer_repointed_required` outbox events.
 *
 * Spec: docs/follow-ups/b2-survey-and-design.md §3.9.3 lines 2771-2777 +
 *       §3.10 step 10 (emitter — reclassify_ticket).
 *
 * Sibling of `SlaTimerHandler` (sla-timer-recompute.handler.ts) but
 * targets the `repoint` semantics: STOP old active timers under the
 * previous policy, INSERT fresh timers under the new policy, in a
 * single PG transaction via `repoint_sla_timer` (migration 00353 v2).
 *
 * ── Source-of-truth contract (v8 / C3 sweep, same as recompute) ─────────
 *
 * Reads `tickets.sla_id` at FIRE time as source of truth. The event
 * payload's `sla_policy_id` is a wake-up reference:
 *
 *   - Ticket hard-deleted between emit + fire → terminal (no retry).
 *   - `ticket.sla_id IS NULL` → no-op `{ kind: 'sla_cleared' }`.
 *   - Event payload `sla_policy_id` != `ticket.sla_id` → stale_event
 *     no-op (a newer reclassify pinned a different policy; its own
 *     event will fire).
 *   - Else: compute `due_at` for each timer via BusinessHoursService
 *     using the path-dependent `started_at` from the payload (spec
 *     §3.10 step 10: reclassify time, not ticket.created_at), then
 *     call `repoint_sla_timer` RPC which handles STOP + INSERT
 *     atomically and short-circuits on replay (v7 / I3) via the
 *     `already_repointed` outcome.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 *
 * The RPC's `already_repointed` short-circuit + the `ON CONFLICT DO
 * NOTHING` against `sla_timers_active_unique_idx` (00346) together
 * make this handler safe under any retry path.
 *
 * ── Cross-tenant defense (memory: feedback_tenant_id_ultimate_rule) ─────
 *
 * Every read filters by `event.tenant_id`. Payload's tenant_id is
 * cross-checked at the top — mismatch dead-letters.
 */

export interface SlaTimerRepointedPayload {
  /** Tenant — duplicated from event.tenant_id for handler convenience + defense-in-depth. */
  tenant_id: string;
  /** Case (tickets) row id. */
  ticket_id: string;
  /** Emitter's view of the NEW SLA policy. Compared against tickets.sla_id at fire time. */
  sla_policy_id: string;
  /**
   * Reclassify-time started_at (spec §3.10 step 10 / v9 / P-I2). The
   * SLA clock restarts at reclassify, NOT at ticket.created_at.
   */
  started_at: string;
}

@Injectable()
@OutboxHandler('sla.timer_repointed_required', { version: 1 })
export class SlaTimerRepointHandler
  implements OutboxEventHandler<SlaTimerRepointedPayload>
{
  private readonly log = new Logger(SlaTimerRepointHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly businessHours: BusinessHoursService,
  ) {}

  async handle(event: OutboxEvent<SlaTimerRepointedPayload>): Promise<void> {
    const { tenant_id, ticket_id, sla_policy_id: payload_sla_policy_id, started_at } = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `sla_timer_repoint.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${tenant_id}`,
      );
    }

    // ── 2. Re-read ticket.sla_id (source of truth per v8 / C3) ────────────
    const ticketRes = await this.supabase.admin
      .from('tickets')
      .select('id, tenant_id, sla_id')
      .eq('id', ticket_id)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (ticketRes.error) {
      throw new Error(`sla_timer_repoint.ticket_read_failed: ${ticketRes.error.message}`);
    }

    if (!ticketRes.data) {
      // Hard-deleted between emit + fire. Terminal per v9 / P-I5: NOT
      // retry-deadletter.
      this.log.log(`ticket_not_found ticket=${ticket_id} event=${event.id}`);
      return;
    }

    const currentSlaId = ticketRes.data.sla_id as string | null;

    if (!currentSlaId) {
      // The ticket's sla_id has been cleared (concurrent reclassify cleared
      // the SLA, or the new request_type carries no policy). No-op.
      this.log.log(`sla_cleared ticket=${ticket_id} event=${event.id}`);
      return;
    }

    if (currentSlaId !== payload_sla_policy_id) {
      // Stale event — a more recent reclassify wrote a different policy.
      // The newer event will fire with the correct policy. Drop this one.
      this.log.log(
        `stale_event ticket=${ticket_id} payload_sla=${payload_sla_policy_id} current_sla=${currentSlaId} event=${event.id}`,
      );
      return;
    }

    // ── 3. Load the canonical sla_policies row (by ticket.sla_id) ────────
    const policyRes = await this.supabase.admin
      .from('sla_policies')
      .select(
        'id, tenant_id, response_time_minutes, resolution_time_minutes, business_hours_calendar_id',
      )
      .eq('id', currentSlaId)
      .eq('tenant_id', event.tenant_id)
      .maybeSingle();

    if (policyRes.error) {
      throw new Error(`sla_timer_repoint.policy_read_failed: ${policyRes.error.message}`);
    }

    if (!policyRes.data) {
      // Policy hard-deleted between emit + drain. Terminal — replay can't
      // fix it. Dead-letter for ops triage.
      throw new DeadLetterError(
        `sla_timer_repoint.policy_not_found_in_tenant: policy=${currentSlaId} tenant=${event.tenant_id}`,
      );
    }

    const policy = policyRes.data as {
      response_time_minutes: number | null;
      resolution_time_minutes: number | null;
      business_hours_calendar_id: string | null;
    };

    // ── 4. Load calendar (defensive — same path as SlaTimerHandler) ─────
    let calendar: import('../../sla/business-hours.service').BusinessHoursCalendar | null = null;
    if (policy.business_hours_calendar_id) {
      const calRes = await this.supabase.admin
        .from('business_hours_calendars')
        .select('time_zone, working_hours, holidays')
        .eq('id', policy.business_hours_calendar_id)
        .eq('tenant_id', event.tenant_id)
        .maybeSingle();
      if (calRes.error) {
        throw new Error(`sla_timer_repoint.calendar_read_failed: ${calRes.error.message}`);
      }
      calendar = (calRes.data as import('../../sla/business-hours.service').BusinessHoursCalendar | null) ?? null;
    }

    // ── 5. Compute due_at per timer via BusinessHoursService ─────────────
    //
    // started_at is path-dependent (v9 / P-I2). For repoint, the emitter
    // uses now() at reclassify time. If the payload omits it (producer
    // bug), default to now() and log a warning.
    let startedAt: Date;
    if (started_at) {
      startedAt = new Date(started_at);
      if (Number.isNaN(startedAt.getTime())) {
        throw new DeadLetterError(
          `sla_timer_repoint.started_at_invalid: '${started_at}' is not a valid ISO timestamp`,
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
      // no-op — admin must reconfigure. Dead-letter for triage.
      throw new DeadLetterError(
        `sla_timer_repoint.policy_has_no_targets: policy=${currentSlaId} has neither response_time_minutes nor resolution_time_minutes`,
      );
    }

    // ── 6. Call repoint_sla_timer RPC (00353 v2) — atomic STOP + INSERT ─
    //
    // Step11-C1: forward the path-dependent startedAt so the persisted
    // started_at matches the value the handler used to compute due_at.
    // Pre-v2 the RPC re-stamped started_at = now() which would skew
    // at-risk percent math when the outbox lagged.
    const rpcRes = await this.supabase.admin.rpc('repoint_sla_timer', {
      p_tenant_id: event.tenant_id,
      p_ticket_id: ticket_id,
      p_sla_policy_id: currentSlaId,
      p_timers: timers,
      p_reason: 'reclassified',
      p_started_at: startedAt.toISOString(),
    });

    if (rpcRes.error) {
      throw this.classifyRpcError(rpcRes.error, event);
    }

    const out = rpcRes.data as
      | { kind: 'repointed' | 'already_repointed'; timers_inserted?: number; timers_stopped?: number }
      | null;
    this.log.log(
      `${out?.kind ?? 'unknown'} ticket=${ticket_id} sla=${currentSlaId} inserted=${out?.timers_inserted ?? '?'} stopped=${out?.timers_stopped ?? '?'} event=${event.id}`,
    );
  }

  /**
   * Terminal taxonomy (codes raised by 00353 + 00340 validate_entity_in_tenant):
   *  - repoint_sla_timer.ticket_not_found    — ticket hard-deleted; terminal.
   *  - repoint_sla_timer.timers_required     — empty payload; handler bug.
   *  - repoint_sla_timer.unknown_timer_type  — handler bug.
   *  - validate_entity_in_tenant.sla_policy_not_in_tenant — cross-tenant.
   *
   * Anything else (PG wobble, lock timeout) is transient.
   */
  private classifyRpcError(
    rpcError: { code?: string; message: string; details?: string | null },
    event: OutboxEvent<SlaTimerRepointedPayload>,
  ): Error {
    const message = rpcError.message ?? '';
    const TERMINAL_TOKENS = [
      'repoint_sla_timer.ticket_not_found',
      'repoint_sla_timer.timers_required',
      'repoint_sla_timer.unknown_timer_type',
      'validate_entity_in_tenant.sla_policy_not_in_tenant',
    ];
    for (const token of TERMINAL_TOKENS) {
      if (message.includes(token)) {
        return new DeadLetterError(
          `repoint_sla_timer terminal error for event=${event.id} ticket=${event.payload.ticket_id}: ${message}`,
        );
      }
    }
    return new Error(
      `repoint_sla_timer transient error for event=${event.id} ticket=${event.payload.ticket_id}: ${message}`,
    );
  }
}
