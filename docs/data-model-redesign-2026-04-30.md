# Data model redesign — request, booking, fulfillment

**Date:** 2026-04-30
**Status:** Recommendation, not committed. Codex-reviewed.
**Audience:** Engineering + product, anyone touching tickets / booking_bundles / reservations / orders.

---

## Why this exists

The current request/booking model evolved in slices. It works, but it has known shape problems:

- `tickets` is overloaded via `ticket_kind` — does double duty as cases (reactive requests) and work_orders (dispatched units).
- `booking_bundles` is the parent of bookings but its name doesn't match the vocabulary the UI uses ("booking").
- `reservations` and `asset_reservations` are parallel tables for the same primitive (a held slot on a bookable resource) with different conflict policies.
- `orders` and booking-origin `tickets(work_order)` carry parallel state for the same underlying "this service line needs to happen" event — kept in sync by hand.
- Routing has two admin UIs (`/admin/routing-rules` for cases, `/admin/service-routing` for booking services) sharing a resolver under the hood.
- Activity timeline is `tickets`-only; once we extract work_orders the audit history fragments.

This doc is the recommended target shape and the migration path to get there. **It is not greenfield ambition** — it's a sequence of surgical refactors over an 18-month horizon. Skip it and the current pain compounds; rewrite it all at once and we waste a year.

This doc was pressure-tested by codex against the current repo on 2026-04-30. Codex disagreed with two pieces of the original recommendation; both have been folded in. The disagreement record is at the bottom.

---

## Target model — three first-class entities

```
case            ← reactive request lifecycle (incident, service request, problem, change)
booking         ← proactive time-bound parent (replaces booking_bundles)
work_order      ← operational dispatch unit (parent: case OR booking line)
```

Plus:

```
resources       ← unified catalog (rooms, desks, assets, parking) — one table
activities      ← polymorphic timeline (entity_kind, entity_id) — replaces ticket_activities
approval_chains ← polymorphic approvals (entity_kind, entity_id) — already half-built today
```

### A. `case` — reactive request lifecycle

Today's `tickets` rows where `ticket_kind = 'case'`.

- Lifecycle: open → in_progress → resolved → closed.
- Has SLA (response + resolution clocks), routing decision, watchers, requester, approval chain.
- Spawns 0..N work_orders.
- Visibility: `case_visibility_ids(user_id, tenant_id)` — descendant of today's `ticket_visibility_ids`.

### B. `booking` — proactive time-bound parent

Replaces `booking_bundles`. The naming change is deliberate: every UI surface in the app already says "booking" (BookingComposer, me-bookings, booking-detail). The schema catches up.

Lines fan out per kind:

```
booking
  ├─ booking_room_reservations    ← rooms (kind on resources = 'room' | 'desk')
  ├─ booking_asset_reservations   ← assets, parking (kind on resources = 'asset' | 'parking')
  ├─ booking_services             ← service lines (replaces orders for booking-attached services)
  ├─ booking_visitors             ← visitor lines (moves up from reservation_visitors)
  └─ booking_work_orders (FK link to work_orders)
```

A degenerate "single room booking" is just a booking with one room reservation and zero services / visitors.

Visibility: `booking_visibility_ids(user_id, tenant_id)` — descendant of today's `reservation_visibility_ids`.

### C. `work_order` — operational dispatch unit

Today's `tickets` rows where `ticket_kind = 'work_order'`. Pulled out into its own table.

- Polymorphic parent: `(parent_kind, parent_id)` where `parent_kind ∈ { 'case', 'booking_service', 'booking_room_reservation' }`.
- One assignee (user, team, or vendor).
- One SLA timer.
- One status machine (assigned → in_progress → completed | cancelled).
- One read path for every fulfillment surface: daglijst, vendor portal, KDS, internal facilities team, field tech mobile.

Visibility: `work_order_visibility_ids(user_id, tenant_id)` — distinct because booking-origin work orders deliberately strip requester semantics (current behavior: `apps/api/src/modules/ticket/ticket.service.ts:1574`).

### Sidecars (polymorphic, shared across all three)

```
activities      (entity_kind, entity_id, actor_id, kind, payload, created_at)
approval_chains (entity_kind, entity_id, policy_id, state, …)
approval_steps  (chain_id, step_no, approver_resolution, decision, decided_at)
```

`activities` is the most important new concept and was missed in the original recommendation. Without it, extracting `work_orders` fragments the audit timeline and every UI that shows history has to UNION across tables.

---

## What we are NOT doing

These were tempting and rejected for concrete reasons.

### Not unifying `case` and `booking` into one `request` parent

The case for unification: shared audit, approvals, comments, "things I asked for" API.

