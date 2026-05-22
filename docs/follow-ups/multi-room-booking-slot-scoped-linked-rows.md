# Multi-Room Booking Slots — Slot-Scoped Linked Rows

Date: 2026-05-22
Status: future feature improvement

## Current Guardrail

Single-slot edits on a multi-slot booking are blocked when the booking has live booking-level linked rows:

- `orders`
- `asset_reservations`
- `work_orders`

Those rows currently key off `booking_id`, not `booking_slot_id`, so the system cannot safely decide which linked rows should move with one edited room. Whole-booking edits remain allowed and propagate booking-keyed linked rows together.

## Desired Upgrade

Add first-class slot attribution for linked rows so multi-room bookings can support room-specific services, assets, and setup work.

Target model:

- Linked rows can be scoped to the whole booking or one booking slot.
- Booking-scoped rows continue to reference `booking_id`.
- Slot-scoped rows reference `booking_slot_id` and still carry `booking_id` for query convenience and tenant validation.
- A single-slot edit propagates only rows scoped to that `booking_slot_id`.
- A whole-booking edit propagates booking-scoped rows and all slot-scoped rows.

## Candidate Schema

Add to linked child tables:

- `scope text not null default 'booking' check (scope in ('booking', 'booking_slot'))`
- `booking_slot_id uuid null references booking_slots(id)`

Invariant:

- `scope='booking'` requires `booking_slot_id is null`.
- `scope='booking_slot'` requires `booking_slot_id is not null`.
- `booking_slot_id`, when present, must belong to the same `(tenant_id, booking_id)`.

Tables to evaluate:

- `orders`
- `order_line_items` if line-level slot assignment is needed
- `asset_reservations`
- `work_orders`
- `approvals` only if approval policy needs slot-specific chains

## Rollout

1. Add nullable columns and constraints behind a non-breaking migration.
2. Backfill existing rows as `scope='booking'`.
3. Update create/attach-plan builders to choose booking vs slot scope.
4. Update `AssembleEditPlanService`:
   - keep blocking ambiguous legacy booking-scoped rows on single-slot edits,
   - propagate slot-scoped rows for the edited slot,
   - keep whole-booking propagation unchanged.
5. Add live smoke coverage for a multi-room booking with one booking-scoped service and one slot-scoped asset/work order.

This lets the current guardrail grow into precise per-room behavior without changing the edit API shape again.
