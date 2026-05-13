import { z } from 'zod';

/**
 * DTOs for the MaintenancePlan admin surface (Slice C §5).
 *
 * - CreateMaintenancePlanSchema gates the POST body. The asset_id XOR
 *   asset_type_id mutex is enforced here (the DB CHECK is defense-in-
 *   depth; the controller surface returns a richer
 *   maintenance_plans.target_mutex_violation 422 instead of a generic
 *   db.constraint 500).
 * - UpdateMaintenancePlanSchema gates PATCH bodies — all fields optional,
 *   but if EITHER asset_id or asset_type_id is provided BOTH are required
 *   in the same payload so the mutex stays evaluable (a half-update would
 *   leave the row in a state the schema CHECK forbids).
 * - ListMaintenancePlansQuerySchema gates GET query params.
 *
 * UUID shape regex mirrors apps/api/src/common/tenant-validation.ts:17
 * (loose, no version-nibble check — survives a future move from v4 to v7).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANCHOR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const RECURRENCE_UNIT = z.enum(['day', 'week', 'month', 'year']);
const PRIORITY = z.enum(['low', 'medium', 'high', 'critical', 'urgent']);
const UUID = z.string().regex(UUID_RE, { message: 'must be a uuid' });
const ANCHOR_DATE = z.string().regex(ANCHOR_DATE_RE, {
  message: 'must be a YYYY-MM-DD date',
});

const TITLE_MAX = 200;
const DESC_MAX = 2000;
const NAME_MAX = 200;

export const CreateMaintenancePlanSchema = z
  .object({
    name: z.string().trim().min(1, 'required').max(NAME_MAX),
    description: z.string().max(DESC_MAX).nullish(),
    active: z.boolean().optional(),

    asset_id: UUID.nullish(),
    asset_type_id: UUID.nullish(),

    request_type_id: UUID,
    location_id: UUID.nullish(),

    title_template: z.string().trim().min(1, 'required').max(TITLE_MAX),
    description_template: z.string().max(DESC_MAX).nullish(),
    priority: PRIORITY.optional(),
    planned_duration_minutes: z
      .number()
      .int()
      .positive()
      .max(60 * 24 * 7)
      .nullish(),

    recurrence_interval: z.number().int().positive(),
    recurrence_unit: RECURRENCE_UNIT,
    anchor_date: ANCHOR_DATE,
    lead_days: z.number().int().min(0).max(365).optional(),
  })
  .strict();

export const UpdateMaintenancePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    description: z.string().max(DESC_MAX).nullish(),
    active: z.boolean().optional(),

    asset_id: UUID.nullish(),
    asset_type_id: UUID.nullish(),

    request_type_id: UUID.optional(),
    location_id: UUID.nullish(),

    title_template: z.string().trim().min(1).max(TITLE_MAX).optional(),
    description_template: z.string().max(DESC_MAX).nullish(),
    priority: PRIORITY.optional(),
    planned_duration_minutes: z
      .number()
      .int()
      .positive()
      .max(60 * 24 * 7)
      .nullish(),

    recurrence_interval: z.number().int().positive().optional(),
    recurrence_unit: RECURRENCE_UNIT.optional(),
    anchor_date: ANCHOR_DATE.optional(),
    lead_days: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .refine(
    (val) => Object.keys(val).length > 0,
    'at least one field is required',
  );

export const ListMaintenancePlansQuerySchema = z
  .object({
    asset_id: UUID.optional(),
    asset_type_id: UUID.optional(),
    request_type_id: UUID.optional(),
    active: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        if (typeof val === 'boolean') return val;
        return val === 'true';
      }),
    limit: z
      .union([z.number().int().positive().max(200), z.string()])
      .optional()
      .transform((val) => {
        if (val === undefined) return 50;
        if (typeof val === 'number') return val;
        const parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed <= 0) return 50;
        return Math.min(200, Math.floor(parsed));
      }),
    offset: z
      .union([z.number().int().min(0), z.string()])
      .optional()
      .transform((val) => {
        if (val === undefined) return 0;
        if (typeof val === 'number') return val;
        const parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed < 0) return 0;
        return Math.floor(parsed);
      }),
  })
  .strict();

export type CreateMaintenancePlanDto = z.infer<typeof CreateMaintenancePlanSchema>;
export type UpdateMaintenancePlanDto = z.infer<typeof UpdateMaintenancePlanSchema>;
export type ListMaintenancePlansQuery = z.infer<typeof ListMaintenancePlansQuerySchema>;
