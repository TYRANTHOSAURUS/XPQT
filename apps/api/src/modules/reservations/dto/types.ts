// Shared types for the reservations module.
//
// Booking-canonicalization rewrite (2026-05-02):
//   `bookings`        replaces `booking_bundles`  (00277:27)
//   `booking_slots`   replaces `reservations`     (00277:116)
//
// New canonical types: `Booking`, `BookingSlot`, `BookingStatus`, `BookingSource`,
// `SlotType`. The legacy `Reservation` interface is RETAINED (in shim form) so
// other slices that have not yet been rewritten — multi-room-booking,
// reservation.service, recurrence, check-in, list-bookable-rooms, approval —
// still typecheck. Those callers will be migrated in their own slices; their
// runtime behaviour is broken anyway because the underlying tables no longer
// exist. The shim keeps the build green during the multi-slice rewrite.

export type BookingStatus =
  | 'draft'
  | 'pending_approval'
  | 'confirmed'
  | 'checked_in'
  | 'released'
  | 'cancelled'
  | 'completed';

// 'auto' is intentionally excluded — see 00277:53-58 (FIX#2). Today's
// BookingFlowService.create:280 strips 'auto' before promoting to bundle;
// the new RPC enforces that at the DB CHECK constraint, so 'auto' must
// never reach the booking layer.
export type BookingSource =
  | 'portal'
  | 'desk'
  | 'api'
  | 'calendar_sync'
  | 'reception';

// 'parking' is on the new schema; 'other' is dropped (the new check
// constraint accepts only room/desk/asset/parking — 00277:122).
export type SlotType = 'room' | 'desk' | 'asset' | 'parking';

export type CalendarProvider = 'outlook';

// ── Legacy aliases — kept for transitional compatibility with not-yet-rewritten
//    callers (other slices). Map to the new canonical names. The 'auto' and
//    'other' values stay here so other modules that constructed ReservationSource
//    values (calendar-sync polling) still typecheck until they're rewritten.
export type ReservationStatus = BookingStatus;
export type ReservationSource = BookingSource | 'auto';
export type ReservationType = SlotType | 'other';

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;                         // every N (frequency) units
  by_day?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[]; // for weekly
  by_month_day?: number;                    // for monthly
  count?: number;                           // total occurrences
  until?: string;                           // ISO date string
}

