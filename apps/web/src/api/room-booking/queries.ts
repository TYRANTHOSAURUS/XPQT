import { queryOptions, useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import {
  roomBookingKeys,
  type ReservationListFilters,
  type PickerInput,
  type FindTimeInput,
  type SchedulerWindowInput,
  type SchedulerDataInput,
} from './keys';
import type { Reservation, RankedRoom, FreeSlot, RuleOutcome } from './types';

/**
 * Slim room shape returned by `/reservations/scheduler-data` — drops
 * ranking_score / ranking_reasons / day_blocks since the desk grid never
 * reads them. Saves bytes and CPU on every paint.
 */
export interface SchedulerRoom {
  space_id: string;
  name: string;
  space_type: string;
  image_url: string | null;
  capacity: number | null;
  min_attendees: number | null;
  amenities: string[];
  keywords: string[];
  parent_chain: { id: string; name: string; type: string }[];
  rule_outcome: RuleOutcome;
}

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

interface SchedulerDataResponse {
  rooms: SchedulerRoom[];
  reservations: Reservation[];
}

/**
 * Per-cache-key ETag side-channel. React Query owns the body (so we don't
 * have to duplicate it); this map only tracks the most recent server ETag
 * per stable input shape so refetches can send `If-None-Match` and the
 * server can reply 304 when nothing changed.
 *
 * Bounded at 64 entries (LRU-ish via Map insertion order) to defend
 * against long-lived sessions accumulating stale entries from many
 * scope/date combinations.
 */
const SCHEDULER_DATA_ETAGS = new Map<string, string>();
const ETAG_LIMIT = 64;

function rememberEtag(key: string, etag: string | null): void {
  if (!etag) return;
  if (SCHEDULER_DATA_ETAGS.has(key)) SCHEDULER_DATA_ETAGS.delete(key);
  SCHEDULER_DATA_ETAGS.set(key, etag);
  if (SCHEDULER_DATA_ETAGS.size > ETAG_LIMIT) {
    const first = SCHEDULER_DATA_ETAGS.keys().next().value;
    if (first) SCHEDULER_DATA_ETAGS.delete(first);
  }
}

/**
 * Unified desk-scheduler load — one round-trip returns rooms + reservations.
 * Replaces the legacy picker → scheduler-window waterfall. Backend collapses
 * candidate resolution + parent-chain CTE + reservation read + (optional)
 * rule eval into a single SQL function call.
 *
 * Conditional GET via ETag: on each refetch we send the previous response's
 * ETag in `If-None-Match`. When nothing has changed (the common case for
 * focus-refetch and the 200 ms realtime debounce on quiet rooms), the
 * server replies `304 Not Modified` with no body, and React Query reuses
 * the cached payload. Saves the wire bytes + JSON parse on every quiet
 * revalidation.
 *
 * staleTime is 10 s because realtime keeps the bucket fresh on writes; this
 * just controls the focus-refetch behaviour for stale tabs.
 */
export function schedulerDataOptions(input: SchedulerDataInput) {
  // Stable cache key: drop empty arrays / null-equivalent keys so semantically
  // equivalent inputs hit the same cell.
  const stable: SchedulerDataInput = {
    start_at: input.start_at,
    end_at: input.end_at,
    attendee_count: input.attendee_count ?? 1,
    site_id: input.site_id ?? null,
    building_id: input.building_id ?? null,
    floor_id: input.floor_id ?? null,
    must_have_amenities:
      input.must_have_amenities && input.must_have_amenities.length > 0
        ? [...input.must_have_amenities].sort()
        : undefined,
    requester_id: input.requester_id ?? null,
  };
  const cacheKey = JSON.stringify(stable);
  return queryOptions<SchedulerDataResponse>({
    queryKey: roomBookingKeys.schedulerData(stable),
    queryFn: async ({ signal, client, queryKey }) => {
      const previous = client.getQueryData<SchedulerDataResponse>(queryKey);
      const previousEtag = SCHEDULER_DATA_ETAGS.get(cacheKey);
      return apiFetch<SchedulerDataResponse>('/reservations/scheduler-data', {
        signal,
        method: 'POST',
        body: JSON.stringify({
          start_at: stable.start_at,
          end_at: stable.end_at,
          attendee_count: stable.attendee_count,
          site_id: stable.site_id ?? undefined,
          building_id: stable.building_id ?? undefined,
          floor_id: stable.floor_id ?? undefined,
          must_have_amenities: stable.must_have_amenities,
          requester_id: stable.requester_id ?? undefined,
        }),
        etag: previous ? previousEtag ?? null : null,
        onNotModified: () => previous!,
        etagOut: (etag) => rememberEtag(cacheKey, etag),
      });
    },
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    enabled: Boolean(input.start_at) && Boolean(input.end_at),
  });
}

export function useSchedulerData(input: SchedulerDataInput) {
  return useQuery(schedulerDataOptions(input));
}
