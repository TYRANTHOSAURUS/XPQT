import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { DbService } from '../../../common/db/db.service';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { TenantContext } from '../../../common/tenant-context';
import { UUID_RE } from '../../../common/tenant-validation';
import { BundleCascadeAdapter } from '../../visitors/bundle-cascade.adapter';
import { BookingNotificationsService } from '../../reservations/booking-notifications.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from '../../reservations/reservation-projection';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * BookingCancelledCascadeHandler — durable cascade for the user-cancel
 * path. Drains the `booking.cancel_cascade_required` outbox events emitted
 * by the atomic `cancel_booking_with_cascade` RPC
 * (supabase/migrations/00408_cancel_booking_with_cascade.sql, one emit per
 * cancelled booking, key `booking.cancel_cascade_required:<id>:user_cancel`).
 *
 * Booking-audit remediation Slice 2 (audit 03 P0-1 / P1-5). Equivalence
 * contract: docs/follow-ups/cancel-booking-equivalence-checklist.md. This
 * handler owns the OBX-column rows:
 *   - 4.0/4.1 — adapter expected/pending visitors →
 *     VisitorService.transitionStatus('cancelled') (marker-safe FOR UPDATE,
 *     preserves the 00270 single-write-path marker + visitor audit +
 *     visitor.cancelled emit).
 *   - 4.2     — visitor.cascade.cancelled domain_event (email intent).
 *   - 4.3     — adapter arrived/in_meeting host alert
 *     (visitor.cascade.host_alert domain_event; no status change).
 *   - 1.3/5.1 — requester reservation_cancelled notification.
 *   - 5.2     — reservation.notification_sent audit row.
 *
 * ── Why a distinct event type (NOT booking.cancelled) ───────────────────
 *
 * The OutboxHandlerRegistry (outbox-handler.registry.ts:62-78) THROWS at
 * Nest boot on a duplicate (event_type, version). `booking.cancelled@v1`
 * is ALREADY claimed by WorkflowSpawnWakeOnBookingCancelledHandler
 * (workflow-spawn-wake.handler.ts:544). A second @OutboxHandler for it
 * would crash boot. The RPC therefore emits TWO events per cancelled
 * booking: `booking.cancelled` (the workflow Tier 2 wake — closes P1-5)
 * AND `booking.cancel_cascade_required` (this handler — the cascade).
 * They coexist; neither replaces the other.
 *
 * ── Reuse, not duplicate (contract mandate) ─────────────────────────────
 *
 * Visitor cascade: this handler synthesizes a `bundle.cancelled` event and
 * calls `BundleCascadeAdapter.handle(event)` DIRECTLY (the public
 * direct-dispatch entry point documented at bundle-cascade.adapter.ts:
 * 103-123; it switches on event.kind and routes to the private
 * handleBundleCancelled). That walks visitors by booking_id and runs the
 * EXACT expected/pending → transitionStatus('cancelled') + arrived/
 * in_meeting → host_alert branching (adapter.ts:255-307) — zero logic
 * duplication, so the cascade can't diverge from the in-process
 * cancelLine/cancelBundle path (which keeps the in-process bus per P1-4).
 *
 * Requester notification: reuses `BookingNotificationsService.onCancelled`
 * verbatim (booking-notifications.service.ts:72-95 — the
 * `reservation_cancelled` NotificationService.send + the
 * `reservation.notification_sent` audit row). Only the Reservation FETCH
 * is handler-local (built via the canonical SLOT_WITH_BOOKING_SELECT +
 * slotWithBookingToReservation projection) — the send + audit are not
 * re-implemented.
 *
 * ── Idempotency under at-least-once outbox retry ────────────────────────
 *
 * The outbox is at-least-once; this handler may run more than once per
 * event. Idempotency:
 *   - Visitor transition: `VisitorService.transitionStatus` is a no-op on
 *     same-status (visitor.service.ts:139) and raises invalid_transition
 *     when already terminal — the adapter CATCHES that and logs+skips
 *     (adapter.ts:263-275). So a replay does not double-cancel a visitor.
 *     The adapter's domain_event intent (visitor.cascade.cancelled) CAN be
 *     re-inserted on replay — same property as the in-process path today;
 *     accepted (the email worker dedups downstream; the intent log is a
 *     "what we should email" journal, not an exactly-once contract).
 *   - Requester notification: deduped via a Postgres transaction-scoped
 *     advisory lock keyed deterministically on (tenant, booking) PLUS an
 *     audit-existence check, BOTH inside the same `DbService.tx`. The
 *     bare check→send→write sequence was TOCTOU-racy (I-2): two
 *     concurrent at-least-once redeliveries of the same event could each
 *     see "no audit row" before either wrote one, double-sending
 *     `reservation_cancelled`. Now the second redelivery blocks on
 *     `pg_advisory_xact_lock(NS, hash(tenant:booking))` until the first
 *     commits; by then the first's `reservation.notification_sent` audit
 *     row is visible, so the second's in-lock check finds it and skips.
 *     The lock is held for the whole check+send+commit window. (Same
 *     advisory-lock-around-a-critical-section pattern as
 *     RetentionWorker.runOneWithLock — retention.worker.ts:150-180:
 *     `db.tx` + `pg_advisory_xact_lock(NS, key)`.) NotificationService
 *     .send still takes no idempotency key — the lock + audit check is
 *     what makes the requester send exactly-once under retry.
 *
 * ── Cross-tenant defense (memory: feedback_tenant_id_ultimate_rule) ─────
 *
 * Service-role bypasses RLS. payload.tenant_id must equal event.tenant_id
 * (mismatch → terminal DeadLetterError, mirrors
 * workflow-spawn-wake.handler.ts:216-220). Every downstream read is
 * tenant-scoped; the adapter itself filters every visitor read on
 * event.tenant_id (adapter.ts:52-55).
 *
 * ── Errors ──────────────────────────────────────────────────────────────
 *
 * Transient failures throw a plain Error → outbox retry per §4.4.
 * Contract violations (tenant mismatch, non-uuid booking_id) throw
 * DeadLetterError → immediate dead-letter per §4.5. The visitor cascade's
 * own per-visitor failures are isolated INSIDE the adapter (it never
 * rethrows a per-visitor error); a failure to even start the cascade
 * (e.g. DB unreachable) propagates so the event retries.
 */

