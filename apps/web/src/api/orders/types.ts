export type OrderStatus =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'in_progress'
  | 'fulfilled'
  | 'cancelled';

export interface Order {
  id: string;
  tenant_id: string;
  booking_bundle_id: string | null;
  linked_reservation_id: string | null;
  requester_person_id: string;
  delivery_space_id: string | null;
  requested_for_start_at: string | null;
  requested_for_end_at: string | null;
  status: OrderStatus;
  recurrence_series_id: string | null;
  recurrence_rule: Record<string, unknown> | null;
  policy_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrderLineItem {
  id: string;
  order_id: string;
  catalog_item_id: string;
  menu_id: string | null;
  vendor_id: string | null;
  fulfillment_team_id: string | null;
  quantity: number;
  unit_price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  linked_ticket_id: string | null;
  linked_asset_reservation_id: string | null;
  policy_snapshot: Record<string, unknown>;
  recurrence_overridden: boolean;
  recurrence_skipped: boolean;
  skip_reason: string | null;
  repeats_with_series: boolean;
  fulfillment_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceLinePayload {
  catalog_item_id: string;
  menu_id?: string;
  quantity: number;
  /** Defaults to reservation window when omitted. */
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
  /** True (default) = clones for future occurrences; false = master-only. */
  repeats_with_series?: boolean;
  /** Optional asset to reserve alongside this line (e.g. a specific projector). */
  linked_asset_id?: string | null;
}
