import { z } from 'zod';

export const PolygonPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

// space_id may be empty for unlinked polygons in a draft. Publish RPC rejects empty.
export const PolygonSchema = z.object({
  space_id: z.union([z.string().uuid(), z.literal('')]),
  points: z.array(PolygonPointSchema).min(3).max(200),
  render_hint: z.enum(['default', 'seat', 'parking']).optional(),
});

export type Polygon = z.infer<typeof PolygonSchema>;
