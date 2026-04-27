/**
 * Bundle template payload jsonb — every field is optional. The backend
 * normalises empties to `undefined` so a "skeleton" template (just a name)
 * persists as `payload: {}`.
 */
export interface BundleTemplatePayloadServiceLine {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity?: number;
  /** Signed minutes from start_at; e.g. -30 = 30min before. */
  service_window_offset_minutes?: number;
  /** "1 lunch per attendee" — multiplied by attendee_count at hydration. */
  quantity_per_attendee?: number;
}

export interface BundleTemplatePayload {
  /** Optional — overridden by `BundleTemplate.name` for display. */
  name?: string;
  room_criteria?: {
    min_attendees?: number;
    must_have_amenities?: string[];
    preferred_floor_id?: string | null;
  };
  default_duration_minutes?: number;
  services?: BundleTemplatePayloadServiceLine[];
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