export interface PolicySnapshot {
  // Snapshot of rule outcomes captured at booking time
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

// ─────────────────────────────────────────────────────────────────────────
// Canonical types (post-rewrite, 2026-05-02). Shapes match
// supabase/migrations/00277_create_canonical_booking_schema.sql.
// ─────────────────────────────────────────────────────────────────────────

/**
 * `Booking` — the canonical entity (was `booking_bundles`).
 * One row per booking. Holds title/description/window/cost/policy/recurrence
 * anchor. Per-resource holdings live in `BookingSlot` rows.
 *
 * Source: 00277:27-88 (table) + draft contract at
 * docs/superpowers/drafts/2026-05-02-canonical-booking-schema.sql:60-121.
 */
export interface Booking {
  id: string;
  tenant_id: string;
  // Identity (NEW — 00277:32-33)
  title: string | null;
  description: string | null;
  // People
  requester_person_id: string;             // 00277:36
  host_person_id: string | null;           // 00277:37
  booked_by_user_id: string | null;        // 00277:38
  // Location anchor — visibility queries scope here
  location_id: string;                     // 00277:41 (FIX#1)
  // Window
  start_at: string;                        // 00277:44
  end_at: string;                          // 00277:45
  timezone: string;                        // 00277:46 (NEW)
  // Status
  status: BookingStatus;                   // 00277:49-51
  // Source
  source: BookingSource;                   // 00277:56-58
  // Cost + policy
  cost_center_id: string | null;           // 00277:61
  cost_amount_snapshot: string | null;     // 00277:62 — numeric(10,2) → string to preserve precision
  policy_snapshot: PolicySnapshot;         // 00277:63
  applied_rule_ids: string[];              // 00277:64
  config_release_id: string | null;        // 00277:65
  // Calendar sync
  calendar_event_id: string | null;        // 00277:68
  calendar_provider: CalendarProvider | null; // 00277:69
  calendar_etag: string | null;            // 00277:70
  calendar_last_synced_at: string | null;  // 00277:71
  // Recurrence
  recurrence_series_id: string | null;     // 00277:74
  recurrence_index: number | null;         // 00277:75
  recurrence_overridden: boolean;          // 00277:76
  recurrence_skipped: boolean;             // 00277:77
  // Template provenance
  template_id: string | null;              // 00277:80
  // Audit
  created_at: string;
  updated_at: string;
}

/**
 * `BookingSlot` — per-resource holding within a Booking.
 * One slot per held space (room/desk/asset/parking). Multi-room bookings
 * have N slots all keyed to the same booking_id.
 *
 * Source: 00277:116-160.
 */
export interface BookingSlot {
  id: string;
  tenant_id: string;
  booking_id: string;                      // 00277:119 (FK to bookings.id, on delete cascade)
  slot_type: SlotType;                     // 00277:122 (was `reservation_type`)
  space_id: string;                        // 00277:124
  start_at: string;                        // 00277:127
  end_at: string;                          // 00277:128
  // Buffers (per-slot)
  setup_buffer_minutes: number;            // 00277:131
  teardown_buffer_minutes: number;         // 00277:132
  effective_start_at: string;              // 00277:133 (trigger-maintained)
  effective_end_at: string;                // 00277:134
  // time_range is server-side only; not exposed
  // Capacity (per-slot)
  attendee_count: number | null;           // 00277:138
  attendee_person_ids: string[];           // 00277:139
  // Status (per-slot — multi-room can have one slot cancelled while others continue)
  status: BookingStatus;                   // 00277:142-144
  // Check-in (per-slot)
  check_in_required: boolean;              // 00277:147
  check_in_grace_minutes: number;          // 00277:148
  checked_in_at: string | null;            // 00277:149
  released_at: string | null;              // 00277:150
  cancellation_grace_until: string | null; // 00277:151
  display_order: number;                   // 00277:154 (NEW — was implicit via primary_reservation_id)
  created_at: string;
  updated_at: string;
}

/**
 * `BookingWithSlots` — convenience composite returned by `BookingFlowService.create`.
 * The RPC returns `{booking_id, slot_ids}`; this service then re-reads the
 * full booking + slot rows for downstream consumption.
 */
export interface BookingWithSlots {
  booking: Booking;
  slots: BookingSlot[];
}

/**
 * Legacy `Reservation` interface — TRANSITIONAL SHIM.
 *
 * Other slices (multi-room-booking, reservation.service, recurrence,
 * check-in, list-bookable-rooms, approval, booking-notifications) still
 * import this. The shape keeps a flat slot+booking projection so existing
 * field accesses still typecheck. None of these callers are runtime-safe
 * against the new schema — they will be rewritten in their own slices.
 *
 * DO NOT add new code paths against this. Use `Booking` + `BookingSlot` for
 * any new code. Removed once all consumers migrate.
 */
export interface Reservation {
  id: string;
  tenant_id: string;
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
  // recurrence_master_id was dropped here (post-canonicalization).
  // The series link is one-direction now: bookings reference the
  // series via recurrence_series_id; there is no reverse "master row"
  // pointer. Verified zero readers in apps/api + apps/web.
  recurrence_index: number | null;
  recurrence_overridden: boolean;
  recurrence_skipped: boolean;
  linked_order_id: string | null;
  approval_id: string | null;
  setup_buffer_minutes: number;
  teardown_buffer_minutes: number;
  effective_start_at: string;
  effective_end_at: string;
  // time_range is server-side only; not exposed
  check_in_required: boolean;
  check_in_grace_minutes: number;
  checked_in_at: string | null;
  released_at: string | null;
  cancellation_grace_until: string | null;
  policy_snapshot: PolicySnapshot;
  applied_rule_ids: string[];
  source: ReservationSource;
  booked_by_user_id: string | null;
  cost_amount_snapshot: string | null; // numeric → string to preserve precision
  // multi_room_group_id was dropped here (post-canonicalization).
  // Multi-room atomicity is now expressed via shared `booking_id` on
  // slots — `BookingSlot.booking_id` (00277:152). Verified zero
  // readers in apps/api + apps/web.
  calendar_event_id: string | null;
  calendar_provider: CalendarProvider | null;
  calendar_etag: string | null;
  calendar_last_synced_at: string | null;
  // booking_bundle_id was dropped here by slice H6 (migration 00288).
  // Post-canonicalization the booking IS the bundle (00277:27) — there
  // is no separate id to expose. Readers that need the booking id should
  // use Reservation.id directly. The reservation-projection.ts at line
  // 121 stopped emitting the field in the same commit; the scheduler_data
  // RPC stopped in slice H3 (00286).
  created_at: string;
  updated_at: string;
  /** Root-first parent trail of the space, populated by `findOne` via the
   *  `public.space_path(uuid)` SQL function. Optional because list endpoints
   *  don't compute it. */
  space_path?: string[] | null;
}

// === Inputs to BookingFlowService ===

export interface CreateReservationInput {
  reservation_type?: ReservationType;       // default 'room' — maps to BookingSlot.slot_type
  space_id: string;                         // becomes both Booking.location_id AND BookingSlot.space_id (single-room v1)
  requester_person_id: string;
  host_person_id?: string | null;
  start_at: string;                         // ISO
  end_at: string;                           // ISO
  /**
   * Optional booking-level identity. Surfaces on the booking detail page;
   * cron jobs (notifications, daglijst) will use these. Maps to
   * `bookings.title` / `bookings.description` (00277:32-33).
   */
  title?: string | null;
  description?: string | null;
  /**
   * IANA tz; default 'UTC' at the RPC. Today the schema-default is 'UTC'
   * (00277:46) but recurrence and Outlook intercept will need this populated.
   */
  timezone?: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
  recurrence_rule?: RecurrenceRule;         // creates a series if present
  recurrence_series_id?: string;            // when materialising
  recurrence_index?: number;
  // recurrence_master_id input dropped — recurrence_series_id is the
  // canonical link (00277).
  source?: ReservationSource;
  // multi_room_group_id input dropped — multi-room atomicity uses
  // shared booking_id on slots now.
  // booking_bundle_id input dropped by slice H6 (migration 00288) — the
  // booking IS the bundle, so callers should pass nothing here.
  /**
   * Optional service lines (catering / AV / setup) attached at booking time.
   * Triggers `BundleService.attachServicesToReservation` after the
   * reservation lands. Lazy bundle creation: room-only bookings (services
   * absent or empty) skip the bundle entirely.
   */
  services?: Array<{
    catalog_item_id: string;
    menu_id?: string | null;
    quantity: number;
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
    repeats_with_series?: boolean;
    linked_asset_id?: string | null;
  }>;
  /** Bundle-level metadata. Honored only when `services` is present. */
  bundle?: {
    bundle_type?: 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';
    cost_center_id?: string | null;
    template_id?: string | null;
  };
}

export interface ActorContext {
  user_id: string;                          // app-side users.id
  person_id: string | null;
  is_service_desk: boolean;                 // gates book_on_behalf + override
  has_override_rules: boolean;              // rooms.override_rules permission
  override_reason?: string;                 // required if has_override_rules used
}

export type RecurrenceScope = 'this' | 'this_and_following' | 'series';

export interface CancelInput {
  scope?: RecurrenceScope;                  // for recurring; default 'this'
  reason?: string;
  grace_minutes?: number;                   // default 5
}

// === Picker types (used by ListBookableRoomsService) ===

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
  criteria?: PickerCriteria;
  requester_id?: string;        // when service desk is booking on behalf
  sort?: 'best_match' | 'closest' | 'smallest_fit' | 'most_underused';
  limit?: number;
  /**
   * When true, rooms with conflicting reservations in [start_at, end_at) are
   * still returned (with their `rule_outcome` reflecting any rule effects).
   * The desk scheduler sets this — it needs every reservable room's row
   * regardless of conflicts, otherwise rooms with bookings vanish from the
   * grid (and so do the bookings themselves, because the grid only paints
   * rooms it knows about). Default false: portal employees still see the
   * "available right now" subset they expect.
   */
  include_unavailable?: boolean;
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
  /** Sub-type within `type='room'` — e.g. 'meeting_room'. Used by the UI to
   *  pick a fallback icon when no image_url is set. */
  space_type: string;
  /** Optional cover image (lifted from spaces.attributes.image_url). The UI
   *  falls back to a type-icon tile when null. Stored in attributes today
   *  rather than its own column to avoid a forced migration; promote to a
   *  dedicated column when the admin UI lets users upload these. */
  image_url: string | null;
  capacity: number | null;
  min_attendees: number | null;
  amenities: string[];
  /** Smart keywords from spaces.default_search_keywords. Surfaced so the
   *  UI's icon fallback can pick a more specific glyph (huddle / board /
   *  lounge) without re-fetching. */
  keywords: string[];
  parent_chain: { id: string; name: string; type: string }[];
  rule_outcome: RuleOutcome;
  ranking_score: number;
  ranking_reasons: string[];
  // Mini timeline for the day of start_at — used by portal hybrid-C strip
  day_blocks?: Array<{ start: string; end: string; status: 'busy' | 'pending' | 'requested'; is_yours?: boolean }>;
}
