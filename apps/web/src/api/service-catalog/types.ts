export interface ResolvedMenuOffer {
  menu_id: string;
  menu_item_id: string;
  vendor_id: string | null;
  fulfillment_team_id: string | null;
  owning_team_id: string | null;
  price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  lead_time_hours: number | null;
  service_type: string;
}
