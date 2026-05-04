import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import type { CompensationOutcome } from './booking-transaction-boundary';

/**
 * /full-review v3 audit-event types — emitted to `audit_events` so ops
 * have a discoverable surface for orphaned bookings. Naming matches the
 * `event_type` convention used by ReservationService's audit pipeline
 * (booking.<verb>) so compensation events sort with their siblings.
 */
const AUDIT_COMPENSATION_FAILED = 'booking.compensation_failed';
const AUDIT_COMPENSATION_PARTIAL = 'booking.compensation_partial_failure';

/**
 * Phase 1.3 — thin wrapper over the `delete_booking_with_guard` RPC
 * (migration 00292). Surfaces the structured jsonb outcome to the
 * BookingTransactionBoundary as a typed `CompensationOutcome`.
 *
 * Why a separate service vs. inlining the RPC call in the boundary:
 *   - Boundary is generic (operation + compensate callbacks); compensation
 *     for booking is a specific Supabase concern. Keeping them separate
 *     means Phase 6 can swap the boundary to outbox-driven without
 *     re-touching the RPC plumbing.
 *   - Tests mock the RPC at this seam; the boundary is tested with a
 *     stub compensate function.
 *
 * Codex 2026-05-04 (cited in plan §1.3 Read first #11): inject `SupabaseService`
 * directly, NOT `{ admin: SupabaseClient }` — Nest can't resolve a destructured
 * shape as a provider token.
 */
@Injectable()
export class BookingCompensationService {
  private readonly log = new Logger(BookingCompensationService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Attempt to delete a booking that was just created (as part of a
   * compensation flow after attachServicesToBooking failed). Returns the
   * RPC's structured outcome:
   *   - 'rolled_back'      → booking + slots + cascades gone; safe.
   *   - 'partial_failure'  → booking still alive because a blocker
   *                          (recurrence_series, today) is present.
   *
   * On RPC error (network, 5xx, malformed return), throws
   * BadRequestException with code 'booking.compensation_failed' so the
   * boundary can surface the failure without masking the original
   * operation error. The boundary handles this case explicitly — see
   * InProcessBookingTransactionBoundary.runWithCompensation.
   *
   * Tenant scope is read from the AsyncLocalStorage TenantContext (the
   * standard for service-role admin client calls — the RPC is SECURITY
   * INVOKER but the admin client bypasses RLS, so we pass p_tenant_id
   * explicitly per the create_booking + edit_booking_slot conventions).
   */
  async deleteBooking(bookingId: string): Promise<CompensationOutcome> {
    const tenantId = TenantContext.current().id;

    const { data, error } = await this.supabase.admin.rpc(
      'delete_booking_with_guard',
      { p_booking_id: bookingId, p_tenant_id: tenantId },
    );

    if (error) {
      this.log.error(
        `delete_booking_with_guard RPC failed for booking ${bookingId}: ${error.message}`,
      );
      // /full-review v3 fix — emit audit BEFORE throwing so ops have a
      // discoverable signal for the orphan. The thrown 500 is the
      // user-visible response; the audit row is for operators.
      await this.tryAudit(tenantId, bookingId, AUDIT_COMPENSATION_FAILED, {
        rpc_error: error.message,
      });
      // InternalServerError (500), not 400. The compensation RPC
      // failing is server-class: the booking persists in an unknown
      // post-attach state, the user can't fix it via input changes,
      // ops needs a 500 + traceId per CLAUDE.md error-handling spec §3.3.
      throw new InternalServerErrorException({
        code: 'booking.compensation_failed',
        message: 'Compensation RPC failed.',
        booking_id: bookingId,
        rpc_error: error.message,
      });
    }

    // The RPC returns jsonb. supabase-js surfaces it as a parsed JS object
    // when the function declares `returns jsonb` (vs. `returns table` which
    // surfaces as an array). See migration 00292 for the shape.
    const parsed = data as
      | { kind: 'rolled_back' }
      | { kind: 'partial_failure'; blocked_by: string[] }
      | null;

    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
      this.log.error(
        `delete_booking_with_guard returned malformed payload for booking ${bookingId}: ${JSON.stringify(
          data,
        )}`,
      );
      await this.tryAudit(tenantId, bookingId, AUDIT_COMPENSATION_FAILED, {
        rpc_error: 'malformed_payload',
        rpc_data: data,
      });
      throw new InternalServerErrorException({
        code: 'booking.compensation_failed',
        message: 'Compensation RPC returned no/malformed outcome.',
        booking_id: bookingId,
      });
    }

    if (parsed.kind === 'rolled_back') {
      // Clean rollback — no audit needed; the booking is gone, recovery
      // already happened. Original-operation error is the user-visible signal.
      return { kind: 'rolled_back', bookingId };
    }

    // partial_failure — booking still alive, blockers prevent safe deletion.
    // Emit an audit_events row BEFORE returning so the operator who sees
    // the 400 (raised by the boundary) has a discoverable surface to triage.
    const blockedBy = Array.isArray(parsed.blocked_by) ? parsed.blocked_by : [];
    await this.tryAudit(tenantId, bookingId, AUDIT_COMPENSATION_PARTIAL, {
      blocked_by: blockedBy,
    });
    return {
      kind: 'partial_failure',
      bookingId,
      blockedBy,
    };
  }

  /**
   * Best-effort audit emit. We're either about to throw a 500 (the user
   * sees an error regardless) or about to return a partial_failure
   * outcome (the boundary will throw 400). Either way, a failed audit
   * insert must NOT mask the underlying compensation problem — log and
   * proceed.
   */
  private async tryAudit(
    tenantId: string,
    bookingId: string,
    eventType: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: 'booking',
        entity_id: bookingId,
        details,
      });
      if (error) {
        this.log.error(
          `audit_events insert failed for ${eventType} on booking ${bookingId}: ${error.message}`,
        );
      }
    } catch (err) {
      this.log.error(
        `audit_events insert threw for ${eventType} on booking ${bookingId}: ${
          (err as Error).message
        }`,
      );
    }
  }
}
