import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { TenantContext } from '../../../common/tenant-context';
import { UUID_RE } from '../../../common/tenant-validation';
import { BundleCascadeAdapter } from '../../visitors/bundle-cascade.adapter';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * BundleServicesCancelledCascadeHandler — durable visitor cascade for the
 * BUNDLE-path order-line cancel (booking-audit remediation Slice 6, audit
 * 03 P1-4). Drains the `bundle.services_cancelled` outbox events emitted
 * in-tx by the atomic `cancel_order_lines_with_cascade` RPC
 * (supabase/migrations/00414_cancel_order_lines_with_cascade.sql, step 12;
 * one emit per bundle cancel, key
 * `bundle.services_cancelled:<booking_id>:<idempotency_key>`).
 *
 * ── Why this handler exists (plan remediation C2) ───────────────────────
 *
 * The legacy `BundleCascadeService.cancelBundle` ended with a lossy
 * in-process `BundleEventBus` emit (`bundle.cancelled`) consumed by
 * `BundleCascadeAdapter.handleBundleCancelled` — the SAME data-loss class
 * P0-1 eliminated for booking-cancel. Slice 6 retires that in-process emit
 * and routes the visitor cascade behind THIS durable handler. The
 * per-line (`p_line_ids` non-null) path emits nothing — its in-process
 * `bundle.line.cancelled` was a verified visitor no-op
 * (bundle-cascade.adapter.ts:235 `if (event.line_kind !== 'visitor')
 * return;`; lineKindForOli never returned 'visitor' for OLI lines), so a
 * new event + handler for a no-op would be scope creep.
 *
 * ── Why a distinct event type (NOT booking.cancelled / .cancel_cascade) ─
 *
 * The OutboxHandlerRegistry (outbox-handler.registry.ts) THROWS at Nest
 * boot on a duplicate (event_type, version). `booking.cancel_cascade_
 * required@v1` is already claimed by BookingCancelledCascadeHandler (the
 * Slice-2 booking-cancel handler). This is a DIFFERENT op — a
 * services-removed-booking-MAY-stay cancel, not a booking-cancel — so a
 * distinct `bundle.services_cancelled` event type is the correct,
 * scope-clean resolution (the same rationale 00408 documents for its two
 * distinct events).
 *
 * ── Reuse, not duplicate (contract mandate) ─────────────────────────────
 *
 * Synthesizes the `{kind:'bundle.cancelled', bundle_id:booking_id}` shape
 * and calls `BundleCascadeAdapter.handle(event)` DIRECTLY — exactly as
 * BookingCancelledCascadeHandler:178-183 does for booking-cancel. That
 * routes to the private `handleBundleCancelled` which walks visitors by
 * booking_id and runs the EXACT expected/pending → transitionStatus
 * ('cancelled') + arrived/in_meeting → host_alert matrix
 * (bundle-cascade.adapter.ts:311-339). Zero logic duplication; the
 * adapter is unchanged.
 *
 * ── Idempotency under at-least-once outbox retry ────────────────────────
 *
 * The outbox is at-least-once; this handler may run more than once per
 * event. The adapter's `VisitorService.transitionStatus` is a no-op on
 * same-status and raises invalid_transition when already terminal — the
 * adapter CATCHES that and logs+skips (bundle-cascade.adapter.ts:263-275).
 * So a replay does not double-cancel a visitor. The adapter's
 * domain_events intent CAN be re-inserted on replay — same property as
 * the in-process path today; accepted (the email worker dedups
 * downstream). No requester notification here: that is the
 * booking-CANCEL concern (BookingCancelledCascadeHandler); a
 * services-removed cancel that leaves the booking alive must NOT tell the
 * requester their booking was cancelled.
 *
 * ── Cross-tenant defense (memory: feedback_tenant_id_ultimate_rule) ─────
 *
 * Service-role bypasses RLS. payload.tenant_id must equal event.tenant_id
 * (mismatch → terminal DeadLetterError, mirrors
 * booking-cancelled-cascade.handler.ts:148-152). The adapter itself
 * filters every visitor read on event.tenant_id (adapter.ts:315-322).
 *
 * ── Errors ──────────────────────────────────────────────────────────────
 *
 * Transient failures throw a plain Error → outbox retry. Contract
 * violations (tenant mismatch, non-uuid booking_id) throw DeadLetterError
 * → immediate dead-letter. The visitor cascade's own per-visitor failures
 * are isolated INSIDE the adapter (it never rethrows a per-visitor
 * error).
 */

interface BundleServicesCancelledPayload {
  tenant_id: string;
  booking_id: string;
  cancelled_line_ids?: string[];
  booking_cancelled?: boolean;
}

@Injectable()
@OutboxHandler('bundle.services_cancelled', { version: 1 })
export class BundleServicesCancelledCascadeHandler
  implements OutboxEventHandler<BundleServicesCancelledPayload>
{
  constructor(
    @Inject(forwardRef(() => BundleCascadeAdapter))
    private readonly cascadeAdapter: BundleCascadeAdapter,
  ) {}

  async handle(
    event: OutboxEvent<BundleServicesCancelledPayload>,
  ): Promise<void> {
    const payload = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (!payload || payload.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `bundle_services_cancelled.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${payload?.tenant_id}`,
      );
    }

    // ── 2. Validate booking_id ───────────────────────────────────────────
    const bookingId = payload.booking_id;
    if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
      throw new DeadLetterError(
        `bundle_services_cancelled.booking_id_invalid: '${bookingId}' is not a uuid`,
      );
    }

    const tenantId = event.tenant_id;
    const occurredAt = new Date().toISOString();

    // ── 3. Visitor cascade — reuse the adapter's bundle.cancelled path ───
    // Under canonicalisation `bundle_id` IS the booking id
    // (bundle-cascade.adapter.ts:313-314). The adapter resolves visitors
    // by booking_id and runs the expected/pending → cancelled +
    // arrived/in_meeting → host_alert matrix. We run it inside the event
    // tenant so the adapter's VisitorService.transitionStatus calls have
    // a TenantContext (mirrors booking-cancelled-cascade.handler.ts:
    // 175-188 + outbox.worker.ts TenantContext.run wrapper).
    await TenantContext.run(
      { id: tenantId, slug: 'services-cancel-cascade', tier: 'standard' },
      async () => {
        await this.cascadeAdapter.handle({
          kind: 'bundle.cancelled',
          tenant_id: tenantId,
          bundle_id: bookingId,
          occurred_at: occurredAt,
        });
      },
    );
  }
}
