# Phase 1.3 — Booking Compensation Blocker Map

> Produced 2026-05-04 by investigation task 1.3.0.
> Drives the design of `delete_booking_with_guard(p_booking_id uuid)` Postgres RPC.

## Scenario

`BookingFlowService.create` (booking-flow.service.ts:357–395) successfully executes the `create_booking` RPC, landing the booking + slot rows atomically. It then calls `BundleService.attachServicesToBooking` (bundle.service.ts:164–494) to attach services. If `attachServicesToBooking` fails partway through (e.g., asset GiST conflict, service rule deny, or approval-routing exception), the Cleanup class (bundle.service.ts:1878–1972) soft-cancels asset reservations and deletes order/line items. However, the booking itself persists with booking_id still pointing to rows that now carry orphaned references, leaving the room reserved despite the error response.

The compensation RPC must decide: for each table that may hold rows referencing this booking at failure time, should the RPC delete them outright, unhook the FK (set booking_id=NULL), block the delete if rows are present, or trust the cascade?

## Tables that may carry rows referencing the booking at compensation time

| Table | Written when | References via | Cleanup on attach fail | FK ON DELETE | Compensation decision | Rationale |
|---|---|---|---|---|---|---|
| `booking_slots` | `create_booking` RPC (before attach) | `booking_id` (PK anchor) | Not touched by cleanup | **CASCADE** (00277:119) | `delete` (covered by cascade) | Slots are created together with the booking. FK CASCADE means parent DELETE cascades automatically. RPC deletes the booking; slots follow. |
| `orders` | Per service-type group during attach (bundle.service.ts:214–222) | `booking_id` (FK) | Deleted by cleanup (bundle.service.ts:1932–1938) | SET NULL (00278:116) | `delete` | Cleanup already deletes orders on attach failure. If compensation runs, order must have been created (attach succeeded through one order insert) but failed later. Explicit DELETE ensures clean removal; SET NULL is a no-op since orders are already gone. |
| `order_line_items` | Per line during attach (bundle.service.ts:242–249) | No direct FK to booking (FK to order.id only) | Deleted by cleanup (bundle.service.ts:1907–1914) | N/A | `delete` | Cleanup deletes lines on attach failure. Lines don't reference booking_id directly — they reference order.id. Since orders are deleted, lines cascade automatically. Explicit DELETE is best-effort re-verification (idempotent). |
| `asset_reservations` | Per line with asset during attach (bundle.service.ts:229–238) | `booking_id` (FK) | **Soft-cancelled** (status='cancelled') by cleanup (bundle.service.ts:1920–1925) | SET NULL (00278:140) | `leave` | Cleanup soft-cancels (status='cancelled') but leaves booking_id intact. Cancelled rows are tombstones — they don't block future bookings (GiST exclusion checks status='confirmed' only). The RPC should not delete them (audit trail + GiST silent history matters). SET NULL cascade is harmless since the row's status is already 'cancelled'. |
| `approvals` (target on booking) | During rule evaluation, assembled by ApprovalRoutingService (bundle.service.ts:340–349) | `target_entity_id = booking.id AND target_entity_type IN ('booking')` | **NOT cancelled** by cleanup (per codex flag bundle.service.ts:1940–1964, approvals are cancelled only for target_entity_id in (order_ids \|\| oli_ids), not for booking.id) | N/A (no FK) | `leave` | Approvals anchored at booking.id (target_entity_type='booking') are created to require approval for the entire booking's service bundle. Cleanup explicitly does NOT cancel these (codex 2026-04-30 cited at line 1940–1945). The RPC should leave them in 'pending' state so the user/approver can still decide. If the booking is compensated (deleted), orphan approval rows are acceptable — they're historical. |
| `approvals` (target on orders/lines) | During rule evaluation for per-line outcomes (bundle.service.ts:318–335) | `target_entity_id IN (order_ids, oli_ids)` | **Cancelled** by cleanup (bundle.service.ts:1952–1964) when target_entity_id in (order_ids \|\| oli_ids) | N/A (no FK) | `leave` | Cleanup cancels these as part of orphan prevention (bundle.service.ts:1940–1945). By compensation time, they're already 'cancelled'. Leaving them is safe. |
| `work_orders` | NOT created during attach. Only fire AFTER cleanup.commit() (bundle.service.ts:375–456, SetupWorkOrderTriggerService.triggerMany runs line 456) | `booking_id` (FK) | N/A (never created before failure) | SET NULL (00278:91) | N/A | Setup triggers fire ONLY after cleanup.commit() (line 375), which is ONLY on success. If attach fails, no work orders are created. No compensation needed for this table. |
| `audit_events` | Inserted by this.audit() calls during bundle assembly + cleanup (bundle.service.ts:1652, etc.) | entity_type + entity_id (JSONB details payload only; no FK column) | Append-only; not touched by cleanup | N/A (no FK) | `leave` | Audit events have no FK to bookings. entity_id may reference order/oli/asset ids, which are being deleted, but the audit row is append-only and safe to leave. Orphan audit is expected and valuable for compliance. |
| `audit_outbox` | Possibly written by audit triggers (implementation detail of audit_events insert) | Details payload only (JSONB); no FK to booking | N/A (append-only) | N/A | `leave` | Outbox is append-only operational log. Orphan rows referencing deleted order/oli ids are safe. Eventual consumers must handle missing entities gracefully. |
| `recurrence_series` | Created AFTER attach succeeds (booking-flow.service.ts:440–485, after line 395) | `parent_booking_id` (FK to bookings.id) | Not touched; fires only on success | NO ACTION (00278:184) | `block` | Series row is created fire-and-forget AFTER attach (booking-flow.service.ts:406–415, guarded by booking.status !== 'pending_approval'). If compensation is called, a series may exist. FK has NO ACTION — DELETE would be rejected. The RPC should check for recurrence_series.parent_booking_id = booking_id; if present, abort with partial_failure. Recurrence series involve materialised occurrences; deleting the master without handling them is unsafe. |
| `visitors` | Not created by booking flow. Created by visitor module (Slice 4+) | `booking_id` (FK) | N/A (out of scope for bundle attach) | CASCADE (00278:45) | `delete` (cascade covers) | If any visitor rows exist, they cascade-delete automatically. RPC does not need explicit action — FK CASCADE on bookings.id → visitors.booking_id handles removal. |