Why we don't:
- Approvals are already a generic sidecar (`00012_approvals.sql:3`) — they don't need shared parents.
- Cases own SLA / workflow / assignee / watchers (`00011_tickets.sql:3`).
- Bookings own calendar / recurrence / check-in / attendees / buffers / conflict windows (`00122_reservations_room_booking_columns.sql:19`).
- A single parent would become a nullable supertable with incoherent status transitions. The win (one routing entry point) is achievable via a shared resolver service operating on either parent kind, which is what we already have.

### Not collapsing `orders` into `work_orders`

The original recommendation said this; codex pushed back hard and was right.

Why they stay separate (FK-linked, not merged):
- Orders carry **commerce semantics**: delivery location/date/time, headcount, dietary notes, total estimate, recurrence rules, requested-for, status (`00013_orders_catalog.sql:43`, `00144_orders_bundle_columns.sql:4`).
- Work orders carry **dispatch semantics**: assignee, scheduled_for, SLA, internal notes.
- The lifecycles are different (cart → submitted → confirmed → delivered vs assigned → in_progress → completed).
- The codebase already chose this answer: `fulfillment_units_v` (`00186_fulfillment_units_view.sql`) is an explicit read-only projection that keeps order lines and work-order tickets separate. Shared projection, not forced identity.

The clean model: an order line that requires internal setup gets a `linked_work_order_id`. Two tables, one FK.

### Not unifying conflict guards across rooms and assets

Rooms use buffered effective windows + block `confirmed | checked_in | pending_approval` (`00123_reservations_conflict_guard.sql`). Assets use raw start/end ranges + only block `confirmed` (`00142_asset_reservations.sql`). Recurring orders skip-on-conflict for assets but fail-on-conflict for rooms (`apps/api/src/modules/orders/order.service.ts:113`).

Unified `resources` catalog is fine. **Unified conflict guard is not.** Per-kind booking-line tables retain their own conflict policies.

### Not unifying status enums

Case status, booking status, room reservation status, asset reservation status, service line fulfillment status, work order dispatch status — these are related but not the same state machine. Forcing one enum would be worse than today's mess.

If we want a single chip in admin UIs, derive a rolled-up status in a view. Don't collapse the underlying enums.

### Not unifying visibility into one SQL function

Three sibling functions:

```
case_visibility_ids       (user_id, tenant_id)
booking_visibility_ids    (user_id, tenant_id)
work_order_visibility_ids (user_id, tenant_id)
```

Predicates differ enough that one function would have to branch internally and RLS performance dies on branchy SQL.

What they share is **helpers**, not predicates: extract `expand_space_closure(...)` and `user_has_permission(...)` as the two shared SQL primitives. Each entity's visibility function calls them. The shape is already in the repo — discipline not to inline-copy them.

### Not turning routing into an opaque JSON blob

The codebase is already half-policy-document: `policy-store.service.ts:117` is config-versioned, `policy-validators.ts:50` has zod, `routing-evaluator.service.ts:42` separates `case_owner` from `child_dispatch` hooks.

What's NOT changing: the admin UI stays a row-edited rule grid with diff / publish / rollback / **simulator**. The simulator (paste a payload, see which rule wins, see the trace) is essential — without it, admins can't safely edit rules and config bugs only appear in production.

What IS changing: the storage migrates to versioned policy docs. Internal storage is a doc; user-facing UX stays row-edited.

Active consistency bug to fix on the way: `routing-evaluator.service.ts:399` still collapses multi-plan v2 dispatch back to a single legacy `ResolverDecision`. The runtime isn't fully policy-native yet — fix this before declaring routing migration complete.

---

## Migration sequence (18 months, surgical)

This is ordered by dependency, not by importance. Each step ships independently and leaves the system in a consistent state.

### Status as of 2026-04-30 evening

| Step | What | Status | Migrations / Commits |
|---|---|---|---|
| 0 | activities polymorphic sidecar + hardening | ✓ shipped, codex-reviewed | 00202, 00203 / 34ffe59 |
| 1a | cases + work_orders views over tickets, activity entity_kind migration, codex fixes | ✓ shipped, codex-reviewed | 00204, 00205, 00208 / 34ffe59, 438bb8f |
| 1b | reader cutovers to `work_orders` view: vendor portal, fulfillment_units_v, booking_bundle_status_v | ✓ shipped, self-reviewed (codex unavailable) | 865934e, a5cbbd2, 3c3b231, dc92d65, migrations 00209, 00210 |
| 1c | writers cutover (dispatch, workflow engine, SLA, routing_decisions FK migration); materialize work_orders as a real table | ⏸ NOT STARTED — needs codex review of plan first; 8 known coupling points; 3–6 mo of work |
| 2 | `orders` → `service_orders` rename + FK-link to work_orders | ⏸ deferred — needs step 1c done so `linked_setup_ticket_id` → `linked_work_order_id` makes sense |
| 3 | unified `resources` catalog | ⏸ deferred |
| 4 | `booking_bundles` → `bookings` rename | ⏸ deferred — pure cosmetic if done before line tables stabilize |
| 5 | promote `reservation_visitors` → `booking_visitors` | ⏸ blocked — visitors backend is a parallel in-flight workstream (per `project_visitors_track_split_off` memory). Don't touch. |
| 6 | rename `tickets` → `cases` | ⏸ blocked on step 1c |

