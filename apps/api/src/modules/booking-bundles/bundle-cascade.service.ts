import { Injectable } from '@nestjs/common';
import { buildCancelOrderLinesIdempotencyKey } from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors, wrapPgError } from '../../common/errors';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { TenantContext } from '../../common/tenant-context';
import { BundleVisibilityService, type BundleVisibilityContext } from './bundle-visibility.service';

/**
 * BundleCascadeService — cancellation orchestration per spec §5.3.
 *
 * Three entry points with distinct semantics:
 *
 *   - cancelLine(line_id)         — single order_line_item + its
 *                                   work-order ticket + its asset_reservation;
 *                                   approvals re-scoped (auto-close if scope
 *                                   drops to empty).
 *   - cancelReservation(res_id)   — smart-default cascade dialog. Fulfilled
 *                                   lines stay (greyed in UI); bundle stays
 *                                   alive if anything non-fulfilled remains.
 *   - cancelBundle(bundle_id)     — full cascade. The bundle = "this whole
 *                                   event". Same fulfilled-line protection.
 *
 * Fulfilled lines (`order_line_items.fulfillment_status` past 'confirmed')
 * are protected — caller must surface them as "cannot cancel".
 *
 * Recurring scope cancel reuses the existing `RecurrenceService.cancelForward`
 * via `recurrence_scope` argument — see Task 27 for the materialiser hook.
 * For v1 we cancel only the master occurrence's bundle; series-level cancel
 * is the same as cancelling the recurrence_series_id reservations chain.
 */

export type CancelScope = 'this' | 'this_and_following' | 'series';

export interface CancelLineArgs {
  line_id: string;
  /** Caller-supplied for audit trail. Optional. */
  reason?: string;
  /**
   * Booking-audit Slice 6 (audit 03 P1-4): the X-Client-Request-Id, the
   * command_operations idempotency boundary for cancel_order_lines_with_
   * cascade (00414). The controller's RequireClientRequestIdGuard enforces
   * presence at the HTTP boundary; the service-layer hard-fail enforces it
   * for internal callers (mirrors BundleService.attachServicesToBooking:266
   * + ReservationService.cancelOne:487).
   */
  client_request_id?: string;
  /**
   * Booking-audit Slice 6 fix-cycle (Fix C): the caller's auth_uid (the JWT
   * subject — `req.user.id`, NOT users.id). Threaded to the 00414 RPC as
   * `p_actor_user_id`; F-CRIT-1 (00414:192-205) resolves it to
   * `users.id` for `audit_events.actor_user_id`. Cancel-family-consistent
   * with `ReservationService.cancelOne` → `cancel_booking_with_cascade`
   * (reservation.service.ts:505 passes `actor.auth_uid`). `null` for
   * internal/system callers with no actor — F-CRIT-1 skips resolution on
   * null and records a system-attributed audit row.
   */
  actor_auth_uid?: string | null;
}

export interface CancelBundleArgs {
  bundle_id: string;
  /** Lines to keep alive — everything else cancels. Empty = cancel all. */
  keep_line_ids?: string[];
  /**
   * Post-canonicalisation (2026-05-02): the booking IS the bundle, so a
   * "single occurrence" cancel scoped to one booking targets `orders.booking_id`
   * directly. The legacy `linked_reservation_id` filter has no semantic
   * counterpart on the new schema (each occurrence is its own booking, with
   * its own orders attached via `orders.booking_id`). For recurrence
   * cancellation: the caller already iterates per-occurrence and calls us
   * with the occurrence's booking id as `bundle_id`, so this field is
   * effectively unused now. Kept on the interface for caller-signature
   * stability through the slice rewrite; ignored by the cascade.
   */
  reservation_id?: string;
  recurrence_scope?: CancelScope;
  reason?: string;
  /** Booking-audit Slice 6: X-Client-Request-Id (00414 idempotency key). */
  client_request_id?: string;
  /**
   * Booking-audit Slice 6 fix-cycle (Fix C): the caller's auth_uid (JWT
   * subject), threaded to the 00414 RPC as `p_actor_user_id`. See
   * `CancelLineArgs.actor_auth_uid` for the full F-CRIT-1 rationale.
   */
  actor_auth_uid?: string | null;
}

/**
 * Shape of the `cancel_order_lines_with_cascade` (00414) jsonb return.
 * Mirrors the migration's step-13 result envelope.
 */
