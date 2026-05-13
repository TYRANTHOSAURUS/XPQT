export type Point = { x: number; y: number };
export type RenderHint = 'default' | 'seat' | 'parking';
export type Polygon = { space_id: string; points: Point[]; render_hint?: RenderHint };
export type Label = { text: string; x: number; y: number; size?: number };

export type DraftResponse = {
  id: string;
  tenant_id: string;
  floor_space_id: string;
  image_url: string | null;
  width_px: number | null;
  height_px: number | null;
  polygons: Polygon[];
  labels: Label[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PublishedFloorPlan = {
  floor: {
    space_id: string;
    image_url: string;
    width_px: number;
    height_px: number;
    labels: Label[];
  };
  spaces: Array<{
    id: string;
    name: string;
    type: string;
    capacity: number | null;
    amenities: string[];
    floor_plan_polygon: { points: Point[] };  // canonical shape — no fallback
    floor_plan_render_hint: RenderHint;
  }>;
};

// ---------------------------------------------------------------------------
// Availability types (D.2)
// ---------------------------------------------------------------------------

export type AvailabilityState =
  | 'available'
  | 'partial'
  | 'booked'
  | 'mine'
  | 'pending'
  | 'not_bookable';

export type SpaceAvailability = {
  /** Space UUID. Field name matches the RPC contract (00375 `cs.id`). */
  id: string;
  name: string;
  capacity: number | null;
  state: AvailabilityState;
  /** ISO timestamp when the space next becomes free (present when state === 'booked'). */
  free_at?: string | null;
  /** Booking id when state === 'mine' so the caller can wire a cancel action. */
  mine_booking_id?: string | null;
};

export type CrowdHeatmapBucket = {
  /** Hour-of-day for this bucket (7..19 inclusive). Field name + numeric type match RPC 00375. */
  hour: number;
  /** 0–1 occupancy ratio for this floor at this hour. */
  occupancy: number;
};

export type FloorAvailability = {
  spaces: SpaceAvailability[];
  /** Hour-by-hour occupancy buckets (7..19 inclusive). Field name matches RPC 00375. */
  crowd_heatmap: CrowdHeatmapBucket[];
  floor: {
    image_url: string | null;
    width_px: number | null;
    height_px: number | null;
  } | null;
};

// ---------------------------------------------------------------------------

export type PublishHistoryEntry = {
  id: string;
  published_at: string;
  published_by: string | null;
  image_url: string | null;
  width_px: number | null;
  height_px: number | null;
  polygons: Polygon[];
  labels: Label[];
};
