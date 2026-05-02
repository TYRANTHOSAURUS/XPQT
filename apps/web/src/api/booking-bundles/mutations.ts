import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bundleKeys } from './keys';
import { approvalKeys } from '@/api/approvals';
import { roomBookingKeys } from '@/api/room-booking';
import { ticketKeys } from '@/api/tickets';

/**
 * Booking-canonicalisation rewrite (2026-05-02): all `/booking-bundles/*`
 * HTTP routes are GONE — the controller was deleted entirely
 * (apps/api/src/modules/booking-bundles/booking-bundles.module.ts:27).
 *
 * The hooks below are TRANSITIONAL STUBS. Their type signatures and
 * cache-invalidation semantics are preserved so existing components
 * (BundleServicesSection, BundleWorkOrdersSection, etc.) compile, but
 * the mutation functions throw `unsupported_operation` when invoked.
 * In practice they are unreachable from the live UI today because
 * `useBundle` returns no data, so the per-line edit/cancel buttons
 * never render — they only render when `bundle.lines` has entries.
 *
 * When the backend slice ships replacement endpoints (POST
 * `/bookings/:id/services` for append, PATCH `/bookings/services/lines/:id`
 * for edit, etc.) wire them here and the UI lights up automatically.
 *
 * TODO(backend): replacement endpoints, per booking-canonical
 * follow-up. The `useAttachReservationServices` hook in
 * `@/api/room-booking` already targets the still-living
 * `POST /reservations/:id/services` route (which now takes a booking id),
 * so the "+ Add service" affordance on the booking detail surface
 * continues to work.
 */

const BUNDLE_HTTP_GONE = 'booking_bundles_http_gone';

function bundleEndpointError(): never {
  throw new Error(
    `${BUNDLE_HTTP_GONE}: /booking-bundles/* endpoints were removed in the ` +
      'booking-canonicalisation rewrite. Wait for the backend follow-up ' +
      'slice to ship replacement endpoints.',
  );
}

export interface CancelBundlePayload {
  /** Line-item ids to KEEP — everything else cancels. */
  keep_line_ids?: string[];
  /** "this" / "this_and_following" / "series" for recurring scope. */
  recurrence_scope?: 'this' | 'this_and_following' | 'series';
  reason?: string;
}

export function useCancelBundle() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; payload: CancelBundlePayload }>({
    mutationFn: async () => {
      bundleEndpointError();
    },
    onSettled: (_data, _err, { id }) => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      qc.invalidateQueries({ queryKey: roomBookingKeys.lists() });
      qc.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-window'] });
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}

export interface AddBundleLinesInput {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity: number;
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
}

/**
 * @deprecated The append-services path is now `useAttachReservationServices`
 * in `@/api/room-booking` (still calling the live `POST /reservations/:id/services`
 * route, which takes a booking id post-rewrite). This stub remains for
 * compile-compat only.
 */
export function useAddBundleLines(bundleId: string) {
  const qc = useQueryClient();
  return useMutation<
    {
      bundle_id: string;
      order_ids: string[];
      order_line_item_ids: string[];
      asset_reservation_ids: string[];
      approval_ids: string[];
      any_pending_approval: boolean;
    },
    Error,
    { services: AddBundleLinesInput[] }
  >({
    mutationFn: async () => {
      bundleEndpointError();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}

export interface EditBundleLinePatch {
  quantity?: number;
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
  requester_notes?: string | null;
  /** If-Match-style CAS — when present, the server rejects with 409 if
   *  the line was updated by someone else since the read. */
  expected_updated_at?: string | null;
}

/** @deprecated See file header — backend route gone. */
export function useEditBundleLine(bundleId: string, reservationId?: string) {
  const qc = useQueryClient();
  return useMutation<
    {
      line_id: string;
      quantity: number;
      line_total: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      requester_notes: string | null;
      updated_at: string;
    },
    Error,
    { lineId: string; patch: EditBundleLinePatch }
  >({
    mutationFn: async () => {
      bundleEndpointError();
    },
    onSuccess: (_data, { patch }) => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      if (reservationId) {
        qc.invalidateQueries({ queryKey: roomBookingKeys.detail(reservationId) });
      }
      const windowChanged =
        'service_window_start_at' in patch || 'service_window_end_at' in patch;
      if (windowChanged) {
        qc.invalidateQueries({ queryKey: ticketKeys.all });
      }
    },
  });
}

/** @deprecated See file header — backend route gone. */
export function useCancelBundleLine(bundleId: string) {
  const qc = useQueryClient();
  return useMutation<
    {
      line_id: string;
      cascaded: { ticket_ids: string[]; asset_reservation_ids: string[] };
      closed_approval_ids: string[];
    },
    Error,
    { lineId: string; reason?: string }
  >({
    mutationFn: async () => {
      bundleEndpointError();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}
