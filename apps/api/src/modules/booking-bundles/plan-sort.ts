/**
 * planSort — canonical-sort comparators per row kind.
 *
 * Spec: §7.4 (v8 mandatory canonical-sort table) of
 * docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
 *
 * The plan-builder MUST sort each row collection BEFORE assigning
 * `stableIndex` (and thus before generating `planUuid`s). Two TS plan-builds
 * for the same logical request MUST produce byte-identical jsonb regardless
 * of caller iteration order. v7 used a `_input_position` tie-breaker which
 * leaked input-order into the hash; v8 mandates fully-immutable
 * caller-provided fields in every comparator.
 *
 * **Sort tuples (ascending):**
 *
 *   - `slots`              → `(display_order, space_id, start_at)`
 *   - `orders`             → `(service_type)` — unique per order in v8 (one
 *                            order per service_type by construction)
 *   - `order_line_items`   → `(client_line_id)` — REQUIRED on every input
 *                            line; non-empty + per-order-unique enforced
 *                            by the plan-builder before the comparator
 *                            runs. Throws if missing.
 *   - `asset_reservations` → derived from the OLI it's attached to (sorted
 *                            by `client_line_id`); the comparator below
 *                            takes a `{ client_line_id }` projection so it
 *                            can be called independently in tests.
 *   - `approvals`          → `(approver_person_id)` — unique per approval
 *                            row after `ApprovalRoutingService.assemblePlan`
 *                            dedup.
 *
 * Touching any tuple here is a wire-protocol change. Every comparator must
 * use ONLY fully-immutable, caller-provided fields — no positional
 * indexes, no `Array.prototype.indexOf` calls, no derived defaults.
 */

const PLAN_SORT_CLIENT_LINE_ID_REQUIRED = 'plan_sort.client_line_id_required';

/**
 * Slot sort: `(display_order, space_id, start_at)` ascending. `display_order`
 * alone is normally sufficient (caller-supplied + unique per slot), but the
 * tuple stays fully-determined when two slots share a display_order in
 * pathological inputs.
 */
export function comparePlanSlots(
  a: { display_order: number; space_id: string; start_at: string },
  b: { display_order: number; space_id: string; start_at: string },
): number {
  const c = a.display_order - b.display_order;
  if (c !== 0) return c;
  const d = a.space_id.localeCompare(b.space_id);
  if (d !== 0) return d;
  return a.start_at.localeCompare(b.start_at);
}

/**
 * Order sort: `(service_type)` ascending. Service_type is unique per order
 * in v8 — one order per service_type group by construction.
 */
export function comparePlanOrders(
  a: { service_type: string },
  b: { service_type: string },
): number {
  return a.service_type.localeCompare(b.service_type);
}

/**
 * OLI sort: `(client_line_id)` ascending. `client_line_id` is REQUIRED on
 * every input line (validated by the plan-builder before this comparator
 * runs); secondary sort is never needed because `client_line_id` is unique
 * per line within an order.
 *
 * Throws when either line is missing `client_line_id`. Plan-builders should
 * have validated presence + per-order uniqueness BEFORE calling this — the
 * throw here is defense-in-depth, not the primary check.
 */
export function comparePlanOrderLineItems(
  a: { client_line_id: string },
  b: { client_line_id: string },
): number {
  if (!a.client_line_id || !b.client_line_id) {
    throw new Error(PLAN_SORT_CLIENT_LINE_ID_REQUIRED);
  }
  return a.client_line_id.localeCompare(b.client_line_id);
}

/**
 * Asset reservation sort: positionally tied to the OLI it's attached to,
 * which is already sorted by `client_line_id`. The comparator takes a
 * `{ client_line_id }` projection so it can be called independently in
 * tests + by the plan-builder when assembling the reservations array.
 */
export function comparePlanAssetReservations(
  a: { client_line_id: string },
  b: { client_line_id: string },
): number {
  if (!a.client_line_id || !b.client_line_id) {
    throw new Error(PLAN_SORT_CLIENT_LINE_ID_REQUIRED);
  }
  return a.client_line_id.localeCompare(b.client_line_id);
}

/**
 * Approval sort: `(approver_person_id)` ascending. After
 * `ApprovalRoutingService.assemblePlan` deduplication, each row has a
 * unique `approver_person_id` — no secondary sort needed.
 */
export function comparePlanApprovals(
  a: { approver_person_id: string },
  b: { approver_person_id: string },
): number {
  return a.approver_person_id.localeCompare(b.approver_person_id);
}

/**
 * Bundled namespace for ergonomic call sites:
 *   `[...rows].sort(planSort.olis)` instead of importing each function.
 */
export const planSort = {
  slots: comparePlanSlots,
  orders: comparePlanOrders,
  olis: comparePlanOrderLineItems,
  assetReservations: comparePlanAssetReservations,
  approvals: comparePlanApprovals,
} as const;
