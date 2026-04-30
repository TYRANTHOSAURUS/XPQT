export type BundleStatusRollup =
  | 'pending'
  | 'pending_approval'
  | 'confirmed'
  | 'partially_cancelled'
  | 'cancelled'
  | 'completed';

export type BundleType = 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';

export type BundleSource = 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception';

export interface BundleLine {
  id: string;
  order_id: string;
  catalog_item_id: string;
  catalog_item_name: string | null;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  /** Free-text note from the requester (AV placement, setup instructions,
   *  anything non-dietary the fulfillment team should see). Catering-specific
   *  dietary information lives on a separate `dietary_notes` column read
   *  by daily-list / vendor-portal / late-changes-widget — keep that
   *  channel clean. */
  requester_notes: string | null;
  /** Optimistic-concurrency token. The PATCH endpoint accepts this back as
   *  `expected_updated_at` to reject stale-browser writes. */
  updated_at: string;
  fulfillment_status:
    | 'ordered'
    | 'confirmed'
    | 'preparing'
    | 'delivered'
    | 'cancelled'
    | null;
  linked_ticket_id: string | null;
  linked_asset_reservation_id: string | null;
}

export interface BundleOrderRef {
  id: string;
  status: string;
  requested_for_start_at: string | null;
  requested_for_end_at: string | null;
}

export interface BundleTicketRef {
  id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  module_number: number | null;
  /** Denormalized human-readable assignee — vendor name, team name, or
   *  user's full name. Null when nothing is assigned yet. Computed by the
   *  backend so the frontend doesn't need to thread separate lookup
   *  tables through the booking-detail surface. */
  assignee_label: string | null;
}

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
  /** Populated by the GET /booking-bundles/:id detail endpoint. */
  orders?: BundleOrderRef[];
  tickets?: BundleTicketRef[];
  lines?: BundleLine[];
}
