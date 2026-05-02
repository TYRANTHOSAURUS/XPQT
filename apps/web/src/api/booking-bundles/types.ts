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

/**
 * Legacy `BookingBundle` shape — TRANSITIONAL.
 *
 * Booking-canonicalisation rewrite (2026-05-02):
 *   - `booking_bundles` was dropped; the booking IS the bundle now.
 *   - The `/booking-bundles/*` HTTP surface is GONE on the backend.
 *   - `primary_reservation_id` was removed (the bundle's id is the
 *     booking id, which is also the reservation id in callers' eyes).
 *
 * The type is retained so existing component imports compile while the
 * UI is being migrated. `useBundle` (queries.ts) is now a no-op stub
 * that never resolves a body — the lines/orders/tickets array surfaces
 * are intentionally empty until a backend slice ships read endpoints
 * for the booking's services + cascaded tickets.
 */
export interface BookingBundle {
  id: string;
  tenant_id: string;
  requester_person_id: string;
  host_person_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  source: BundleSource;
  /** Booking-level status (00277:49 enum), distinct from `status_rollup`
   *  which folds in line states. UI usually renders the rollup; this is
   *  surfaced for completeness. */
  status: string;
  cost_center_id: string | null;
  template_id: string | null;
  calendar_event_id: string | null;
  policy_snapshot: Record<string, unknown>;
  status_rollup: BundleStatusRollup;
  created_at: string;
  updated_at: string;
  /** Populated by `GET /reservations/:id/bundle-detail` (the read endpoint
   *  that replaced the dropped `/booking-bundles/:id` route post-rewrite).
   *  Always present in the response; declared optional only because callers
   *  short-circuit before render when the query is in flight. */
  orders?: BundleOrderRef[];
  tickets?: BundleTicketRef[];
  lines?: BundleLine[];
}
