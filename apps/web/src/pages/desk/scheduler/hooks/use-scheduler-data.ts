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
  });

  // Filter on room type + name search client-side (the API has no
  // dedicated filters for these in v1). Then sort by the user's chosen
  // axis. The API returns rooms in a name-first default order, so the
  // identity sort case is a no-op.
  const rooms = useMemo<SchedulerRoom[]>(() => {
    const all = query.data?.rooms ?? [];
    const term = args.search.trim().toLowerCase();
    const filtered = all.filter((r) => {
      if (term && !r.name.toLowerCase().includes(term)) return false;
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
  }, [query.data, args.search, args.roomTypeFilter, args.sort, args.statusView]);

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

  return {
    rooms,
    spaceIds,
    reservationsBySpaceId,
    totalUnfiltered,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}
