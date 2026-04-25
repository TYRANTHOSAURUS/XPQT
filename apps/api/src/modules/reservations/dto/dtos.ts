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
  start_at: string;
  end_at: string;
  attendee_count?: number;
  attendee_person_ids?: string[];
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
