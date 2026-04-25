import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { roomBookingKeys } from './keys';
import type { BookingPayload, MultiRoomBookingPayload, Reservation } from './types';

/**
 * Create a single-room booking. Runs the full pipeline server-side
 * (rule resolver + conflict guard + write).
 *
 * On 409 (race lost), the API returns alternatives in the error body —
 * surface them in the UI so the user can rebook in one click.
 */
export function useCreateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: BookingPayload) =>
      apiFetch<Reservation>('/reservations', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
      queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'picker'] });
    },
  });
}

/**
 * Dry-run a booking without writing — used by the picker to preview the
 * pipeline outcome before the user commits, and by the desk scheduler to
 * tag cells as "would require approval" or "denied for this requester."
 */
export function useDryRunBooking() {
  return useMutation({
    mutationFn: (payload: BookingPayload) =>
      apiFetch<{
        outcome: 'allow' | 'deny' | 'require_approval' | 'warn';
        denial_message?: string;
        warnings?: string[];
        matched_rule_ids: string[];
      }>('/reservations/dry-run', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  });
}

export function useMultiRoomBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: MultiRoomBookingPayload) =>
      apiFetch<{ multi_room_group_id: string; reservations: Reservation[] }>(
        '/reservations/multi-room',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
    },
  });
}

export function useEditBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: {
      id: string;
      patch: Partial<Pick<Reservation,
        'space_id' | 'start_at' | 'end_at' | 'attendee_count' |
        'attendee_person_ids' | 'host_person_id'>>;
    }) =>
      apiFetch<Reservation>(`/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.id) });
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
    },
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scope, reason }: {
      id: string;
      scope?: 'this' | 'this_and_following' | 'series';
      reason?: string;
    }) =>
      apiFetch<Reservation>(`/reservations/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ scope, reason }),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.id) });
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
    },
  });
}

export function useRestoreBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Reservation>(`/reservations/${id}/restore`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
    },
  });
}

export function useCheckInBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; checked_in_at: string }>(`/reservations/${id}/check-in`, {
        method: 'POST',
      }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
    },
  });
}
