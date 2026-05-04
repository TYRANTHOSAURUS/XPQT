# Phase 2 — Split `GET /reservations` into booking-grain + slot-grain endpoints

> Tracked from /full-review v3 closure I5 (2026-05-04).
> Strategic decision in `docs/superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md` §3.

## Why

Today's `GET /reservations` (served by `ReservationService.listMine` / `listForOperator`) reads from `booking_slots` joined with `bookings`. It returns **one row per slot**. Multi-room bookings surface N rows that all share the same `booking_id` but carry distinct `slot_id`s.

This is correct for the desk scheduler grid (which is slot-grain — every cell is a slot) but wrong for the portal "My bookings" list and the operator booking list (which are booking-grain — one card per atomic booking).

The frontend deduplicates client-side (`apps/web/src/pages/portal/me-bookings/components/bookings-list.tsx:48-58`) but pagination boundaries don't align: `limit=20` on a multi-room-heavy account yields 12-20 cards depending on density. The client doesn't auto-paginate to compensate; the user sees a partial page + a "Next page" CTA that may also be partial.

Phase 1 accepts this as a known limitation (see §26 of `docs/assignments-routing-fulfillment.md`). Phase 2 fixes it by splitting the endpoint.

## Target shape

Two endpoints, one identity each (per the cursor / order-by rule in §26):

### `GET /bookings`

- **Reads from `bookings`** with embedded primary-slot info (lowest `display_order`, ties by `created_at` ascending).
- **One row per booking** — no client-side dedup needed.
- **Cursor:** `(start_at, booking_id)` tuple.
- **Pagination:** `limit=20` returns up to 20 distinct bookings, no surprise fewer-than-N.
- **Use cases:**
  - Portal "My bookings" list (`/me/bookings`).
  - Operator booking list (`/desk/bookings`).
  - Admin reports that aggregate at the booking grain.

### `GET /booking-slots`

- **Reads from `booking_slots`** joined with `bookings` (the current shape, but explicitly slot-grain).
- **One row per slot** — desk scheduler N rows for an N-room booking.
- **Cursor:** `(start_at, slot_id)` tuple.
- **Pagination:** `limit=200` returns up to 200 slots — fine for the desk scheduler window read which already runs on a fixed 7-day × N-room window.
- **Use cases:**
  - Desk scheduler grid (`/desk/scheduler`).
  - Cell-level checks (which slot covers this hour for this room?).
  - Slot-targeted edits (drag/resize/move).

## Migration plan

1. **Add `GET /bookings` alongside the existing `GET /reservations`.** Don't break the desk scheduler — it's the only consumer that legitimately needs slot-grain.
2. **Migrate the portal "My bookings" list** (`apps/web/src/api/me-bookings/...`) to `GET /bookings`. Drop the client-side dedup loop in `bookings-list.tsx:48-58`.
3. **Migrate the operator list** (`apps/web/src/api/bookings/...` for `/desk/bookings`) to `GET /bookings`. Same dedup-removal.
4. **Rename `GET /reservations` → `GET /booking-slots`.** Update the desk scheduler call site (`apps/web/src/api/scheduler/...`).
5. **Deprecate the old endpoint name with a 6-month sunset window.** The route handler can alias to `/booking-slots` during deprecation. Frontend hooks already use the React Query module factory pattern so the breakage is contained to one file per surface.

## Out-of-scope concerns

- **Visibility:** both endpoints continue to gate through `ReservationVisibilityService.getVisibleIds`. The split doesn't change visibility semantics — the booking-grain endpoint just answers "which BOOKINGS am I allowed to see" instead of "which SLOTS".
- **Approvals / pending-state filters:** `scope='pending_approval'` works on either grain — booking-level approval surfaces the booking, slot-level checkpoints surface their slots.
- **Sorting:** booking-grain sorts by `bookings.start_at` (= MIN over slots, maintained by 00291 + 00293). Slot-grain sorts by `booking_slots.start_at`.

## Acceptance criteria

- `GET /bookings?limit=20` returns exactly 20 distinct booking rows (or fewer if the user has fewer than 20 visible).
- `GET /booking-slots?limit=200&space_ids=...&start_at=...&end_at=...` returns the desk scheduler window, slot-grain, no dedup needed.
- Portal "My bookings" no longer runs the `seen.add(r.booking_id)` dedup loop.
- Operator `/desk/bookings` shows 20 booking cards on the first page, every page.
- Desk scheduler unaffected (continues using the slot-grain endpoint, just renamed).

## References

- `docs/assignments-routing-fulfillment.md` §26 — Identity rules.
- `docs/superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md` §3 — strategic decision to defer.
- `apps/api/src/modules/reservations/reservation.service.ts:177-264` — current `listMine` (slot-grain).
- `apps/api/src/modules/reservations/reservation.service.ts:282-362` — current `listForOperator` (slot-grain).
- `apps/web/src/pages/portal/me-bookings/components/bookings-list.tsx:48-58` — client-side dedup loop to delete.
