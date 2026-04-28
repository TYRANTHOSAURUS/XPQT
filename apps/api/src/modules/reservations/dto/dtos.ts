// DTOs for the reservations REST surface.
// Plain TypeScript interfaces matching the existing project pattern (see TicketController/CreateTicketDto).
// Validation is performed in the service layer where needed.

import type { RecurrenceRule } from './types';

export interface CreateReservationDto {
  reservation_type?: 'room' | 'desk' | 'parking' | 'other';
  space_id: string;
  requester_person_id: string;
  host_person_id?: string | null;
  start_at: string;
  end_at: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
  recurrence_rule?: RecurrenceRule;
  source?: string;
  override_reason?: string;
  /**
   * Service lines (catering / AV / room setup) attached at booking time.
   * BookingFlowService.create lazy-creates the bundle + delegates to
   * BundleService.attachServicesToReservation when this is non-empty.
   * Must accept the full per-line shape used by the post-booking
   * /reservations/:id/services endpoint so the composer can submit either
   * path without divergence.
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

export interface UpdateReservationDto {
  space_id?: string;
  start_at?: string;
  end_at?: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
  host_person_id?: string;
}

export interface CancelReservationDto {
  scope?: 'this' | 'this_and_following' | 'series';
  reason?: string;
  grace_minutes?: number;
}

export interface CheckInDto {
  // Empty for now — uses caller identity
}

export interface PickerCriteriaDto {
  must_have_amenities?: string[];
  preferred_amenities?: string[];
  has_video?: boolean;
  wheelchair_accessible?: boolean;
  smart_keywords?: string[];
}

export interface PickerDto {
  start_at: string;
  end_at: string;
  attendee_count: number;
  site_id?: string;
  building_id?: string;
  floor_id?: string;
  criteria?: PickerCriteriaDto;
  requester_id?: string;
  sort?: 'best_match' | 'closest' | 'smallest_fit' | 'most_underused';
  limit?: number;
  /**
   * Desk scheduler flag — return every candidate room even if it has
   * conflicts in the requested window. See PickerInput.include_unavailable.
   */
  include_unavailable?: boolean;
}

export interface FindTimeDto {
  duration_minutes: number;
  person_ids: string[];
  window_start: string;
  window_end: string;
  criteria?: PickerCriteriaDto;
}

export interface MultiRoomBookingDto {
  space_ids: string[];
  requester_person_id: string;
  host_person_id?: string | null;
  start_at: string;
  end_at: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
  source?: string;
  /**
   * Service lines (catering / AV / setup) attached to the PRIMARY room
   * only. Multi-room atomicity binds rooms; services bind to one bundle
   * — typically catering for the main hall, breakouts go without. The
   * service ships with the first space_id in the array.
   *
   * Recurrence on multi-room remains unsupported (the conflict-guard
   * semantics for "atomic group across multiple occurrences" need their
   * own design); the controller rejects multi-room + recurrence at the
   * boundary.
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
  bundle?: {
    bundle_type?: 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';
    cost_center_id?: string | null;
    template_id?: string | null;
  };
}

/**
 * Desk scheduler window query — fetches every reservation on the given
 * spaces between [start_at, end_at]. Operator/admin only (gated on
 * rooms.read_all or rooms.admin). One round-trip avoids the N+1 the desk
 * grid would otherwise hit when rendering 50 rooms × 7 days.
 */
export interface SchedulerWindowDto {
  space_ids: string[];
  start_at: string;
  end_at: string;
}

/**
 * Unified scheduler-data input — replaces the picker → window waterfall
 * with one round-trip. Backend resolves the scope (site/building/floor) →
 * candidate rooms, then runs parent-chain + reservations + (optional) rule
 * eval in parallel. See ListBookableRoomsService.loadSchedulerData.
 */
export interface SchedulerDataDto {
  start_at: string;
  end_at: string;
  attendee_count?: number;
  site_id?: string;
  building_id?: string;
  floor_id?: string;
  must_have_amenities?: string[];
  /** When set, rules are evaluated for this requester (booking-for mode). */
  requester_id?: string;
}
