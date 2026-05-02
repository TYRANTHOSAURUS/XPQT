/**
 * Zod request-body validators for visitors REST endpoints.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6, §7, §8
 *
 * Pattern note: matches the routing module's `RoutingRuleCreateSchema`
 * pattern — zod schemas live next to the DTOs, controllers call
 * `safeParse` and convert errors to `BadRequestException` via
 * `formatZodError`. Keeps validation runtime-checked without dragging
 * `class-validator` decorators into a CJS-built monorepo where zod is
 * already established.
 */

import { z } from 'zod';

const uuidString = () =>
  z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'invalid uuid',
  );

const isoString = () =>
  z.string().refine(
    (v) => !Number.isNaN(new Date(v).getTime()),
    { message: 'must be a valid ISO 8601 timestamp' },
  );

// ─── invitation ────────────────────────────────────────────────────────────

export const CreateInvitationSchema = z.object({
  first_name: z.string().min(1).max(120),
  last_name: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  visitor_type_id: uuidString(),
  expected_at: isoString(),
  expected_until: isoString().optional(),
  building_id: uuidString(),
  meeting_room_id: uuidString().optional(),
  // Post-canonicalisation (2026-05-02): canonical link is `booking_id`.
  // The legacy `booking_bundle_id` stays accepted as an alias for callers
  // that haven't migrated; the service prefers `booking_id` when both
  // are present. `reservation_id` is gone (column dropped 00278:38).
  booking_id: uuidString().optional(),
  booking_bundle_id: uuidString().optional(),
  co_host_person_ids: z.array(uuidString()).max(20).optional(),
  notes_for_visitor: z.string().max(2000).optional(),
  notes_for_reception: z.string().max(2000).optional(),
});

// ─── reception ─────────────────────────────────────────────────────────────

export const ReceptionWalkupSchema = z.object({
  first_name: z.string().min(1).max(120),
  last_name: z.string().max(120).optional(),
  company: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  visitor_type_id: uuidString(),
  primary_host_person_id: uuidString(),
  arrived_at: isoString().optional(),
});

export const ReceptionCheckInSchema = z.object({
  arrived_at: isoString().optional(),
});

export const ReceptionCheckOutSchema = z.object({
  checkout_source: z.enum(['reception', 'host']),
  pass_returned: z.boolean().optional(),
});

export const PassAssignSchema = z.object({
  visitor_id: uuidString(),
});

export const PassReserveSchema = z.object({
  visitor_id: uuidString(),
});

export const PassMissingSchema = z.object({
  reason: z.string().max(500).optional(),
});

// ─── kiosk ─────────────────────────────────────────────────────────────────

export const KioskQrCheckinSchema = z.object({
  token: z.string().min(8).max(256),
});

export const KioskNameCheckinSchema = z.object({
  visitor_id: uuidString(),
  host_first_name_confirmation: z.string().min(1).max(120),
});

export const KioskWalkupSchema = z.object({
  first_name: z.string().min(1).max(120),
  last_name: z.string().max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  visitor_type_id: uuidString(),
  primary_host_person_id: uuidString(),
});

// ─── admin ─────────────────────────────────────────────────────────────────

export const VisitorTypeCreateSchema = z.object({
  type_key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'lowercase / underscore / digit only'),
  display_name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  requires_approval: z.boolean().optional(),
  allow_walk_up: z.boolean().optional(),
  default_expected_until_offset_minutes: z.number().int().min(15).max(24 * 60).optional(),
  active: z.boolean().optional(),
});

export const VisitorTypeUpdateSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  requires_approval: z.boolean().optional(),
  allow_walk_up: z.boolean().optional(),
  default_expected_until_offset_minutes: z.number().int().min(15).max(24 * 60).optional(),
  active: z.boolean().optional(),
});

export const PassPoolCreateSchema = z.object({
  space_id: uuidString(),
  notes: z.string().max(500).optional(),
});

export const PassPoolUpdateSchema = z.object({
  notes: z.string().max(500).optional(),
  retired: z.boolean().optional(),
});

export const PassCreateSchema = z.object({
  pass_number: z.string().min(1).max(60),
  pass_type: z.string().max(60).optional(),
  notes: z.string().max(500).optional(),
});

export const PassUpdateSchema = z.object({
  notes: z.string().max(500).optional(),
  retired: z.boolean().optional(),
});

export const KioskProvisionSchema = z.object({}).optional();

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Compact zod error → string suitable for a 400 body. Joins up to the
 * first 3 issues. Mirrors `routing.controller.ts#formatZodError`.
 */
export function formatZodError(err: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  const msgs = err.issues.slice(0, 3).map((i) => {
    const path = i.path.length > 0 ? i.path.join('.') : '(body)';
    return `${path}: ${i.message}`;
  });
  return msgs.join('; ');
}
