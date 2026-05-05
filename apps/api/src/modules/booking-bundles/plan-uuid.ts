import { v5 as uuidv5 } from 'uuid';

/**
 * planUuid + planSort — deterministic UUID derivation for AttachPlan rows.
 *
 * Spec: §7.4 of docs/superpowers/specs/2026-05-04-domain-outbox-design.md
 * (v8.1 contract — supersedes v7).
 *
 * Why deterministic UUIDs. The combined `create_booking_with_attach_plan`
 * RPC uses `attach_operations.payload_hash` for retry idempotency. If the
 * TS plan-builder generated fresh UUIDs on retry (`crypto.randomUUID()`),
 * the rebuilt plan would hash differently and trip `payload_mismatch`
 * instead of returning `cached_result` — the exact opposite of what
 * idempotency is meant to do (codex v5-C1).
 *
 * Two retries of the same logical request, given the same idempotency key,
 * MUST produce byte-identical jsonb. This file is the contract that makes
 * that true. Touching it is a wire-protocol change — see the in-flight
 * retry note on `NS_PLAN_BOOKING_WITH_ATTACH` below.
 */

/**
 * Stable namespace UUID for the booking-with-attach plan family. Generated
 * once and committed; **never rotate** — rotating breaks idempotency for
 * any in-flight retry that crosses the rotation boundary. The value is
 * fixed by spec §7.4 v6 (commit `fd561fd`).
 */
export const NS_PLAN_BOOKING_WITH_ATTACH =
  '8e7c1a32-4b6f-4a10-9d2e-6b9a2c4f7d10' as const;

/** Row kinds enumerated in the v8 stable-index table (§7.4). */
export type PlanRowKind =
  | 'booking'
  | 'slot'
  | 'order'
  | 'oli'
  | 'asset_reservation'
  | 'approval';

/**
 * Derive a deterministic UUID for a row in the attach plan. Same
 * (idempotencyKey, rowKind, stableIndex) → same UUID, every retry.
 *
 * **Per-row-kind stableIndex (v8 contract — supersedes v7):**
 *
 *   - `booking`            → `'0'` (always exactly one)
 *   - `slot`               → `String(slot.display_order)` — display_order
 *                            is caller-supplied + unique per slot
 *   - `order`              → `service_type` — one order per service_type
 *                            group; service_type IS the unique key
 *   - `oli`                → `${order_id}:${client_line_id}` — `client_line_id`
 *                            is REQUIRED on the input line (rejected at
 *                            validation time if missing or non-unique
 *                            within an order). v8: no `_input_position`
 *                            fallback — input order must not leak into
 *                            the hash.
 *   - `asset_reservation`  → `${order_id}:${client_line_id}` of the OLI
 *                            it's attached to (1:1 — every line that needs
 *                            one has exactly one).
 *   - `approval`           → `approver_person_id` — unique per approval
 *                            row after `ApprovalRoutingService.assemblePlan`
 *                            dedup; the approver_person_id IS the stable
 *                            index.
 *
 * Document any future change to per-row-kind derivation in this file's
 * docstring AND in §7.4 of the spec — a silent change here breaks
 * idempotency for any in-flight retry.
 */
export function planUuid(
  idempotencyKey: string,
  rowKind: PlanRowKind,
  stableIndex: string,
): string {
  if (!idempotencyKey || idempotencyKey.length === 0) {
    throw new Error('planUuid: idempotencyKey required');
  }
  if (!stableIndex || stableIndex.length === 0) {
    throw new Error('planUuid: stableIndex required (got empty string)');
  }
  return uuidv5(`${idempotencyKey}:${rowKind}:${stableIndex}`, NS_PLAN_BOOKING_WITH_ATTACH);
}
