// Response shapes for the room-booking overview report.
// Mirrors the JSONB returned by public.room_booking_report_overview (00155).
// Spec: docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md

export interface BookingsOverviewParams {
  from: string;            // YYYY-MM-DD
  to: string;              // YYYY-MM-DD
  building_id?: string | null;
  tz: string;              // IANA timezone
}

export interface BookingsOverviewKpis {
  total_bookings: number;
  active_bookings: number;
  no_show_count: number;
  no_show_rate: number;            // 0..1
  cancellation_count: number;
  cancellation_rate: number;       // 0..1
  utilization: number;             // 0..1
  avg_seat_fill: number | null;    // 0..1, null when no eligible bookings
  services_attach_rate: number;    // 0..1
  rooms_in_scope: number;
}

export interface VolumeByDayPoint {
  date: string;            // YYYY-MM-DD, gap-filled
  confirmed: number;
  cancelled: number;
  no_show: number;
  completed: number;
}

export interface HeatmapCell {
  dow: number;             // 1 (Mon) .. 7 (Sun)
  hour: number;            // 8..20 in local tz
  occupied_rooms: number;
  rooms_in_scope: number;
  utilization: number;     // 0..1
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
  window: { from: string; to: string; days: number };
  kpis: BookingsOverviewKpis;
  volume_by_day: VolumeByDayPoint[];
  utilization_heatmap: HeatmapCell[];
  top_rooms: TopRoomRow[];
  no_show_watchlist: NoShowWatchlistRow[];
  lead_time_buckets: { same_day: number; lt_24h: number; lt_7d: number; ge_7d: number };
  duration_buckets: { le_30m: number; le_1h: number; le_2h: number; gt_2h: number };
  services_breakdown: Record<string, number>;
}
