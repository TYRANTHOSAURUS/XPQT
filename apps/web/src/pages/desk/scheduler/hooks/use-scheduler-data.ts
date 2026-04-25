import { useMemo } from 'react';
import {
  usePicker,
  useSchedulerReservations,
  type RankedRoom,
  type Reservation,
} from '@/api/room-booking';

/**
 * Fetches the data the desk scheduler needs to paint the grid:
 *
 *   1. Candidate spaces (`usePicker`) — the rooms the operator can book.
 *      We pass `attendee_count: 1` so the picker returns every reservable
 *      room broadly and lets us filter client-side. When a "Book for"
 *      person is set, the picker scopes rooms to what they can see.
 *
 *   2. Reservations on those spaces inside [startAtIso, endAtIso) via the
 *      `POST /reservations/scheduler-window` endpoint — one round-trip
 *      regardless of how many rooms are visible. This is the §5.6 perf
 *      lever (one query, not N).
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
}) {
  const picker = usePicker({
    start_at: args.startAtIso,
    end_at: args.endAtIso,
    attendee_count: 1,
    building_id: args.buildingId ?? undefined,
    floor_id: args.floorId ?? undefined,
    must_have_amenities: args.amenities.length > 0 ? args.amenities : undefined,
    requester_id: args.bookForPersonId ?? undefined,
    sort: 'best_match',
    limit: 200,
  });

  // Filter on room type + name search client-side (the picker has no
  // dedicated filters for these in v1). If/when the API grows them, swap
  // these for query params.
  const rooms = useMemo<RankedRoom[]>(() => {
    const all = picker.data?.rooms ?? [];
    const term = args.search.trim().toLowerCase();
    return all.filter((r) => {
      if (term && !r.name.toLowerCase().includes(term)) return false;
      if (args.roomTypeFilter) {
        // The picker doesn't expose a `type` field; rely on parent_chain or
        // amenities for type-equivalent filtering. v1: skip — leave as a
        // place to wire when the picker gains the column.
        const typeMatchesAmenity = (r.amenities ?? []).includes(args.roomTypeFilter);
        if (!typeMatchesAmenity) return false;
      }
      return true;
    });
  }, [picker.data, args.search, args.roomTypeFilter]);

  const spaceIds = useMemo(() => rooms.map((r) => r.space_id), [rooms]);

  const reservations = useSchedulerReservations({
    space_ids: spaceIds,
    start_at: args.startAtIso,
    end_at: args.endAtIso,
  });

  // Index reservations by space_id for cheap row paints. Sorted by
  // start_at within each bucket so the row component can do a single
  // forward sweep when computing event-block positions.
  const reservationsBySpaceId = useMemo<Map<string, Reservation[]>>(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations.data?.items ?? []) {
      const list = map.get(r.space_id);
      if (list) list.push(r);
      else map.set(r.space_id, [r]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at));
    }
    return map;
  }, [reservations.data]);

  return {
    rooms,
    spaceIds,
    reservationsBySpaceId,
    isLoading: picker.isPending || reservations.isPending,
    isFetching: picker.isFetching || reservations.isFetching,
    isError: picker.isError || reservations.isError,
    error: picker.error ?? reservations.error,
  };
}
