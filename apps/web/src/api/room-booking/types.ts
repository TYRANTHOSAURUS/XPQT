// Mirrors the API's reservations DTOs (apps/api/src/modules/reservations/dto/types.ts).
//
// Booking-canonicalization rewrite (2026-05-02):
//   `bookings`        replaces `booking_bundles`  (00277:27)
//   `booking_slots`   replaces `reservations`     (00277:116)
//
// The frontend keeps the legacy `Reservation` shape because the API
// projects every booking-slot read back into that flat shape via
// `slotWithBookingToReservation` (apps/api/src/modules/reservations/
// reservation-projection.ts:55). New canonical types `Booking` /
// `BookingSlot` are exposed below for any new code that wants to
// consume the modern shape directly.
//
// BREAKING SEMANTICS (carried by the legacy Reservation shape post-rewrite):
//   - `Reservation.id` is now a `bookings.id` (was `reservations.id`).
//   - `Reservation.booking_bundle_id`, `multi_room_group_id`, and
//     `recurrence_master_id` were DROPPED from this projection. Under
//     canonicalization the booking IS the bundle (use `id` for the
//     bundle id); multi-room atomicity is expressed via shared
//     `booking_id` on slots (`BookingSlot.booking_id`); the recurrence
//     series link is one-directional via `Booking.recurrence_series_id`.

export type ReservationStatus =
  | 'draft'
  | 'pending_approval'
  | 'confirmed'
  | 'checked_in'
  | 'released'
  | 'cancelled'
  | 'completed';

export type ReservationSource =
  | 'portal'
  | 'desk'
  | 'api'
  | 'calendar_sync'
  | 'auto'
  | 'reception';

export type ReservationType = 'room' | 'desk' | 'parking' | 'other';
export type CalendarProvider = 'outlook';

// `parking` is on the new schema; the new check constraint accepts only
// room/desk/asset/parking — 00277:122. Frontend keeps `'other'` in the
// legacy Reservation type for the projection (asset → other on read).
export type SlotType = 'room' | 'desk' | 'asset' | 'parking';

// Source values the new bookings table accepts (00277:56-58, FIX#2).
// The legacy `ReservationSource` retains 'auto' for calendar-sync intercept
// callers; the booking layer never sees 'auto' (it's coerced to
// 'calendar_sync' before insert).
export type BookingStatus = ReservationStatus;
export type BookingSource =
  | 'portal'
  | 'desk'
  | 'api'
  | 'calendar_sync'
  | 'reception';

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  by_day?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
  by_month_day?: number;
  count?: number;
  until?: string;
}

export interface PolicySnapshot {
  matched_rule_ids?: string[];
  effects_seen?: string[];
  buffers_collapsed_for_back_to_back?: boolean;
  source_room_check_in_required?: boolean;
  source_room_setup_buffer_minutes?: number;
  source_room_teardown_buffer_minutes?: number;
  rule_evaluations?: Array<{
    rule_id: string;
    matched: boolean;
    effect: 'deny' | 'require_approval' | 'allow_override' | 'warn';
    denial_message?: string;
  }>;
}

/**
 * Canonical `Booking` shape — matches the API's `Booking` interface
 * (apps/api/src/modules/reservations/dto/types.ts:87). Use this for any
 * new code that doesn't need to interop with the flat `Reservation`
 * projection.
 */