## Edge cases discussed

### asset_reservations soft-cancel tombstones

**Decision: `leave`**

Cleanup soft-cancels asset_reservations (status='cancelled') to silence the GiST exclusion constraint — a cancelled reservation no longer blocks future bookings for the same asset+window. The `booking_id` column remains populated for audit trail. The compensation RPC should NOT delete these rows:

1. **Audit integrity** (bundle-cascade.service.ts:120–122 mirrors the pattern): soft-cancel is the standard tombstone discipline across the codebase.
2. **GiST semantics** (bundle.service.ts:1917–1918): setting status='cancelled' is the idiomatic "undo" for asset conflicts.
3. **SET NULL cascade is sufficient**: if the booking is deleted and the FK is SET NULL, the orphan row (booking_id=NULL, status='cancelled') remains but is harmless — no query path expects to find it.

If instead the RPC tries to delete asset_reservations outright, it risks breaking audit and re-triggering conflicts on re-insert during retry logic.

### approvals against the booking

**Decision: `leave`**

Approvals with `target_entity_type='booking' AND target_entity_id=booking.id` are assembled to represent approval requirements for the entire booking. Cleanup explicitly does NOT cancel these (bundle.service.ts:1940–1945):

> "The booking-level approval row may also exist via target_entity_id=booking.id but we don't cancel it here — the booking still exists."

