// Mirrors the API's reservations DTOs (apps/api/src/modules/reservations/dto/types.ts).

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

export interface Reservation {
  id: string;
  tenant_id: string;
  module_number: number;
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
  multi_room_group_id: string | null;
  calendar_event_id: string | null;
  calendar_provider: CalendarProvider | null;
  calendar_etag: string | null;
  calendar_last_synced_at: string | null;
  booking_bundle_id: string | null;
  created_at: string;
  updated_at: string;
  // Optional denormalised display fields. Populated by `/scheduler-data`
  // and the operator list endpoint so the desk grid + lists can label
  // rows without each block firing its own `usePerson` lookup. Absent on
  // reads from `/reservations/:id` and friends.
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
  attendee_count?: number;
  attendee_person_ids?: string[];
  recurrence_rule?: RecurrenceRule;
  source?: ReservationSource;
  override_reason?: string;
  /**
   * Optional service lines (catering / AV / setup) attached at booking
   * time. Triggers `BundleService.attachServicesToReservation` on the
   * backend after the reservation lands. Lazy bundle creation: room-only
   * bookings (services absent or empty) skip the bundle entirely.
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
  start_at: string;
  end_at: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
}