export interface Booking {
  id: string;
  tenant_id: string;
  title: string | null;
  description: string | null;
  requester_person_id: string;
  host_person_id: string | null;
  booked_by_user_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status: BookingStatus;
  source: BookingSource;
  cost_center_id: string | null;
  cost_amount_snapshot: string | null;
  policy_snapshot: PolicySnapshot;
  applied_rule_ids: string[];
  config_release_id: string | null;
  calendar_event_id: string | null;
  calendar_provider: CalendarProvider | null;
  calendar_etag: string | null;
  calendar_last_synced_at: string | null;
  recurrence_series_id: string | null;
  recurrence_index: number | null;
  recurrence_overridden: boolean;
  recurrence_skipped: boolean;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Canonical `BookingSlot` — per-resource holding within a Booking. One
 * slot per held space (room/desk/asset/parking). Multi-room bookings
 * have N slots all keyed to the same booking_id. Mirrors the API
 * (apps/api/src/modules/reservations/dto/types.ts:137).
 */
export interface BookingSlot {
  id: string;
  tenant_id: string;
  booking_id: string;
  slot_type: SlotType;
  space_id: string;
  start_at: string;
  end_at: string;
  setup_buffer_minutes: number;
  teardown_buffer_minutes: number;
  effective_start_at: string;
  effective_end_at: string;
  attendee_count: number | null;
  attendee_person_ids: string[];
  status: BookingStatus;
  check_in_required: boolean;
  check_in_grace_minutes: number;
  checked_in_at: string | null;
  released_at: string | null;
  cancellation_grace_until: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * Legacy flat `Reservation` projection — what the API still returns
 * from every reservations endpoint (apps/api/src/modules/reservations/
 * reservation-projection.ts). Field semantics post-rewrite are
 * documented at the top of this file.
 */
export interface Reservation {
  /**
   * BREAKING POST-CANONICALIZATION: this is now a `bookings.id`, not the
   * legacy `reservations.id`. Multi-room bookings produce N projection
   * rows that all share the same `id` — disambiguate via `slot_id`.
   */
  id: string;
  /**
   * The underlying `booking_slots.id` for this projection row. Always
   * non-null post-canonicalization. Use this when you need to address a
   * specific room in a multi-room booking; otherwise `id` (= booking id)
   * is the right key for booking-level operations. Mirrors the API
   * Reservation interface (apps/api/src/modules/reservations/dto/types.ts).
   */
  slot_id: string;
  tenant_id: string;
  // `module_number` is intentionally omitted post-canonicalisation (2026-05-02).
  // The legacy `reservations.module_number` column lived on the dropped
  // `reservations` table (00139:147); the new `bookings` table (00277:27)
  // does NOT carry a per-booking monotonic counter — and the projection at
  // reservation-projection.ts:55 doesn't synthesise one. Detail surfaces
  // that used `formatRef('reservation', module_number)` were retired in
  // the same slice; show the booking title or fall back to the booking id
  // tail instead. If a per-booking ref string is needed in the future,
  // re-introduce it as a real column on `bookings` first.
  reservation_type: ReservationType;
  space_id: string;
  requester_person_id: string;
  host_person_id: string | null;
  start_at: string;
  end_at: string;
  attendee_count: number | null;
  attendee_person_ids: string[];
  status: ReservationStatus;
  recurrence_rule: RecurrenceRule | null;
  recurrence_series_id: string | null;
  // recurrence_master_id field dropped — the canonical series link is
  // recurrence_series_id (one direction). Both projections (api
  // reservation-projection.ts + booking-flow.service.ts) stopped emitting it.
  recurrence_index: number | null;
  recurrence_overridden: boolean;
  recurrence_skipped: boolean;
  setup_buffer_minutes: number;
  teardown_buffer_minutes: number;
  effective_start_at: string;
  effective_end_at: string;
  check_in_required: boolean;
  check_in_grace_minutes: number;
  checked_in_at: string | null;
  released_at: string | null;
  cancellation_grace_until: string | null;
  policy_snapshot: PolicySnapshot;
  applied_rule_ids: string[];
  source: ReservationSource;
  booked_by_user_id: string | null;
  cost_amount_snapshot: string | null;
  // `multi_room_group_id` and `booking_bundle_id` were dropped from this
  // type by slice H3 (migration 00286). The first was always null
  // post-canonicalization (00277 dropped multi_room_groups — group
  // siblings are now discovered by querying slots that share the booking
  // id); the second was an alias for `id` (the booking IS the bundle).
  // No reader consumed them; deletion was confirmed safe via grep.
  calendar_event_id: string | null;
  calendar_provider: CalendarProvider | null;
  calendar_etag: string | null;
  calendar_last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  /** Root-first parent trail of the booked space. */
  space_path?: string[] | null;
  // Optional denormalised display fields populated by the operator list
  // / scheduler-data endpoint.
  requester_first_name?: string | null;
  requester_last_name?: string | null;
  requester_email?: string | null;
  host_first_name?: string | null;
  host_last_name?: string | null;
  host_email?: string | null;
}

export interface RuleOutcome {
  effect: 'deny' | 'require_approval' | 'warn' | 'allow' | 'allow_override';
  matched_rule_ids: string[];
  denial_message?: string;
  warning_messages?: string[];
}

export interface RankedRoom {
  space_id: string;
  name: string;
  /** Sub-type — `meeting_room` / `room` / etc. Drives the icon fallback when
   *  no `image_url` is set. */
  space_type: string;
  /** Optional cover image (Supabase Storage URL or any CDN). Surfaces as the
   *  edge-to-edge tile on the picker / desk row; falls back to a
   *  RoomTypeIcon when null. */
  image_url: string | null;
  capacity: number | null;
  min_attendees: number | null;
  amenities: string[];
  /** Smart keywords (default_search_keywords) — used by RoomTypeIcon to
   *  pick a more specific glyph. */
  keywords: string[];
  parent_chain: { id: string; name: string; type: string }[];
  rule_outcome: RuleOutcome;
  ranking_score: number;
  ranking_reasons: string[];
  day_blocks?: Array<{
    start: string;
    end: string;
    status: 'busy' | 'pending' | 'requested';
    is_yours?: boolean;
  }>;
}

export interface FreeSlot {
  start: string;
  end: string;
  candidate_rooms: RankedRoom[];
  rank_score: number;
}

export interface ServiceLinePayload {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity: number;
  /** Defaults to the reservation window when omitted. */
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
  /** True (default) = clones for future occurrences; false = master-only. */
  repeats_with_series?: boolean;
  /** Optional asset to reserve alongside the line (specific projector etc.). */
  linked_asset_id?: string | null;
}

export interface BookingPayload {
  reservation_type?: ReservationType;
  space_id: string;
  requester_person_id: string;
  host_person_id?: string | null;
  start_at: string;
  end_at: string;
  /** Optional booking title. Maps to `bookings.title` (00277:32). */
  title?: string | null;
  /** Optional booking description. Maps to `bookings.description` (00277:33). */
  description?: string | null;
  attendee_count?: number;
  attendee_person_ids?: string[];
  recurrence_rule?: RecurrenceRule;
  source?: ReservationSource;
  override_reason?: string;
  /**
   * Optional service lines (catering / AV / setup) attached at booking
   * time. Triggers `BundleService.attachServicesToBooking` on the
   * backend after the booking lands. Lazy bundle creation: room-only
   * bookings (services absent or empty) skip the service-attachment
   * pipeline entirely.
   */
  services?: ServiceLinePayload[];
  /** Bundle metadata. Honored only when `services` is present. */
  bundle?: {
    bundle_type?: 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';
    cost_center_id?: string | null;
    template_id?: string | null;
  };
}

export interface MultiRoomBookingPayload {
  space_ids: string[];
  requester_person_id: string;
  host_person_id?: string | null;
  start_at: string;
  end_at: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
  source?: ReservationSource;
  /**
   * Services attach to the PRIMARY room only (first id in `space_ids`)
   * — multi-room atomicity is room-only; one bundle per group.
   */
  services?: ServiceLinePayload[];
  bundle?: {
    bundle_type?: 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';
    cost_center_id?: string | null;
    template_id?: string | null;
  };
}
