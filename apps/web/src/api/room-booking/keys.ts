/**
 * Query-key factory for the room-booking module. Per
 * `docs/react-query-guidelines.md` §3 every room-booking query is keyed
 * through this factory — never inline.
 *
 * Hierarchy:
 *   all
 *     ├─ lists  → list(filters)
 *     ├─ details → detail(id)
 *     ├─ picker(input)
 *     ├─ findTime(input)
 *     └─ availability(spaceId, range)
 */

export type ReservationStatus =
  | 'draft'
  | 'pending_approval'
  | 'confirmed'
  | 'checked_in'
  | 'released'
  | 'cancelled'
  | 'completed';

export interface ReservationListFilters {
  scope?: 'upcoming' | 'past' | 'cancelled' | 'all' | 'pending_approval';
  status?: ReservationStatus | ReservationStatus[];
  space_id?: string | null;
  requester_person_id?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number | null;
  /** 'operator' triggers the cross-tenant operator list (requires rooms.read_all). */
  as?: 'mine' | 'operator';
}

export interface PickerCriteria {
  must_have_amenities?: string[];
  preferred_amenities?: string[];
  has_video?: boolean;
  wheelchair_accessible?: boolean;
  smart_keywords?: string[];
}

export interface PickerInput {
  start_at: string;
  end_at: string;
  attendee_count: number;
  site_id?: string;
  building_id?: string;
  floor_id?: string;
  /**
   * Filter / boost criteria. Mirrors the backend's `PickerDto.criteria`
   * shape — the must-haves and smart-keywords live here, NOT at the top
   * level. Backend ignores top-level criteria fields if any are sent.
   */
  criteria?: PickerCriteria;
  requester_id?: string;
  sort?: 'best_match' | 'closest' | 'smallest_fit' | 'most_underused';
  limit?: number;
  /**
   * When true, rooms with conflicts in the window are still returned. The
   * desk scheduler sets this so the grid keeps every reservable room visible
   * regardless of bookings — without it, making a booking on a room makes
   * the row disappear from the scheduler. Portal employees leave it false.
   */
  include_unavailable?: boolean;
}

export interface FindTimeInput {
  duration_minutes: number;
  person_ids: string[];
  window_start: string;
  window_end: string;
  must_have_amenities?: string[];
}

export const roomBookingKeys = {
  all: ['room-booking'] as const,

  lists: () => [...roomBookingKeys.all, 'list'] as const,
  list: (filters: ReservationListFilters) => [...roomBookingKeys.lists(), filters] as const,

  details: () => [...roomBookingKeys.all, 'detail'] as const,
  detail: (id: string) => [...roomBookingKeys.details(), id] as const,

  picker: (input: PickerInput) => [...roomBookingKeys.all, 'picker', input] as const,
  findTime: (input: FindTimeInput) => [...roomBookingKeys.all, 'find-time', input] as const,

  availability: (spaceId: string, fromIso: string, toIso: string) =>
    [...roomBookingKeys.all, 'availability', spaceId, fromIso, toIso] as const,

  // Desk scheduler — one bucket per (sortedSpaceIds, range). Sub-key shape:
  //   ['room-booking','scheduler-window', { space_ids: string[] (sorted), start_at, end_at }]
  schedulerWindow: (input: SchedulerWindowInput) =>
    [...roomBookingKeys.all, 'scheduler-window', input] as const,

  // Unified scheduler-data bucket. One round-trip returns rooms + reservations.
  // Realtime invalidation only needs to bust this key prefix; the legacy
  // picker / scheduler-window buckets are no longer used by the desk scheduler.
  schedulerData: (input: SchedulerDataInput) =>
    [...roomBookingKeys.all, 'scheduler-data', input] as const,
} as const;

export interface SchedulerWindowInput {
  space_ids: string[];
  start_at: string;
  end_at: string;
}

export interface SchedulerDataInput {
  start_at: string;
  end_at: string;
  attendee_count?: number;
  site_id?: string | null;
  building_id?: string | null;
  floor_id?: string | null;
  must_have_amenities?: string[];
  requester_id?: string | null;
}
