export type DraftResponse = {
  id: string;
  tenant_id: string;
  floor_space_id: string;
  image_url: string | null;
  width_px: number | null;
  height_px: number | null;
  polygons: unknown[];
  labels: unknown[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
