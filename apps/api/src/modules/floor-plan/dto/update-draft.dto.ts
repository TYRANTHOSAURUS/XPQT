import { z } from 'zod';
import { PolygonSchema } from './polygon.dto';

export const LabelSchema = z.object({
  text: z.string().min(1).max(60),
  x: z.number().finite(),
  y: z.number().finite(),
  size: z.number().int().min(8).max(48).optional(),
});

// image_url stores a STORAGE PATH, not a URL — do NOT use .url() validator.
export const UpdateDraftSchema = z
  .object({
    image_url: z.string().nullable().optional(),
    width_px: z.number().int().positive().max(8192).nullable().optional(),
    height_px: z.number().int().positive().max(8192).nullable().optional(),
    polygons: z.array(PolygonSchema).max(2000).optional(),
    labels: z.array(LabelSchema).max(200).optional(),
  })
  .superRefine((val, ctx) => {
    // Duplicate space_id rejection (only checks non-empty space_ids; '' is allowed for unlinked drafts).
    if (val.polygons) {
      const seen = new Set<string>();
      for (const p of val.polygons) {
        if (!p.space_id) continue;
        if (seen.has(p.space_id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['polygons'],
            message: `Duplicate space_id: ${p.space_id}`,
          });
          return;
        }
        seen.add(p.space_id);
      }
    }
  });

export type UpdateDraftDto = z.infer<typeof UpdateDraftSchema>;
