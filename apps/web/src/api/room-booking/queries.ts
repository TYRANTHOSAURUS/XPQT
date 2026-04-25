import { queryOptions, useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import {
  roomBookingKeys,
  type ReservationListFilters,
  type PickerInput,
  type FindTimeInput,
  type SchedulerWindowInput,
} from './keys';
import type { Reservation, RankedRoom, FreeSlot } from './types';

interface ReservationListResponse {
  items: Reservation[];
  next_cursor?: string | null;
}

/**
 * "My bookings" list. T1 cache (10s) — frequent edits.
 */
export function reservationListOptions(filters: ReservationListFilters) {
  return queryOptions({
    queryKey: roomBookingKeys.list(filters),
    queryFn: ({ signal }) =>
      apiFetch<ReservationListResponse>('/reservations', {
        signal,
        query: {
          scope: filters.scope ?? undefined,
          status: filters.status ?? undefined,
          space_id: filters.space_id ?? undefined,
          requester_person_id: filters.requester_person_id ?? undefined,
          from: filters.from ?? undefined,
          to: filters.to ?? undefined,
          limit: filters.limit ?? undefined,
        },
      }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

export function useReservationList(filters: ReservationListFilters) {
  return useQuery(reservationListOptions(filters));
}

export function reservationDetailOptions(id: string) {
  return queryOptions({
    queryKey: roomBookingKeys.detail(id),
    queryFn: ({ signal }) => apiFetch<Reservation>(`/reservations/${id}`, { signal }),
    staleTime: 10_000,
    enabled: Boolean(id),
  });
}

export function useReservationDetail(id: string) {
  return useQuery(reservationDetailOptions(id));
}

interface PickerResponse {
  rooms: RankedRoom[];
}

/**
 * The portal hybrid-C picker. Sends {time, attendees, criteria, sort} and
 * gets back ranked rooms with rule outcomes + mini-timeline blocks.
 *
 * Realtime: the page subscribes to per-space changefeeds and re-runs this
 * query (200 ms debounced) when an event arrives that affects a shown room.
 */
export function pickerOptions(input: PickerInput) {
  return queryOptions({
    queryKey: roomBookingKeys.picker(input),
    queryFn: ({ signal }) =>
      apiFetch<PickerResponse>('/reservations/picker', {
        signal,
        method: 'POST',
        body: JSON.stringify(input),
      }),
    staleTime: 5_000,
    placeholderData: keepPreviousData,
    enabled: Boolean(input.start_at) && Boolean(input.end_at) && input.attendee_count > 0,
  });
}

export function usePicker(input: PickerInput) {
  return useQuery(pickerOptions(input));
}

interface FindTimeResponse {
  slots: FreeSlot[];
}

export function findTimeOptions(input: FindTimeInput) {
  return queryOptions({
    queryKey: roomBookingKeys.findTime(input),
    queryFn: ({ signal }) =>
      apiFetch<FindTimeResponse>('/reservations/find-time', {
        signal,
        method: 'POST',
        body: JSON.stringify(input),
      }),
    staleTime: 30_000,
    enabled: input.person_ids.length > 0 && input.duration_minutes > 0,
  });
}

export function useFindTime(input: FindTimeInput) {
  return useQuery(findTimeOptions(input));
}

interface SchedulerWindowResponse {
  items: Reservation[];
}

/**
 * Desk-scheduler window read. One round-trip for every reservation on the
 * given space ids inside [start_at, end_at). Operator-or-admin endpoint —
 * the API rejects callers without rooms.read_all / rooms.admin.
 *
 * staleTime is short (10 s) because the page also subscribes to Supabase
 * Realtime and invalidates on changefeed events. The cache is keyed on the
 * (sorted) space-id array so paging the calendar forward / scrolling the
 * room rail re-keys cleanly.
 */
export function schedulerWindowOptions(input: SchedulerWindowInput) {
  // Stable cache key: sort space_ids so equivalent windows hit the same cell.
  const sortedSpaceIds = [...input.space_ids].sort();
  const stableInput: SchedulerWindowInput = {
    space_ids: sortedSpaceIds,
    start_at: input.start_at,
    end_at: input.end_at,
  };
  return queryOptions({
    queryKey: roomBookingKeys.schedulerWindow(stableInput),
    queryFn: ({ signal }) =>
      apiFetch<SchedulerWindowResponse>('/reservations/scheduler-window', {
        signal,
        method: 'POST',
        body: JSON.stringify(stableInput),
      }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    enabled: input.space_ids.length > 0 && Boolean(input.start_at) && Boolean(input.end_at),
  });
}

export function useSchedulerReservations(input: SchedulerWindowInput) {
  return useQuery(schedulerWindowOptions(input));
}
