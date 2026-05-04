import { useMemo } from 'react';
import {
  useSchedulerData as useSchedulerDataQuery,
  type Reservation,
  type SchedulerRoom,
} from '@/api/room-booking';
import type { SchedulerSort, SchedulerStatusView } from './use-scheduler-window';

const STATUS_VIEW_MATCHERS: Record<
  Exclude<SchedulerStatusView, 'all'>,
  (effect: string) => boolean
> = {
  available: (e) => e === 'allow' || e === 'allow_override',
  requires_approval: (e) => e === 'require_approval',
  restricted: (e) => e === 'deny',
  warning: (e) => e === 'warn',
};

// Status sort weight — lower comes first. "Available" rooms top the
// list when the operator wants quick wins; pending/restricted at the
// bottom signals "harder to use".
const STATUS_WEIGHT: Record<string, number> = {
  allow: 0,
  allow_override: 1,
  warn: 2,
  require_approval: 3,
  deny: 4,
};

/**
 * Fetches the data the desk scheduler needs to paint the grid in ONE
 * round-trip via `POST /reservations/scheduler-data`.
 *
 * Background: this used to be two queries that ran in series — the picker
 * (rules + ranking + day_blocks + a conflicts query) had to return space_ids
 * before the scheduler-window query could ask for reservations on those
 * ids. That stacked two heavy round-trips on every page load. The unified
 * endpoint resolves scope server-side and runs candidates → (parent chains
 * | reservations | optional rules) in parallel, dropping ranking + mini-
 * timeline work the grid never reads.
 *
 * Returns rooms + reservation index keyed by space_id for O(1) lookup
 * during grid paint.
 */
export function useSchedulerData(args: {
  startAtIso: string;
  endAtIso: string;
  buildingId: string | null;
  floorId: string | null;
  bookForPersonId: string | null;
  roomTypeFilter: string | null;
  amenities: string[];
  search: string;
  sort: SchedulerSort;
  statusView: SchedulerStatusView;
}) {
  const query = useSchedulerDataQuery({
    start_at: args.startAtIso,
    end_at: args.endAtIso,
    attendee_count: 1,
    building_id: args.buildingId,
    floor_id: args.floorId,
    must_have_amenities: args.amenities.length > 0 ? args.amenities : undefined,
    requester_id: args.bookForPersonId,
    // 00296 — push room-name search server-side. Pre-fix the API
    // returned every reservable room in scope and the React Query
    // selector below filtered by name; on busy tenants that meant the
    // RPC scanned every slot in the window for rooms the operator was
    // about to drop on the floor anyway. Server-side search shrinks
    // the candidate set BEFORE the slot scan.
    search: args.search.trim() || undefined,
  });

  // Filter on room type + status client-side. Status is computed from
  // rule_outcome (server-evaluated for booking-for) and isn't a SQL
  // predicate; type filter is an amenity match that's cheap to do here
  // since the candidate set is already shrunk by the server-side search.
  const rooms = useMemo<SchedulerRoom[]>(() => {
    const all = query.data?.rooms ?? [];
    const filtered = all.filter((r) => {
      if (args.roomTypeFilter) {
        const typeMatchesAmenity = (r.amenities ?? []).includes(args.roomTypeFilter);
        if (!typeMatchesAmenity) return false;
      }
      if (args.statusView !== 'all') {
        const matcher = STATUS_VIEW_MATCHERS[args.statusView];
        if (!matcher(r.rule_outcome.effect)) return false;
      }
      return true;
    });

    const sorted = [...filtered];
    switch (args.sort) {
      case 'capacity_asc':
        sorted.sort((a, b) => (a.capacity ?? -1) - (b.capacity ?? -1) || a.name.localeCompare(b.name));
        break;
      case 'capacity_desc':
        sorted.sort((a, b) => (b.capacity ?? -1) - (a.capacity ?? -1) || a.name.localeCompare(b.name));
        break;
      case 'status':
        sorted.sort((a, b) => {
          const wa = STATUS_WEIGHT[a.rule_outcome.effect] ?? 99;
          const wb = STATUS_WEIGHT[b.rule_outcome.effect] ?? 99;
          return wa - wb || a.name.localeCompare(b.name);
        });
        break;
      case 'name':
      default:
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }
    return sorted;
    // args.search is intentionally NOT in this dep list — it's part of
    // the query input (00296 server-side filter), so the room set
    // already reflects it. Including it would re-sort on every keystroke
    // for no reason.
  }, [query.data, args.roomTypeFilter, args.sort, args.statusView]);

  const totalUnfiltered = query.data?.rooms?.length ?? 0;

  const spaceIds = useMemo(() => rooms.map((r) => r.space_id), [rooms]);

  // Index reservations by space_id for cheap row paints. Sorted by
  // start_at within each bucket so the row component can do a single
  // forward sweep when computing event-block positions.
  const reservationsBySpaceId = useMemo<Map<string, Reservation[]>>(() => {
    const map = new Map<string, Reservation[]>();
    const visible = new Set(rooms.map((r) => r.space_id));
    for (const r of query.data?.reservations ?? []) {
      if (!visible.has(r.space_id)) continue;
      const list = map.get(r.space_id);
      if (list) list.push(r);
      else map.set(r.space_id, [r]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at));
    }
    return map;
  }, [query.data, rooms]);

  // 00296 — pagination metadata. `roomsTotal` is the full count BEFORE
  // p_room_limit cap (so the toolbar can say "showing first 200 of N"
  // when truncation hits). `reservationsTruncated` is the more
  // operationally-relevant signal: if the slot payload was bounded, the
  // grid is incomplete and the operator should refine the time window
  // or filters.
  const roomsTotal = query.data?.rooms_total ?? totalUnfiltered;
  const roomsTruncated = query.data?.rooms_truncated ?? false;
  const reservationsTotal =
    query.data?.reservations_total ?? query.data?.reservations?.length ?? 0;
  const reservationsTruncated = query.data?.reservations_truncated ?? false;
  const reservationsNextCursor = query.data?.reservations_next_cursor ?? null;

  return {
    rooms,
    spaceIds,
    reservationsBySpaceId,
    totalUnfiltered,
    roomsTotal,
    roomsTruncated,
    reservationsTotal,
    reservationsTruncated,
    reservationsNextCursor,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}
