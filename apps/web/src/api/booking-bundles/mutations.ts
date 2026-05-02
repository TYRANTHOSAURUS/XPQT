import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import { approvalKeys } from '@/api/approvals';
import { roomBookingKeys } from '@/api/room-booking';
import { ticketKeys } from '@/api/tickets';

/**
 * Booking-canonicalisation rewrite (2026-05-02): the legacy `/booking-bundles/*`
 * HTTP routes were deleted (booking-bundles.module.ts:27). Replacement
 * endpoints now live under `/reservations/*` because the booking IS the
 * bundle now (00277:27) and the URL `:id` segment that callers already hold
 * is a valid bundle id:
 *
 *   - `POST /reservations/:id/services`               — append lines (also used by `useAttachReservationServices`)
 *   - `PATCH /reservations/:id/services/:lineId`      — edit a single line
 *   - `DELETE /reservations/:id/services/:lineId`     — cancel a single line
 *   - `DELETE /reservations/:id/bundle`               — cancel the whole bundle
 *
 * All four are gated on the reservation's write-gate (requester / host /
 * booker / `rooms.admin`) per the same `assertReservationWritable` rule
 * the post-canonicalisation `attachServices` endpoint already uses.
 */

export interface CancelBundlePayload {
  /** Line-item ids to KEEP — everything else cancels. */
  keep_line_ids?: string[];
  /** "this" / "this_and_following" / "series" for recurring scope. */
  recurrence_scope?: 'this' | 'this_and_following' | 'series';
  reason?: string;
}

export interface CancelBundleResult {
  bundle_id: string;
  cancelled_line_ids: string[];
  cancelled_reservation_ids: string[];
  cancelled_ticket_ids: string[];
  cancelled_asset_reservation_ids: string[];
  closed_approval_ids: string[];
  fulfilled_line_ids: string[];
}

export function useCancelBundle() {
  const qc = useQueryClient();
  return useMutation<
    CancelBundleResult,
    Error,
    { id: string; payload: CancelBundlePayload }
  >({
    mutationFn: ({ id, payload }) =>
      apiFetch<CancelBundleResult>(`/reservations/${id}/bundle`, {
        method: 'DELETE',
        body: JSON.stringify(payload ?? {}),
      }),
    onSettled: (_data, _err, { id }) => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      // The booking detail page itself reads from room-booking; refetch so
      // the booking's status flips to `cancelled` when the cascade fully
      // tears it down.
      qc.invalidateQueries({ queryKey: roomBookingKeys.detail(id) });
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

export interface AddBundleLinesResult {
  bundle_id: string;
  order_ids: string[];
  order_line_item_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
  any_pending_approval: boolean;
}

/**
 * Append service lines to a booking. The booking-detail surface uses
 * `useAttachReservationServices` from `@/api/room-booking` instead (same
 * underlying `POST /reservations/:id/services` endpoint, sibling cache
 * invalidations); this hook stays for callers that want bundle-keyed
 * invalidation as the primary effect.
 */
export function useAddBundleLines(bundleId: string) {
  const qc = useQueryClient();
  return useMutation<
    AddBundleLinesResult,
    Error,
    { services: AddBundleLinesInput[] }
  >({
    mutationFn: ({ services }) =>
      apiFetch<AddBundleLinesResult>(`/reservations/${bundleId}/services`, {
        method: 'POST',
        body: JSON.stringify({ services }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      qc.invalidateQueries({ queryKey: roomBookingKeys.detail(bundleId) });
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

export interface EditBundleLineResult {
  line_id: string;
  quantity: number;
  line_total: number | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  requester_notes: string | null;
  updated_at: string;
}

export function useEditBundleLine(bundleId: string, reservationId?: string) {
  const qc = useQueryClient();
  return useMutation<
    EditBundleLineResult,
    Error,
    { lineId: string; patch: EditBundleLinePatch }
  >({
    mutationFn: ({ lineId, patch }) =>
      apiFetch<EditBundleLineResult>(
        `/reservations/${bundleId}/services/${lineId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
      ),
    onSuccess: (_data, { patch }) => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      if (reservationId && reservationId !== bundleId) {
        qc.invalidateQueries({ queryKey: roomBookingKeys.detail(reservationId) });
      }
      const windowChanged =
        'service_window_start_at' in patch || 'service_window_end_at' in patch;
      if (windowChanged) {
        // Linked work-order's SLA-due shifted alongside the window; refetch
        // so the desk surface reflects the new commitment.
        qc.invalidateQueries({ queryKey: ticketKeys.all });
      }
    },
  });
}

export interface CancelBundleLineResult {
  line_id: string;
  cascaded: { ticket_ids: string[]; asset_reservation_ids: string[] };
  closed_approval_ids: string[];
}

export function useCancelBundleLine(bundleId: string) {
  const qc = useQueryClient();
  return useMutation<
    CancelBundleLineResult,
    Error,
    { lineId: string; reason?: string }
  >({
    mutationFn: ({ lineId, reason }) =>
      apiFetch<CancelBundleLineResult>(
        `/reservations/${bundleId}/services/${lineId}`,
        {
          method: 'DELETE',
          body: JSON.stringify(reason ? { reason } : {}),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      // The cancelled work-order shows up under tickets; refetch to flip
      // the desk surface's WO list to closed.
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}