Self-review caveats on what shipped without codex:
- Step 1b vendor portal cutover initially dropped the cross-tenant vendor JOIN from 00191; restored in `a5cbbd2`. This is the kind of subtle regression codex would have caught — self-review only caught it because I went looking. Same caution applies to all remaining work.

### Step 0 — `activities` polymorphic sidecar

**Before any extraction.** Without this, step 1 fragments the timeline immediately.

- Create `activities (entity_kind, entity_id, actor_id, kind, payload, created_at)`.
- Backfill from `ticket_activities`.
- New writes go to both for one release; then ticket_activities becomes a view over activities for compatibility.

Risk: low. Pure additive.

### Step 1 — extract `work_orders` from `tickets`

Biggest payoff. Single read path for every fulfillment surface.

Coupling points to address (each cited from current code):

| Coupling | Where |
|---|---|
| Dispatch creates child work orders as `tickets` rows | `apps/api/src/modules/ticket/dispatch.service.ts:79` |
| Booking-origin work orders inserted with no requester (portal-leakage guard) | `apps/api/src/modules/ticket/ticket.service.ts:1499` |
| Parent/child rollup trigger over `ticket_kind` | `supabase/migrations/00030_case_workorder_and_scope_hierarchy.sql:89` |
| SLA timers FK to `tickets` | `supabase/migrations/00011_tickets.sql:89`, `apps/api/src/modules/sla/sla.service.ts:25` |
| Workflow nodes mutate tickets | `apps/api/src/modules/workflow/workflow-engine.service.ts:74,147` |
| `create_child_tasks` calls `DispatchService.dispatch(ticketId, …)` | `apps/api/src/modules/workflow/workflow-engine.service.ts:213` |
| `routing_decisions` FK to tickets | `supabase/migrations/00027_routing_foundation.sql:56`, `apps/api/src/modules/routing/routing.service.ts:60` |
| Ticket listing has `ticket_kind`, parent_ticket_id, booking-origin filters | `apps/api/src/modules/ticket/ticket.service.ts:230` |

Approach: dual-write for one release, then flip reads, then drop the work_order rows from `tickets`. Polymorphic SLA/routing/activity tables (entity_kind, entity_id) absorb the cross-cutting concerns.

Estimate: 3–6 months including dual-write + cutover + cleanup.

Risk: high. This is the riskiest step. Codex was right that the original recommendation under-priced it.

### Step 2 — refactor `orders` into `service_orders` / `booking_services`

Not "collapse into work_orders." Rename + clarify + FK-link to work_orders where execution exists.

- `orders` → `service_orders` (clearer name, matches "I ordered catering").
- `order_line_items` → `service_order_lines` (or split into `booking_services` for booking-attached and `case_services` for case-attached, depending on coupling).
- Keep all commerce semantics (delivery location, headcount, dietary, price, recurrence).
- `linked_setup_ticket_id` → `linked_work_order_id`.
- Cross-system reporting continues through `fulfillment_units_v`.

Risk: medium. Schema rename + frontend renames; no semantics change.

### Step 3 — unified `resources` catalog (NOT unified conflict guard)

- New `resources (id, kind, capacity, calendar_id, …)` table — one row per bookable thing.
- Migrate `rooms`, `desks`, `assets` definitions into `resources`.
- Per-kind booking-line tables (`booking_room_reservations`, `booking_asset_reservations`) keep their own conflict guards.
- One Outlook/Google sync layer reads from `resources`.

Risk: medium. Catalog migration is mechanical; the win is operational (one place to manage bookable inventory).

### Step 4 — rename `booking_bundles` → `bookings`

Only after lines (step 1+2) are stable. Smaller cognitive jump than the original "booking_bundles → reservation" — matches existing UI vocabulary already.

- Rename table + FK columns + RLS predicates.
- `booking_bundle_status_v` → `booking_status_v`.

Risk: low to medium. Pure naming, but touches every reference.

### Step 5 — promote `reservation_visitors` → `booking_visitors`

