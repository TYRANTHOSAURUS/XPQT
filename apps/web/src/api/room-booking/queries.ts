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

/**
 * "My bookings" rows include a denormalized `space_name` so the portal
 * page can label rows without fetching the full spaces list.
 */
export interface MyReservationItem extends Reservation {
  space_name?: string | null;
}

/** Operator response includes denormalized space + requester for the list view. */
export interface OperatorReservationItem extends Reservation {
  space_name?: string | null;
  requester_first_name?: string | null;
  requester_last_name?: string | null;
}

interface ReservationListResponse {
  items: Array<Reservation | MyReservationItem | OperatorReservationItem>;
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
          as: filters.as ?? undefined,
        },
      }),
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Operator-scope list — returns every reservation in the tenant + the
 * denormalized space_name / requester names for inline display.
 * Backend gates on rooms.read_all or rooms.admin; non-operators get 403.
 */
export function operatorReservationListOptions(filters: Omit<ReservationListFilters, 'as'> = {}) {
  return reservationListOptions({ ...filters, as: 'operator' }) as ReturnType<
    typeof queryOptions<{ items: OperatorReservationItem[] }>
  >;
}

export function useOperatorReservations(filters: Omit<ReservationListFilters, 'as'> = {}) {
  return useQuery(operatorReservationListOptions(filters));
}

export function useReservationList(filters: ReservationListFilters) {
  return useQuery(
    reservationListOptions(filters) as ReturnType<
      typeof queryOptions<{ items: MyReservationItem[] }>
    >,
  );
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
 *
 * staleTime is 30s by default — the realtime hook keeps the cache fresh on
 * write events, so we don't need React Query's window-focus refetch to do
 * the same job 5 seconds later. The desk scheduler in particular benefits:
 * the picker is the heavy half of the page, and operators routinely
 * switch focus between tabs while triaging without wanting a full refetch
 * round-trip on every return.
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
    staleTime: 30_000,
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
