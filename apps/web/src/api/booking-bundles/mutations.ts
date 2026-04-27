import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import { approvalKeys } from '@/api/approvals';
import { roomBookingKeys } from '@/api/room-booking';
import { ticketKeys } from '@/api/tickets';

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
    mutationFn: ({ id, payload }) =>
      apiFetch(`/booking-bundles/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSettled: (_data, _err, { id }) => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(id) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      qc.invalidateQueries({ queryKey: roomBookingKeys.lists() });
      qc.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-window'] });
      // Cascading entities — work-order tickets get cancelled, approvals
      // get expired. Refresh both so pages displaying them show the new
      // state without a manual reload.
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}

/**
 * Cancel a single service line. Used by the bundle services drawer's
 * per-line × button. Returns the cascaded ticket + asset_reservation ids
 * + closed approvals so the toast can mention them.
 */
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
    mutationFn: ({ lineId, reason }) =>
      apiFetch(`/booking-bundles/lines/${lineId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: bundleKeys.detail(bundleId) });
      qc.invalidateQueries({ queryKey: bundleKeys.lists() });
      // Cascading: line cancel cascades to work-order ticket + asset
      // reservation, and may auto-close approval rows whose scope drops
      // to empty. Refresh both so /desk/tickets, /desk/approvals, and
      // any open ticket detail show the new state.
      qc.invalidateQueries({ queryKey: ticketKeys.all });
      qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}
