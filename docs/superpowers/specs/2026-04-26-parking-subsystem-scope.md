# Parking subsystem — scope note (deferred)

Date: 2026-04-26
Status: **deferred** — captured here so a future session can pick this up cold.

## Why this is its own sub-project

During sub-project 2 (linked services on bookings) brainstorm, parking
was originally proposed as a fourth service type alongside catering /
AV / setup. That isn't best in class.

A best-in-class parking module looks structurally identical to room
booking, not to an order line item. A line item can't model:

- Spot inventory with attributes (covered, accessible, EV charger,
  motorcycle, exec-only, visitor-only).
- A conflict guard preventing the same spot being booked twice for
  the same window.
- Per-spot policy (accessible-only for badged users, exec gating).
- A floor-plan / lot-map picker.
- Recurrence ("I drive in Mon/Wed/Fri").
- License-plate auto-release on no-show.
- A standalone booking flow for employees who aren't booking a meeting.

Visitors already follow this pattern — they got their own sub-project 3
even though they also link to bundles. Parking belongs in the same
position.

## Where this fits in the decomposition

Slot in as **sub-project 2.5**, parallel to sub-project 3 (visitors).
Depends on: sub-project 1 (rooms foundation) for the conflict-guard +
predicate-engine + recurrence-engine patterns to mirror. Not a hard
prerequisite for sub-project 4 (reception board), but the reception
board will want a parking surface — so 2.5 should land before 4.

```
1 (rooms foundation)        ✓ shipped
├── 2 (services on bookings)        ← brainstorming now
├── 2.5 (parking)                   ← THIS DOC, deferred
├── 3 (visitors)                    ← can parallel 2 / 2.5
└── 4 (reception + host workspaces) ← needs 1, 3, ideally 2.5
        └── 5 (notifications + workflows + calendar)
```

## v1 scope when we resume

- **Spot inventory** — `parking_spots` table, attributes for covered /
  accessible / EV charger / motorcycle / spot type (employee /
  visitor / exec). Same shape as `spaces` but with a parking-specific
  attribute set.
- **Reservation table** — `parking_reservations`, with the same
  conflict-guard pattern as `reservations` (`tstzrange` exclusion
  constraint, same status enum) and the same effective_start_at /
  effective_end_at trigger pattern.
- **Standalone booking flow** — `/portal/parking` (mirror of
  `/portal/rooms`): pick window, pick a spot from a lot map, confirm.
- **Add-on flow** — when booking a room, the dialog optionally adds
  visitor parking through the same picker; the resulting
  `parking_reservation` row gets a `booking_bundle_id` linking it to
  the bundle.
- **Recurrence** — reuse the recurrence engine; "Mon/Wed/Fri all-day
  spot" is a normal recurrence rule.
- **Policy engine** — reuse the predicate engine from
  `room-booking-rules`. New `parking_rules` table with an identical
  predicate shape; templates for "exec spots only for senior
  leadership", "accessible spots restricted to badged users",
  "visitor spots can't be booked by employees", "EV chargers
  rate-limited per requester per week".
- **Lot-map picker** — clone of the floor-plan picker. Spot polygons
  on `parking_spots.lot_map_polygon jsonb` (same column shape as
  `spaces.floor_plan_polygon`).
- **License-plate auto-release** — `parking_reservations.license_plate`
  + a no-show scan that runs the same way as `autoReleaseScan` for
  rooms. Default grace 15 min; configurable per spot.
- **Reception integration** — "Sarah's visitor parking is reserved
  in V12 for 2:30 — gate code 7421" surfaced on the reception board
  next to the visitor row.

## v1 explicitly out of scope

- Real-time gate / ANPR integration. Plate is captured, used for
  audit, but the auto-release runs on time alone in v1.
- Pricing / chargebacks. Spec the column, leave the engine for later.
- Garage-level capacity counters (only rectangular lots / per-spot
  inventory in v1).
- Mobile QR-code unlock — separate integration.
- Tandem / multi-spot bookings (one license plate, two adjacent
  spots).

## Integration contracts to lock in sub-project 1 / 2.5

- `bundle_type='parking'` already in the planned `booking_bundles`
  enum (per blueprint line 217) — confirms parking-as-bundle is a
  first-class flow.
- `parking_reservations.booking_bundle_id` nullable, mirroring
  `reservations.booking_bundle_id`.
- Bundle's `policy_snapshot` jsonb gets a `parking` key when a
  parking reservation is attached, capturing the matched policy at
  attach time (same pattern rooms use).
- Reception board (sub-project 4) reads parking reservations through
  the same "expected today" surface as rooms + visitors.

## Effort estimate

≈ 2.5 weeks once we sit down with it. Most of the heavy lifting
(conflict guard, predicate engine, recurrence, floor-plan picker,
auto-release scanner, realtime fan-out) is a clone-and-rename of the
room-booking module. The bespoke pieces are: spot attribute taxonomy,
lot-map editor on the admin side, and the license-plate UX.

## What to do when we resume

1. Re-read this doc + the room-booking foundation spec
   (`docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md`)
   side-by-side.
2. Open a brainstorm session: confirm spot taxonomy, confirm whether
   the parking rules engine reuses the same `room_booking_rules`
   table (with a `target_kind` column) or splits to a parallel
   `parking_rules` table. Default lean: parallel table, identical
   shape — easier to reason about, no risk of cross-domain rule leak.
3. Run the brainstorming → spec → plan → ship flow.

## Cross-link

When sub-project 2.5 lands, update the room-booking decomposition doc
(`docs/superpowers/specs/2026-04-25-room-booking-module-decomposition.md`)
to mark this row as in-progress / done.