interface CancelOrderLinesRpcResult {
  cancelled_line_ids: string[];
  cascaded: { ticket_ids: string[]; asset_reservation_ids: string[] };
  rescoped_approval_ids: string[];
  expired_approval_ids: string[];
  booking_cancelled: boolean;
  fulfilled_line_ids: string[];
  kept_line_ids: string[];
}

@Injectable()
export class BundleCascadeService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly visibility: BundleVisibilityService,
  ) {}

  /**
   * Cancel a single service line + its downstream work-order + asset
   * reservation, re-scoping pending approvals.
   *
   * Booking-audit remediation Slice 6 (audit 03 P1-4): this is now a THIN
   * wrapper over the atomic `cancel_order_lines_with_cascade` RPC (00414).
   * The legacy multi-write choreography (asset_reservations → work_orders
   * → order_line_items → rescopeApprovalsAfterLineCancel → swallowed
   * audit) + the lossy in-process `bundle.line.cancelled` BundleEventBus
   * emit are GONE. They are replaced by ONE Postgres transaction. The
   * per-line in-process emit was a VERIFIED visitor no-op
   * (bundle-cascade.adapter.ts:235 `if (event.line_kind !== 'visitor')
   * return;`; lineKindForOli never returned 'visitor' for OLI lines —
   * old bundle-cascade.service.ts:652-655), so it is dropped with NO
   * replacement event/handler (plan remediation C2).
   *
   * The line/bundle pre-checks (tenant 404 + bundle visibility assert) are
   * preserved so a non-visible / cross-tenant caller still 404s/403s
   * before the RPC; the RPC then re-validates line_not_found /
   * line_not_in_bundle / line_already_fulfilled tenant-side as
   * defense-in-depth (mirroring the live cancelLine validation order).
   */
  async cancelLine(args: CancelLineArgs, ctx: BundleVisibilityContext): Promise<{
    line_id: string;
    cascaded: { ticket_ids: string[]; asset_reservation_ids: string[] };
    closed_approval_ids: string[];
  }> {
    const tenantId = TenantContext.current().id;
    const line = await this.loadLine(args.line_id, tenantId);
    if (!line) throw AppErrors.notFoundWithCode('line_not_found', `Line ${args.line_id} not found.`);
    // Sub-project 2 only owns bundle-linked lines (mirrors the live
    // pre-rewrite guard at bundle-cascade.service.ts:88).
    if (!line.bundle_id) {
      throw AppErrors.notFoundWithCode('bundle.line_not_in_bundle', `Line ${args.line_id} is not part of a bundle.`);
    }
    const bundle = await this.loadBundle(line.bundle_id, tenantId);
    if (!bundle) {
      throw AppErrors.notFound('bundle', line.bundle_id);
    }
    await this.visibility.assertVisible(bundle, ctx);

    // X-Client-Request-Id is the command_operations idempotency boundary.
    // RequireClientRequestIdGuard enforces presence at the HTTP boundary;
    // this service-layer hard-fail enforces it for internal callers
    // (mirrors BundleService.attachServicesToBooking:266-273).
    const clientRequestId = args.client_request_id;
    if (!clientRequestId) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail:
          'cancelLine reached the RPC layer with no client_request_id ' +
          'despite RequireClientRequestIdGuard (booking-audit Slice 6).',
      });
    }

    const result = await this.callCancelOrderLinesRpc({
      bookingId: line.bundle_id,
      lineIds: [args.line_id],
      keepLineIds: null,
      tenantId,
      clientRequestId,
      reason: args.reason,
      actorAuthUid: args.actor_auth_uid ?? null,
    });

    // Preserve the legacy cancelLine return shape (the RPC's per-line
    // path expires — not "rescopes" — approvals that drop to empty; both
    // map onto the legacy `closed_approval_ids` field).
    return {
      line_id: args.line_id,
      cascaded: {
        ticket_ids: result.cascaded.ticket_ids,
        asset_reservation_ids: result.cascaded.asset_reservation_ids,
      },
      closed_approval_ids: result.expired_approval_ids,
    };
  }


  /**
   * Full bundle / services cancel with optional opt-out via
   * `keep_line_ids`. The booking row + slots go cancelled IFF nothing
   * stays alive (no fulfilled line AND no kept line) — the live weak
   * condition is reproduced VERBATIM inside the 00414 RPC.
   *
   * Booking-audit remediation Slice 6 (audit 03 P1-4): a THIN wrapper
   * over the atomic `cancel_order_lines_with_cascade` RPC (00414),
   * `p_line_ids = NULL` (= all cancellable under p_keep_line_ids). The
   * legacy multi-write choreography + cancelPendingApprovalsForBundle +
   * swallowed audit + the lossy in-process `bundle.cancelled`
   * BundleEventBus emit are GONE. The bundle path now emits a DURABLE
   * `bundle.services_cancelled` outbox event in-tx; the visitor cascade
   * runs behind BundleServicesCancelledCascadeHandler →
   * BundleCascadeAdapter.handleBundleCancelled (the durable replacement
   * for the in-process bus path).
   */
  async cancelBundle(args: CancelBundleArgs, ctx: BundleVisibilityContext): Promise<{
    bundle_id: string;
    cancelled_line_ids: string[];
    cancelled_reservation_ids: string[];
    cancelled_ticket_ids: string[];
    cancelled_asset_reservation_ids: string[];
    closed_approval_ids: string[];
    fulfilled_line_ids: string[];
  }> {
    const tenantId = TenantContext.current().id;
    const bundle = await this.loadBundle(args.bundle_id, tenantId);
    if (!bundle) throw AppErrors.notFound('bundle', args.bundle_id);
    await this.visibility.assertVisible(bundle, ctx);

    // X-Client-Request-Id is the command_operations idempotency boundary
    // (mirrors cancelLine above + BundleService.attachServicesToBooking:266).
    const clientRequestId = args.client_request_id;
    if (!clientRequestId) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail:
          'cancelBundle reached the RPC layer with no client_request_id ' +
          'despite RequireClientRequestIdGuard (booking-audit Slice 6).',
      });
    }

    const result = await this.callCancelOrderLinesRpc({
      bookingId: args.bundle_id,
      lineIds: null,
      keepLineIds: args.keep_line_ids ?? null,
      tenantId,
      clientRequestId,
      reason: args.reason,
      actorAuthUid: args.actor_auth_uid ?? null,
    });

    // Preserve the legacy cancelBundle return shape. The RPC closes the
    // booking + slots itself (booking_cancelled); the legacy
    // `cancelled_reservation_ids` carried the booking id when the booking
    // was cancelled (old cancelBundleImpl pushed args.bundle_id).
    return {
      bundle_id: args.bundle_id,
      cancelled_line_ids: result.cancelled_line_ids,
      cancelled_reservation_ids: result.booking_cancelled ? [args.bundle_id] : [],
      cancelled_ticket_ids: result.cascaded.ticket_ids,
      cancelled_asset_reservation_ids: result.cascaded.asset_reservation_ids,
      closed_approval_ids: result.expired_approval_ids,
      fulfilled_line_ids: result.fulfilled_line_ids,
    };
  }

  /**
   * Shared thin-RPC dispatcher for cancelLine + cancelBundle. Mirrors the
   * attach/cancel error-mapping pattern (BundleService.mapAttachRpcError
   * bundle.service.ts:389-434 + ReservationService.cancelOne:512-523
   * which routes recognised raises through mapRpcErrorToAppError with a
   * booking-scoped 500 fallback).
   */
  private async callCancelOrderLinesRpc(args: {
    bookingId: string;
    lineIds: string[] | null;
    keepLineIds: string[] | null;
    tenantId: string;
    clientRequestId: string;
    reason?: string;
    actorAuthUid: string | null;
  }): Promise<CancelOrderLinesRpcResult> {
    const idempotencyKey = buildCancelOrderLinesIdempotencyKey(
      args.bookingId,
      args.clientRequestId,
    );
    const { data: rpcData, error: rpcErr } = await this.supabase.admin.rpc(
      'cancel_order_lines_with_cascade',
      {
        p_booking_id: args.bookingId,
        p_line_ids: args.lineIds,
        p_keep_line_ids: args.keepLineIds,
        p_tenant_id: args.tenantId,
        // F-CRIT-1: the RPC resolves this via `where u.auth_uid =
        // p_actor_user_id and u.tenant_id = p_tenant_id` (00414:192-205).
        // Booking-audit Slice 6 fix-cycle (Fix C): the controller threads
        // its in-scope `authUid` (req.user.id = JWT subject = auth_uid, the
        // SAME value `ReservationService.cancelOne` passes to
        // `cancel_booking_with_cascade` at reservation.service.ts:505) so
        // `audit_events.actor_user_id` gets the real `users.id` and
        // `cancel_order_lines_with_cascade.actor_not_found` is correctly
        // reachable for an unregistered actor. `null` for internal/system
        // callers — F-CRIT-1 already skips resolution on null and records a
        // system-attributed audit row (00414:192).
        p_actor_user_id: args.actorAuthUid,
        p_reason: args.reason ?? null,
        p_idempotency_key: idempotencyKey,
      },
    );
    if (rpcErr) {
      throw this.mapCancelOrderLinesRpcError(rpcErr);
    }
    const result = (rpcData ?? null) as CancelOrderLinesRpcResult | null;
    if (!result || !Array.isArray(result.cancelled_line_ids)) {
      throw AppErrors.server('booking.unexpected_error', {
        detail: 'cancel_order_lines_with_cascade returned an unexpected shape',
      });
    }
    return result;
  }

  /**
   * Map a PostgREST `cancel_order_lines_with_cascade` RPC error to the
   * appropriate AppError. The recognised dotted codes
   * (cancel_order_lines_with_cascade.{actor_not_found, booking_not_found,
   * line_not_found, line_not_in_bundle, line_already_fulfilled,
   * invalid_args} + command_operations.payload_mismatch) are all
   * registered (STATUS_BY_CODE in common/errors/map-rpc-error.ts + the
   * KnownErrorCode union/registry in packages/shared/src/error-codes.ts +
   * EN/NL messages). `booking.cancel_failed` is the booking-scoped 500
   * fallback for any unrecognised raise — identical posture to
   * ReservationService.cancelOne:522.
   */
  private mapCancelOrderLinesRpcError(
    rpcError: { code?: string; message?: string },
  ): Error {
    return mapRpcErrorToAppError(rpcError as Error, {
      fallbackCode: 'booking.cancel_failed',
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadLine(id: string, tenantId: string): Promise<{
    id: string;
    fulfillment_status: string | null;
    linked_asset_reservation_id: string | null;
    linked_ticket_id: string | null;
    order_id: string;
    bundle_id: string | null;
  } | null> {
    const { data, error } = await this.supabase.admin
      .from('order_line_items')
      .select('id, fulfillment_status, linked_asset_reservation_id, linked_ticket_id, order_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) {
      throw wrapPgError(error, 'bundle.cascade_line_lookup_failed', {
        detail: `order_line_items lookup for cascade (${id}) failed`,
        notFoundCode: 'bundle.line_not_in_bundle',
      });
    }
    if (!data) return null;
    const row = data as {
      id: string;
      fulfillment_status: string | null;
      linked_asset_reservation_id: string | null;
      linked_ticket_id: string | null;
      order_id: string;
    };
    // Walk to bundle_id via orders. Tenant-filter as defence-in-depth in
    // case a malformed line ever points at a cross-tenant order.
    // Column rename: orders.booking_bundle_id → orders.booking_id (00278:109).
    const { data: order, error: orderErr } = await this.supabase.admin
      .from('orders')
      .select('booking_id')
      .eq('id', row.order_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (orderErr) {
      throw wrapPgError(orderErr, 'bundle.cascade_order_lookup_failed', {
        detail: `orders lookup for cascade (line ${id}, order ${row.order_id}) failed`,
      });
    }
    return {
      ...row,
      bundle_id: (order as { booking_id: string | null } | null)?.booking_id ?? null,
    };
  }

  /**
   * Load the booking row that this cascade operates on. Pre-rewrite this
   * read from `booking_bundles`; under canonicalisation the booking IS the
   * bundle (00277:27). `primary_reservation_id` is dropped — the booking's
   * own id is the anchor, and slots are looked up via `booking_id` on
   * `booking_slots` (00277:119).
   */
  private async loadBundle(id: string, tenantId: string): Promise<{
    id: string;
    requester_person_id: string;
    host_person_id: string | null;
    location_id: string;
  } | null> {
    const { data, error } = await this.supabase.admin
      .from('bookings')
      .select('id, requester_person_id, host_person_id, location_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) {
      throw wrapPgError(error, 'bundle.cascade_booking_lookup_failed', {
        detail: `bookings lookup for cascade (${id}) failed`,
        notFoundCode: 'bundle.not_found',
      });
    }
    return (data as {
      id: string;
      requester_person_id: string;
      host_person_id: string | null;
      location_id: string;
    } | null) ?? null;
  }
}