Today visitors hang off a single `reservation` row, which is awkward for multi-room events. Move them up to the booking parent.

Risk: low. Small table, contained migration.

### Step 6 — rename `tickets` → `cases` (last)

After step 1, `tickets` is just cases. The rename is mostly cosmetic at this point.

Risk: low. The hard part was step 1.

---

## What we keep exactly as-is

These are good design and don't need changing:

- The four-axis routing model (routing / ownership / execution / visibility). Orthogonal for a reason.
- Per-tenant RLS via Supabase. Don't get clever.
- ResolverService trace-everything approach. The `routing_decisions` audit trail is load-bearing for incident debugging.
- Polymorphic approvals via `(entity_kind, entity_id)`. Already half-shipped.
- `fulfillment_units_v` as the cross-system reporting projection.

---

## Open questions before committing

1. **Should `booking_room_reservations` and `booking_asset_reservations` be one table or two?** Conflict guards differ; line metadata also differs (asset has `service_window`, room has `effective_start/end` with buffers). Codex says two tables with a unified `resources` catalog is the safer call. Verify by walking through whether unified-table-with-discriminator could actually share enough RLS / index / trigger code to be worth it.
2. **`activities` adoption order — does workflow_instance_events fold in?** Today there's `workflow_instance_events`, `routing_decisions`, `ticket_activities`, plus implicit "audit by joining tables." Do we promote all of these to `activities` or only `ticket_activities`?
3. **`approval_chains` already exists in some form — what's the actual delta?** `approval-routing.service.ts:9` already takes mixed entity ids. Audit the current state vs the target before committing to a "new" approval_chains table.
4. **Naming of `booking_services` vs keeping `service_orders`.** "Booking services" reads cleaner if all services are booking-attached. But cases also order services (a service request that says "send me a new laptop"). If both, we need either two tables or one table with a polymorphic parent.

---

## Codex disagreement record

For audit. Codex reviewed the original recommendation 2026-04-30. Disagreement record:

| Item | Original recommendation | Codex position | Final |
|---|---|---|---|
| Case vs booking unified | Keep separate | Keep separate (agreed, added evidence) | Keep separate |
| Extract `work_order` from `tickets` | Yes, ~3 months | Yes but cost is 3–6 months, list of 8 coupling points | Yes, 3–6 months |
| Collapse `orders` into `work_orders` | Yes, two views over one row | **No, separate tables FK-linked. Repo already chose this via `fulfillment_units_v`.** | Separate, FK-linked |
| Unify reservations + asset_reservations | Yes including conflict guard | Catalog yes, conflict guard no | Catalog yes, conflict guard no |
| Routing as policy doc | Yes | Yes for storage; UI must stay row-edited; need simulator | Yes for storage; row-edited UI; simulator required |
| Three visibility functions | Yes | Yes (agreed, added evidence) | Yes |
| Sequencing | WO → orders→WO collapse → resources → rename | activities → WO → service_orders refactor → resources → rename booking → rename ticket | Codex sequence adopted |
| Activities timeline | Not mentioned | **Critical gap** — extract WO without polymorphic activities and audit fragments | Step 0 of migration |
| Status enum unification | Not proposed | Don't even consider it | Not unified |
| Approval entity-reference scheme | Implicit | Must land before any rename | Explicit prerequisite |

The original recommendation got the structural shape right (3 entities, line tables, polymorphic WO parent, three visibility fns). The two real updates: orders stay separate; activities sidecar is step 0.

---

## Naming decision: booking, not reservation

The original recommendation said "rename booking_bundles → reservation, with reservation_*_lines for children." On reflection (with the user pushing back on the name): **booking** is the right name for the parent.

Why:
- Every UI surface already says booking (BookingComposer, me-bookings, booking-detail). The data layer should match.
- The vocabulary composes cleanly: "I made a **booking** that holds **reservations** on a room and a parking spot, plus **services** and **visitors**." The reverse ("a reservation that holds bookings") is wrong English.
- Modern competitors (deskbird, Robin, Skedda, OfficeRnD, Microsoft Bookings) use booking. Legacy FM (Planon, Eptura) use reservation — and we are explicitly not anchoring to legacy.
- Users *book* meetings; they don't *reserve* meetings. (Restaurants reserve. Offices book.)
- It frees `reservations` to mean the precise thing — a held slot on a calendar resource — instead of doing double duty as both the slot AND the room booking.

So:
- Parent: `bookings` (renamed from `booking_bundles`)
- Children: `booking_room_reservations`, `booking_asset_reservations`, `booking_services`, `booking_visitors`, `booking_work_orders` (FK)

Cases continue to be cases. Reservations remain a child-line concept inside bookings.
