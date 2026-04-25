# Room Booking Module — Decomposition

Date: 2026-04-25

Related docs:
- [Workplace Booking & Visitor Blueprint](../../workplace-booking-and-visitor-blueprint-2026-04-21.md) — north-star product shape
- [Spec](../../spec.md)

## Why this doc exists

The "room booking module" as defined in the blueprint is genuinely four to five subsystems sitting under one user-facing flow. Designing all of it in one spec produces a document nobody reads and an implementation plan nobody can execute. This doc captures the agreed decomposition so each sub-project gets its own brainstorm → spec → plan → implementation cycle, and the integration contracts between them are visible from day one.

## Sub-projects

Each row gets its own dated design doc under `docs/superpowers/specs/` and its own implementation slice.

| # | Sub-project | Depends on | Scope summary |
|---|---|---|---|
| 1 | **Rooms foundation** | — | Schema upgrade (buffers, check-in, expanded status, policy snapshot, source, calendar_event_id, conflict guard via `tstzrange` exclusion), booking policies (lead time, max duration, capacity tolerance, who-can-book), employee booking flow, "my bookings", admin reservability surfaces. |
| 2 | **Linked services on a booking** | 1 | Add optional catering / AV / setup modules to the booking flow → spawn linked `orders` + `order_line_items` + work orders. Introduces `booking_bundles` as the orchestration parent. Service availability rules, approval thresholds. |
| 3 | **Visitors** | 1 (bundle from 2 optional) | Preregistration, host invite, expanded visitor status, visitor policy (NDA, ID, escort), link to reservation + bundle. Can partly parallel sub-project 2. |
| 4 | **Reception board + host workspace** | 1, 3 | Operator UX over reservations + visitors + service readiness — "expected today" board, exception handling, host summary. No new domain entities. |
| 5 | **Notifications + workflow templates** | 1, 2, 3 | Cross-cutting. Booking confirmation, visitor invite, approval requested, room change, service at risk. The 10 workflow templates from the blueprint. Calendar sync mirroring. Pieces ship inside each prior slice; this sub-project closes the gaps. |

## Sequencing

Strict prerequisites: 1 → (2 ∥ 3) → 4. Sub-project 5 is cross-cutting — partial bits ship inside slices 1–4, with a final consolidation slice.

```
1 (rooms foundation)
├── 2 (services on bookings)         ← introduces booking_bundles
├── 3 (visitors)                     ← can parallel 2
└── 4 (reception + host workspaces)  ← needs 1 + 3
        └── 5 (notifications + workflows + calendar) ← cross-cutting tail
```

## Integration contracts (decided up front)

These are the seams between sub-projects. Each is locked in sub-project 1 so 2–5 plug in without rework.

- **`reservations.booking_bundle_id` is nullable from day one.** Sub-project 1 ships the column unused; sub-project 2 starts populating it.
- **Reservation status enum is the full blueprint set in sub-project 1**: `draft`, `pending_approval`, `confirmed`, `checked_in`, `released`, `cancelled`, `completed`. Sub-projects 2–4 don't migrate the enum; they just consume more states.
- **`reservations.policy_snapshot jsonb` is captured at create time in sub-project 1.** When sub-projects 2–5 add their own policies (visitor, service availability, approval), they append to the same snapshot pattern on their respective records — no new infrastructure needed.
- **Conflict guard lives on `reservations` only.** Bundles, visitors, and orders never own occupancy.
- **Workflow events fire from sub-project 1.** Events `reservation.created`, `reservation.updated`, `reservation.cancelled` exist from day one with payloads that future sub-projects can extend. Sub-projects 2–5 add their own events but don't reshape the existing ones.
- **Admin surfaces use `SettingsPageShell` (per CLAUDE.md).** No bespoke layouts.
- **Operator UX (reception board, host workspace) is its own surface, not the desk.** Decided up front so sub-project 4 doesn't bolt onto generic ticket views.

## What is explicitly NOT in any sub-project

- **Mutable workflow definitions.** The blueprint requires immutable published workflows + version pinning + timer resume + diff + rollback before this module can ship broadly. That work is a separate prerequisite track, not part of room booking. Sub-project 5 assumes it's done.
- **Access control / badge / Wi-Fi / signage integrations.** Blueprint "Later" tier — not in scope here.
- **AI-assisted planning, calendar-driven meeting intent detection.** Blueprint "Later" tier — not in scope.
- **Desk hoteling as a distinct product flow.** The schema supports `reservation_type='desk'`, but the desk-specific UX (floor plan picker, neighborhood booking, hot-desk recurrence) is a separate module on top of sub-project 1.

## Today's deliverable

Brainstorm and spec **sub-project 1 (Rooms foundation)** end-to-end. That spec lands as `docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md` and feeds writing-plans. Sub-projects 2–5 are brainstormed in their own sessions.