**Rationale:**
1. The booking may still be alive at this time (attach failure does not delete the booking in the app-side flow).
2. Even if compensation deletes the booking, the approval row is historical — the user/approver should see a record of what was approved/denied.
3. Approvals for orders/line items are already cancelled by cleanup; booking-level approvals are a separate concern.

The RPC should ignore these rows during compensation. If the booking is deleted, the orphan approval becomes a historical artifact, which is acceptable for audit.

### audit trail

**Decision: `leave`**

Audit events are append-only and have no FK columns pointing to bookings. The entity_id may reference order, oli, asset_reservation, or booking IDs; details payload may carry JSONB with booking_id inside. When the booking is deleted:

1. Rows with entity_type IN ('order', 'order_line_item', 'asset_reservation', 'approval') and entity_id in the now-deleted set are orphaned but harmless.
2. Rows with entity_type='booking' and entity_id=booking.id become historical records of the booking's lifecycle — they should NOT be deleted.
3. Audit consumers must handle missing entity IDs gracefully (they already do for soft-deleted rows).

No explicit RPC action needed. Orphan audit is expected and valuable.

### recurrence series

**Decision: `block`**

The recurrence series row is created AFTER attach succeeds (booking-flow.service.ts:440–462) and is guarded by:

```typescript
if (input.recurrence_rule && !input.recurrence_series_id && this.recurrence && 
    booking.status !== 'pending_approval')
```

If compensation is called, a series may exist with `parent_booking_id = booking.id`. The FK has NO ACTION (00278:184), meaning DELETE will be rejected if a child series exists.

**RPC behavior**: Check for `recurrence_series` rows with `parent_booking_id = booking_id` inside the transaction. If any exist, return `partial_failure` with `blocked_by: ['recurrence_series']`. The recurrence series may have materialised occurrences (new booking rows) that reference back to this series. Deleting the parent without handling occurrences risks orphaning them and breaking the recurrence view. This is a true blocker — the caller must explicitly handle the series (cancel it, or call the RPC only if no series exists).

## RPC pseudocode (informative)

```plpgsql
function delete_booking_with_guard(p_booking_id uuid) returns jsonb {
  begin tx;
  
  -- SELECT FOR UPDATE to serialize concurrent operations on this booking
  select 1 from bookings where id = p_booking_id for update;
  
  -- Check blockers: recurrence_series with NO ACTION FK
  if exists (select 1 from recurrence_series where parent_booking_id = p_booking_id) then
    return jsonb_build_object(
      'kind', 'partial_failure',
      'blocked_by', array['recurrence_series']
    );
  end if;
  
  -- No explicit unhook/delete needed for:
  -- - asset_reservations: status is already 'cancelled'; FK SET NULL is sufficient
  -- - approvals: booking-level approvals are left for audit; order/line approvals already cancelled by app
  -- - audit_events / audit_outbox: append-only, safe to leave
  -- - work_orders: never created before attach fails, so none exist
  
  -- Delete the booking (cascades to booking_slots via ON DELETE CASCADE)
  delete from bookings where id = p_booking_id;
  
  commit;
  return jsonb_build_object('kind', 'rolled_back');
exception
  when others then
    rollback;
    rethrow;
}
```

## Open questions for Phase 1.3 implementation

1. **Recurrence series exception handling**: The RPC returns `partial_failure` with `blocked_by: ['recurrence_series']`. Should the compensation boundary in `BookingFlowService` retry, log, or bubble up to the user? (Design issue: Phase 1.3 contract spec says "abort with partial_failure"; app-side handling is Phase 1.3 integration.)

2. **audit_outbox implementation**: The plan assumes an append-only outbox. If the actual outbox has a DELETE path, orphan rows may pile up. Verify with Phase 6 (durable outbox refactor) whether cleanup is needed.

3. **Approval row lifecycle post-booking-delete**: If the booking is deleted, should the RPC auto-cancel booking-level approvals, or is leaving them as historical records sufficient? Codex 2026-04-30 says "the booking still exists" but compensation implies it's about to not exist. Clarify intent before RPC goes to prod.

