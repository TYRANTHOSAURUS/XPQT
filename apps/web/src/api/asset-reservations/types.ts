export type AssetReservationStatus = 'confirmed' | 'cancelled' | 'released';

export interface AssetReservation {
  id: string;
  tenant_id: string;
  asset_id: string;
  start_at: string;
  end_at: string;
  status: AssetReservationStatus;
  requester_person_id: string;
  linked_order_line_item_id: string | null;
  booking_bundle_id: string | null;
  created_at: string;
  updated_at: string;
}
