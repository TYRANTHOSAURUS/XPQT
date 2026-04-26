export type BundleStatusRollup =
  | 'pending'
  | 'pending_approval'
  | 'confirmed'
  | 'partially_cancelled'
  | 'cancelled'
  | 'completed';

export type BundleType = 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';

export type BundleSource = 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception';

export interface BookingBundle {
  id: string;
  tenant_id: string;
  bundle_type: BundleType;
  requester_person_id: string;
  host_person_id: string | null;
  primary_reservation_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  source: BundleSource;
  cost_center_id: string | null;
  template_id: string | null;
  calendar_event_id: string | null;
  policy_snapshot: Record<string, unknown>;
  status_rollup: BundleStatusRollup;
  created_at: string;
  updated_at: string;
}
