import type { ServiceLinePayload } from '@/api/orders';

export interface BundleTemplatePayload {
  name: string;
  room_criteria?: {
    min_attendees?: number;
    must_have_amenities?: string[];
    preferred_floor_id?: string | null;
  };
  default_duration_minutes?: number;
  services: Array<
    ServiceLinePayload & {
      /** Signed minutes from start_at; e.g. -30 = 30min before. */
      service_window_offset_minutes?: number;
      /** "1 lunch per attendee" — multiplied by attendee_count at hydration. */
      quantity_per_attendee?: number;
    }
  >;
  default_cost_center_id?: string | null;
}

export interface BundleTemplate {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  active: boolean;
  payload: BundleTemplatePayload;
  created_at: string;
  updated_at: string;
}
