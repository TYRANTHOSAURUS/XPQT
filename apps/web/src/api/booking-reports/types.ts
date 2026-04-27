// Response shapes for the room-booking management reports.
// Mirror the JSONB returned by the Postgres RPCs in migrations 00155 + 00156.

export interface BookingsReportParams {
  from: string;            // YYYY-MM-DD
  to: string;              // YYYY-MM-DD
  building_id?: string | null;
  tz: string;              // IANA timezone
}

export type BookingsOverviewParams = BookingsReportParams;

export interface ReportWindow {
  from: string;
  to: string;
  days: number;
}

// ===== Overview =====
export interface BookingsOverviewKpis {
  total_bookings: number;
  active_bookings: number;
  no_show_count: number;
  no_show_rate: number;
  cancellation_count: number;
  cancellation_rate: number;
  utilization: number;
  avg_seat_fill: number | null;
  services_attach_rate: number;
  rooms_in_scope: number;
}

export interface VolumeByDayPoint {
  date: string;
  confirmed: number;
  cancelled: number;
  no_show: number;
  completed: number;
}

export interface HeatmapCell {
  dow: number;
  hour: number;
  occupied_rooms: number;
  rooms_in_scope: number;
  utilization: number;
}

export interface TopRoomRow {
  space_id: string;
  name: string;
  building_name: string | null;
  bookings: number;
  booked_hours: number;
  no_show_rate: number;
  services_rate: number;
}

export interface NoShowWatchlistRow {
  reservation_id: string;
  room_name: string;
  building_name: string | null;
  organizer_name: string;
  organizer_email: string | null;
  start_at: string;
  end_at: string;
  released_at: string | null;
  attendee_count: number | null;
}

export interface BookingsOverviewResponse {
  window: ReportWindow;
  kpis: BookingsOverviewKpis;
  volume_by_day: VolumeByDayPoint[];
  utilization_heatmap: HeatmapCell[];
  top_rooms: TopRoomRow[];
  no_show_watchlist: NoShowWatchlistRow[];
  lead_time_buckets: { same_day: number; lt_24h: number; lt_7d: number; ge_7d: number };
  duration_buckets: { le_30m: number; le_1h: number; le_2h: number; gt_2h: number };
  services_breakdown: Record<string, number>;
}

// ===== Utilization =====
export interface UtilizationKpis {
  rooms_in_scope: number;
  avg_utilization: number;
  underused_count: number;
  overused_count: number;
  avg_attendees: number | null;
  avg_capacity_fit: number | null;
}

export interface UtilizationRoomRow {
  space_id: string;
  name: string;
  building_id: string | null;
  building_name: string | null;
  capacity: number | null;
  bookings: number;
  booked_hours: number;
  utilization: number;
  avg_attendees: number | null;
  capacity_fit: number | null;
  no_show_count: number;
}

export interface UtilizationByBuildingRow {
  building_id: string;
  building_name: string;
  room_count: number;
  bookings: number;
  booked_hours: number;
  utilization: number;
}

export interface UtilizationReportResponse {
  window: ReportWindow;
  kpis: UtilizationKpis;
  rooms: UtilizationRoomRow[];
  by_building: UtilizationByBuildingRow[];
  capacity_fit_buckets: {
    right_sized: number;
    oversized: number;
    undersized: number;
    unknown: number;
  };
}

// ===== No-shows =====
export interface NoShowsKpis {
  total_no_shows: number;
  total_cancellations: number;
  total_eligible: number;
  no_show_rate: number;
  cancellation_rate: number;
  avg_time_to_cancel_hours: number | null;
}

export interface NoShowsTrendPoint {
  date: string;
  no_shows: number;
  cancellations: number;
}

export interface NoShowOrganizerRow {
  person_id: string;
  name: string;
  email: string | null;
  no_show_count: number;
  total: number;
  rate: number;
}

export interface CancellationOrganizerRow {
  person_id: string;
  name: string;
  email: string | null;
  cancel_count: number;
  total: number;
  rate: number;
}

export interface NoShowsReportResponse {
  window: ReportWindow;
  kpis: NoShowsKpis;
  trend_by_day: NoShowsTrendPoint[];
  top_no_show_organizers: NoShowOrganizerRow[];
  top_cancellation_organizers: CancellationOrganizerRow[];
  time_to_cancel_buckets: {
    lt_1h: number;
    lt_24h: number;
    lt_7d: number;
    ge_7d: number;
    after_start: number;
  };
  watchlist: Array<{
    reservation_id: string;
    room_name: string;
    organizer_name: string;
    organizer_email: string | null;
    start_at: string;
    released_at: string | null;
    attendee_count: number | null;
  }>;
}

// ===== Services =====
export interface ServicesKpis {
  total_bookings: number;
  bundles_with_services: number;
  bookings_with_services: number;
  attach_rate: number;
  total_orders: number;
  total_estimated_cost: number;
  avg_cost_per_serviced_booking: number;
}

export interface ServicesByTypeRow {
  bundle_type: string;
  bookings: number;
  orders: number;
  est_cost: number;
}

export interface TopCatalogItemRow {
  catalog_item_id: string;
  name: string | null;
  line_count: number;
  total_qty: number;
  est_cost: number;
}

export interface ServicesByCostCenterRow {
  cost_center_id: string;
  code: string | null;
  name: string | null;
  bookings: number;
  est_cost: number;
}

export interface ServicesTrendPoint {
  date: string;
  serviced_bundles: number;
  est_cost: number;
}

export interface ServicesReportResponse {
  window: ReportWindow;
  kpis: ServicesKpis;
  by_bundle_type: ServicesByTypeRow[];
  top_catalog_items: TopCatalogItemRow[];
  by_cost_center: ServicesByCostCenterRow[];
  trend_by_day: ServicesTrendPoint[];
}

// ===== Demand =====
export interface DemandKpis {
  total_bookings: number;
  peak_hour_local: number | null;
  peak_dow: number | null;
  avg_bookings_per_business_day: number;
  rooms_in_scope: number;
}

export interface DemandHeatmapCell {
  dow: number;
  hour: number;
  occupied_rooms: number;
  bookings: number;
  rooms_in_scope: number;
  utilization: number;
}

export interface ContendedRoomRow {
  space_id: string;
  name: string;
  capacity: number | null;
  bookings: number;
}

export interface DemandByDayPoint {
  date: string;
  bookings: number;
  distinct_organizers: number;
}

export interface DemandReportResponse {
  window: ReportWindow;
  kpis: DemandKpis;
  demand_by_hour_dow: DemandHeatmapCell[];
  creation_lead_buckets: { same_day: number; lt_24h: number; lt_7d: number; ge_7d: number };
  top_contended_rooms: ContendedRoomRow[];
  demand_by_day: DemandByDayPoint[];
}