interface BookingCancelCascadePayload {
  tenant_id: string;
  booking_id: string;
  reason?: string;
  started_at?: string;
}

@Injectable()
@OutboxHandler('booking.cancel_cascade_required', { version: 1 })
export class BookingCancelledCascadeHandler
  implements OutboxEventHandler<BookingCancelCascadePayload>
{
  private readonly log = new Logger(BookingCancelledCascadeHandler.name);

  // Lock-key namespace for pg_advisory_xact_lock — distinct per-subsystem
  // first int (mirrors RetentionWorker.LOCK_NS_RETENTION / DaglijstScheduler
  // conventions: a stable 4-ASCII-byte tag so unrelated subsystems never
  // collide on the same lock space). 'BCXL' = booking-cancel-cascade.
  private static readonly LOCK_NS_BOOKING_CANCEL = 0x4243_584c; // 'BCXL'

  constructor(
    private readonly supabase: SupabaseService,
    private readonly db: DbService,
    @Inject(forwardRef(() => BundleCascadeAdapter))
    private readonly cascadeAdapter: BundleCascadeAdapter,
    @Inject(forwardRef(() => BookingNotificationsService))
    private readonly bookingNotifications: BookingNotificationsService,
  ) {}

  async handle(event: OutboxEvent<BookingCancelCascadePayload>): Promise<void> {
    const payload = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (!payload || payload.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `booking_cancel_cascade.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${payload?.tenant_id}`,
      );
    }

    // ── 2. Validate booking_id ───────────────────────────────────────────
    const bookingId = payload.booking_id;
    if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
      throw new DeadLetterError(
        `booking_cancel_cascade.booking_id_invalid: '${bookingId}' is not a uuid`,
      );
    }

    const tenantId = event.tenant_id;
    const reason = payload.reason ?? 'user_cancel';
    const occurredAt = payload.started_at ?? new Date().toISOString();

    // ── 3. Visitor cascade — reuse the adapter's bundle.cancelled path ───
    // Under canonicalisation `bundle_id` IS the booking id (adapter.ts:
    // 313-314). The adapter resolves visitors by booking_id and runs the
    // expected/pending → cancelled + arrived/in_meeting → host_alert
    // matrix. We run it inside the event tenant so the adapter's
    // VisitorService.transitionStatus calls have a TenantContext (the
    // adapter also re-establishes via runInTenant, but we set it here so
    // its first reads are scoped too — mirrors the worker's
    // TenantContext.run wrapper at outbox.worker.ts:217).
    await TenantContext.run(
      { id: tenantId, slug: 'cancel-cascade', tier: 'standard' },
      async () => {
        await this.cascadeAdapter.handle({
          kind: 'bundle.cancelled',
          tenant_id: tenantId,
          bundle_id: bookingId,
          occurred_at: occurredAt,
        });

        // ── 4. Requester notification — deduped via audit existence ──────
        await this.maybeNotifyRequester(tenantId, bookingId, reason);
      },
    );
  }

  /**
   * Send the requester `reservation_cancelled` notification + its
   * `reservation.notification_sent` audit row — but only if not already
   * sent for this booking (at-least-once dedup). Reuses
   * BookingNotificationsService.onCancelled (does the send + audit); only
   * the Reservation fetch is local.
   *
   * I-2 — race-free dedup. The check→send→audit sequence is wrapped in a
   * `DbService.tx` holding `pg_advisory_xact_lock(NS, hash(tenant:booking))`
   * for the whole window. Two concurrent at-least-once redeliveries of the
   * SAME event serialise on the lock: the second blocks until the first's
   * tx commits, by which point the first's `reservation.notification_sent`
   * audit row (written by `onCancelled` via PostgREST autocommit, BEFORE
   * the tx commits) is visible, so the second's in-lock check finds it and
   * skips. Without the lock, both could read "no audit row" before either
   * wrote one → double `reservation_cancelled` (the TOCTOU finding). The
   * lock is the only authoritative concurrency primitive here; the audit
   * check inside it is the dedup decision. Pattern: identical to
   * RetentionWorker.runOneWithLock (retention.worker.ts:150-180).
   */
  private async maybeNotifyRequester(
    tenantId: string,
    bookingId: string,
    reason: string,
  ): Promise<void> {
    // Slot fetch is a pure read with no dedup race — keep it OUTSIDE the
    // lock so we don't hold the advisory lock across an HTTP round-trip
    // when there's nothing to notify. Build a Reservation via the
    // canonical slot-embed projection (any slot of the booking —
    // onCancelled only reads booking-level fields: space_id / tenant_id /
    // start_at / end_at / attendee_count / id / requester_person_id).
    // Tenant-scoped read (#0 invariant).
    const { data: slotRow, error: slotErr } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (slotErr) {
      throw new Error(
        `booking_cancel_cascade.slot_read_failed: ${slotErr.message} (booking=${bookingId})`,
      );
    }
    if (!slotRow) {
      // No slot row for this booking — nothing to notify about (the
      // booking may have been hard-deleted by a compensation path after
      // the cascade event was enqueued). Not an error; log + return so
      // the event is acked (a retry would also find no slot).
      this.log.warn(
        `no booking_slots row for booking=${bookingId} tenant=${tenantId} — skipping requester notification`,
      );
      return;
    }

    const reservation = slotWithBookingToReservation(
      slotRow as unknown as SlotWithBookingEmbed,
    );

    // Deterministic 32-bit lock key from (tenant:booking). Collisions are
    // tolerable — at worst two unrelated bookings serialise their
    // requester-notify (same rationale as RetentionWorker.lockKeyFor).
    const lockKey = this.notifyLockKey(tenantId, bookingId);

    await this.db.tx(async (client) => {
      // Acquire the lock for the whole check+send window. Blocking
      // (xact_lock, NOT try_) — a concurrent redelivery must WAIT for the
      // in-flight one to finish so it then observes the audit row, rather
      // than skipping the send entirely (which would drop the
      // notification if the first attempt later fails and rolls back its
      // own work — onCancelled's audit is autocommit, so on its success
      // the row is durable regardless of our tx outcome).
      await client.query(
        `select pg_advisory_xact_lock($1, $2)`,
        [BookingCancelledCascadeHandler.LOCK_NS_BOOKING_CANCEL, lockKey],
      );

      // Dedup check INSIDE the lock + INSIDE the tx (so it sees the
      // committed audit row a prior holder wrote before releasing). A
      // prior successful run wrote a `reservation.notification_sent`
      // audit row with details->>'kind'='cancelled' for this booking;
      // booking-scoped AND kind-scoped (a `created`/`released` notif for
      // the same booking must not suppress the cancel notif).
      let existing: { rowCount: number | null };
      try {
        existing = await client.query(
          `select 1
             from public.audit_events
            where tenant_id = $1
              and event_type = 'reservation.notification_sent'
              and entity_type = 'booking'
              and entity_id = $2
              and details->>'kind' = 'cancelled'
            limit 1`,
          [tenantId, bookingId],
        );
      } catch (err) {
        // Transient DB wobble — let the outbox retry rather than risk a
        // double-send (fail closed toward "retry", not "send").
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `booking_cancel_cascade.dedup_check_failed: ${message} (booking=${bookingId})`,
        );
      }
      if ((existing.rowCount ?? 0) > 0) {
        this.log.log(
          `requester notification already sent for booking=${bookingId} — skipping (idempotent replay)`,
        );
        return;
      }

      // Reuse BookingNotificationsService.onCancelled verbatim — it sends
      // the `reservation_cancelled` notification AND writes the
      // `reservation.notification_sent` audit row (via PostgREST,
      // autocommit — durable independent of THIS tx; that is what makes
      // a later lock holder's in-lock check observe it). Its own
      // try/catch makes a notification failure non-fatal; the audit row
      // is what our dedup check keys on, so a partial failure simply
      // retries the whole thing next outbox attempt — at-least-once,
      // never zero. The advisory lock is released when this tx commits.
      await this.bookingNotifications.onCancelled(reservation, reason);
    });
  }

  /**
   * Hash (tenantId, bookingId) into a stable 32-bit lock key. Mirrors
   * RetentionWorker.lockKeyFor — a plain rolling hash, no DB-side mapping.
   */
  private notifyLockKey(tenantId: string, bookingId: string): number {
    let h = 0;
    const s = `${tenantId}:${bookingId}`;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return h;
  }
}
