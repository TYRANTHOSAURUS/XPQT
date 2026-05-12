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
