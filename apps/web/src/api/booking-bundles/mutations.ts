import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleKeys } from './keys';
import { roomBookingKeys } from '@/api/room-booking';

export interface CancelBundlePayload {
  /** Line-item ids to KEEP — everything else cancels. */
  keep_line_ids?: string[];
  /** "this" / "this_and_following" / "series" for recurring scope. */
  recurrence_scope?: 'this' | 'this_and_following' | 'series';
  comment?: string;
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
    },
  });
}
