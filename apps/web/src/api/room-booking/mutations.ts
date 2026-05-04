import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { roomBookingKeys } from './keys';
import type { BookingPayload, MultiRoomBookingPayload, Reservation } from './types';

/**
 * Invalidate every cached read that could be affected by a write to a
 * reservation: the user-facing list, the portal picker, the desk
 * scheduler window, and the find-time / availability buckets. We
 * invalidate the whole `scheduler-window` namespace (not a specific key)
 * because the page may have multiple windows cached across day/week
 * pages and filter combinations.
 */
function invalidateAfterWrite(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'picker'] });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-window'] });
  // Unified scheduler-data bucket (rooms + reservations in one round-trip).
  // Phase 1.4 wires the desk scheduler against this key, so any geometry
  // mutation must invalidate it alongside the legacy scheduler-window
  // bucket.
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-data'] });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'availability'] });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'find-time'] });
}

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
    onSuccess: () => invalidateAfterWrite(queryClient),
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
      // Post-canonicalisation (2026-05-02): the response shape is
      // `{ group_id, reservations[] }` where `group_id` is the booking
      // id (the dropped `multi_room_groups` table is replaced by
      // `booking_id` grouping; multi-room-booking.service.ts:331).
      // Each `reservations[i].id` also equals the booking id, so any
      // of them resolves to /desk/bookings/:id correctly.
      apiFetch<{ group_id: string; reservations: Reservation[] }>(
        '/reservations/multi-room',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/**
 * Booking-LEVEL edit. Use for fields that are not slot geometry —
 * `host_person_id`, `attendee_count`, `attendee_person_ids`. Routes to
 * the legacy `PATCH /reservations/:id` which only edits the booking's
 * PRIMARY slot (lowest display_order). For slot-geometry edits in a
 * multi-room context, use `useEditBookingSlot` below — that's the path
 * the desk scheduler drag/resize/move hits so a non-primary slot
 * actually moves the slot the operator clicked.
 */
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
      invalidateAfterWrite(queryClient);
    },
  });
}

/**
 * SLOT-targeted geometry edit (Phase 1.4 — Bug #2: slot-first scheduler).
 *
 * Use this for any drag / resize / move on the desk scheduler — anywhere
 * the operator manipulates a specific slot's space / start / end. Routes
 * to `PATCH /reservations/:bookingId/slots/:slotId` so a non-primary
 * slot of a multi-room booking actually moves THAT slot, not the
 * booking's primary.
 *
 * The booking-level mirror (start_at / end_at / location_id) is
 * recomputed atomically on the server inside the `edit_booking_slot`
 * RPC (00291) — there's no separate booking write to issue from the
 * client.
 *
 * For booking-level fields (host_person_id, attendee_count), use
 * `useEditBooking` instead.
 */
export function useEditBookingSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, slotId, patch }: {
      bookingId: string;
      slotId: string;
      patch: Partial<Pick<Reservation, 'space_id' | 'start_at' | 'end_at'>>;
    }) =>
      apiFetch<Reservation>(`/reservations/${bookingId}/slots/${slotId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.bookingId) });
      invalidateAfterWrite(queryClient);
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
      invalidateAfterWrite(queryClient);
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
      invalidateAfterWrite(queryClient);
    },
  });
}

export interface AttachServicesInput {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity: number;
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
}

/**
 * Attach service lines to an existing reservation. Lazy-creates the
 * booking_bundle on first attach; appends to it on subsequent calls.
 * Used by the post-booking "+ Add service" affordance.
 */
export function useAttachReservationServices(reservationId: string) {
  const queryClient = useQueryClient();
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
    { services: AttachServicesInput[] }
  >({
    mutationFn: ({ services }) =>
      apiFetch(`/reservations/${reservationId}/services`, {
        method: 'POST',
        body: JSON.stringify({ services }),
      }),
    onSuccess: (data) => {
      // Post-canonicalisation (2026-05-02) the booking IS the bundle, so
      // attaching services doesn't flip a `booking_bundle_id` field on
      // the reservation — but the booking now carries linked orders.
      // Invalidate detail (in case denormalized status changes), the
      // bundle key (no-op today since `useBundle` is stubbed, but
      // future-proof against the read endpoint coming back), and the
      // lists (which the `?scope=bundles` filter narrows on).
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(reservationId) });
      queryClient.invalidateQueries({ queryKey: ['booking-bundles', 'detail', data.bundle_id] as const });
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
      invalidateAfterWrite(queryClient);
    },
  });
}
