// Shared types for the reservations module.
// Matches schema in supabase/migrations/00014_reservations.sql + 00122_reservations_room_booking_columns.sql.

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
  recurrence_master_id: string | null;
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
  multi_room_group_id: string | null;
  calendar_event_id: string | null;
  calendar_provider: CalendarProvider | null;
  calendar_etag: string | null;
  calendar_last_synced_at: string | null;
  booking_bundle_id: string | null;
  created_at: string;
  updated_at: string;
}

// === Inputs to BookingFlowService ===

export interface CreateReservationInput {
  reservation_type?: ReservationType;       // default 'room'
  space_id: string;
  requester_person_id: string;
  host_person_id?: string | null;
  start_at: string;                         // ISO
  end_at: string;                           // ISO
  attendee_count?: number;
  attendee_person_ids?: string[];
  recurrence_rule?: RecurrenceRule;         // creates a series if present
  recurrence_series_id?: string;            // when materialising
  recurrence_index?: number;
  recurrence_master_id?: string;
  source?: ReservationSource;
  multi_room_group_id?: string;
  booking_bundle_id?: string;
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
