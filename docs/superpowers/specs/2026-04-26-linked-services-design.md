# Sub-project 2 — Linked Services on a Booking — Design

Date: 2026-04-26
Status: design approved; awaiting writing-plans
Sub-project: 2 of the room-booking decomposition
Depends on: sub-project 1 (rooms foundation, shipped on main)
Defers to: 2.5 (parking) · 3 (visitors) · 4 (reception/host workspaces) · 5 (notifications + workflows + calendar)

Related docs:
- [Decomposition](./2026-04-25-room-booking-module-decomposition.md)
- [Sub-project 1 spec](./2026-04-25-room-booking-foundation-design.md)
- [Operational reference](../../room-booking.md)
- [Workplace blueprint](../../workplace-booking-and-visitor-blueprint-2026-04-21.md)
- [Parking scope (deferred)](./2026-04-26-parking-subsystem-scope.md)

## 1 · Why this exists

A booked room is rarely the whole event. Real workplace flows attach catering, AV/equipment, and room setup to that room. Today the project ships:

- A solid room-booking module (sub-project 1, on main).
- An orders + catalog schema (migration 00013) with no API.
- A vendor + menu schema (migration 00023) with the catering resolver already in SQL.
- A `tickets.ticket_kind ∈ ('case','work_order')` discriminator (migration 00030).
- A `reservations.booking_bundle_id` column waiting for a parent table (sub-project 1 left it unused).

Sub-project 2 wires those existing pieces together into a single user-facing flow, fills the small schema gaps that block end-to-end use, and ships the surfaces that turn it from "tables sitting in the DB" into a product that beats Robin/Envoy/Eptura on physical-asset conflict prevention, vendor-menu fidelity, composite booking templates, and GL-grade cost capture.

In scope: catering, AV/equipment, room setup, standalone orders, bundle templates, cost-center routing, asset conflict guard.

Out of scope (each routed to a clear home):
- **Parking** → sub-project 2.5
- **Visitors** → sub-project 3
- **Reception / host workspaces** → sub-project 4
- **Workflow templates as multi-step processes** → sub-project 5
- **Vendor portal** → new sub-project 6
- **Multi-currency + tax** → standalone infra slice
- **Floor-plan service placement** → sub-project 4 / floor-plan-editor
- **Vendor performance reporting** → sub-project 5

## 2 · Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Scope: catering + AV/equipment + room setup. | Three add-ons that map cleanly onto orders + line items + work orders. |
| 2 | Reuse existing `tickets.ticket_kind='work_order'` for execution rows. | One inbox for fulfillment teams; no parallel discriminator. |
| 3 | `booking_bundles` is created lazily on first service attach, becomes canonical edit/cancel context once present. | Room-only bookings stay simple; composite events get the orchestration parent they need. |
| 4 | UX: inline expandable Catering / AV / Setup sections in the existing booking-confirm dialog. | Single submit, single confirmation; matches blueprint UX flow. |
| 5 | Service rules clone room-booking-rules' shape. Predicate engine (`PredicateEngineService`) is shared; the resolver and context are separate (`ServiceRuleResolverService` + `ServiceEvaluationContext`). | Don't force services through reservation-shaped `BookingScenario`. |
| 6 | Smart approval dedup: one approval row per resolved approver, with `approvals.scope_breakdown jsonb` capturing every entity it covers. DB-enforced via unique partial index `(target_entity_id, approver_person_id) WHERE status='pending'`. | Approvers see consolidated decisions ("approve all + per-line reject") without duplicate work. |
| 7 | Recurrence: services attached to a recurring reservation propagate per occurrence. User picks per-service at booking which repeat (catering yes, one-off setup no). Per-occurrence `recurrence_overridden` allowed. Standalone-order recurrence deferred — orders inherit reservation series. Generalising `recurrence_series` is sub-project 2.5+ work. | Match user intent without forcing schema generalisation now. |
| 8 | Cancellation cascade: smart default with opt-out checkboxes. Fulfilled lines protected. Per-line, per-reservation, per-bundle, and per-recurrence-scope entry points each with distinct semantics. | Common case is zero-friction; edge cases ("keep catering, cancel room") possible. |
| 9 | Cost: always show per-line + bundle total in the confirm dialog. Annualised total surfaced when recurrence is on. Approval thresholds compute against per-occurrence, not annualised. | Transparency without bottlenecking weekly recurring bookings on senior approvers. |
| 10 | Admin surface: `/admin/booking-services` (vendors, menus, items) + `/admin/booking-services/rules` + `/admin/cost-centers` + `/admin/bundle-templates`. All on `SettingsPageShell`. | Single mental model for "what's bookable as a service". |
| 11 | Vendor menus: extend `catalog_menus` (already shipped in 00023) with `fulfillment_team_id` so internal teams can own menus. `vendor_id` becomes nullable; XOR check with `fulfillment_team_id`. No new menu / menu-locations tables. | Reuse don't recreate. The banqueting-menu shape is already shipped. |
| 12 | Standalone orders: first-class `/portal/order` flow. Nullable bundle and reservation. `OrderService.create` handles both shapes. | Office parties, weekly snack delivery, equipment loans without rooms are real flows. |
| 13 | First-class asset conflict guard for services. New `asset_reservations` table with `tstzrange` GiST exclusion mirroring `reservations`. Two bookings can never reserve the same projector at overlapping times. | Best-in-class differentiator vs Robin/Envoy. |
| 14 | First-class bundle templates / package SKUs. New `bundle_templates` table with jsonb payload. Pre-fill the booking flow with one click. | Single largest UX differentiator. |
| 15 | First-class cost-center routing. New `cost_centers` lookup + `booking_bundles.cost_center_id`. Predicate engine resolves `cost_center.default_approver`. | FMIS-grade GL chargeback support. |
| 16 | Per-line scheduling. `order_line_items.service_window_*` defaults to NULL ("match parent reservation") and is set explicitly when overridden. Every consumer (booking dialog, work-order spawn, asset conflict guard, recurrence materialiser, cancellation logic) honours the per-line window when set. | Catering at 12:00 even when the room is booked all day — without making this a footnote. |
| 17 | Vendor capacity windows deferred. We don't yet know how vendors actually use the system — premature constraint. | Add after real adoption data. |
| 18 | Service status timeline reframed as audit history view, not real-time tracking promise. Reads from `audit_events` filtered by bundle scope. Useful day-1 even with zero vendor adoption. | Don't promise what we can't enforce vendor-side. |

## 3 · Architecture & schema

### 3.1 Reuse, don't recreate

These are already shipped:

- `vendors` — first-class external party (00023).
- `vendor_service_areas` — multi-building coverage with priority breaks (00023).
- `catalog_menus` — banqueting-menu shape, vendor-scoped, optionally space-scoped, date-bounded, with `status ∈ ('draft','published','archived')` (00023).
- `menu_items` — priced offering with day-of-week / time-of-day availability + per-line min/max quantity + lead time (00023).
- `resolve_menu_offer(catalog_item_id, delivery_space_id, on_date)` SQL function — picks the right menu+vendor+price (00023).
- `order_line_items.{vendor_id, menu_item_id}` — provenance snapshot (00023).
- `tickets.ticket_kind ∈ ('case','work_order')` — discriminator (00030); `parent_ticket_id` carries case → work-order linkage.
- `orders.linked_reservation_id` — direct link (00013).

### 3.2 Schema gap to close

`catalog_menus.vendor_id` is `NOT NULL`. Internal-team menus (office canteen, internal AV team) have no vendor. Smallest viable change:

```sql
alter table public.catalog_menus
  alter column vendor_id drop not null,
  add column fulfillment_team_id uuid references public.teams(id),
  add constraint catalog_menus_owner_xor
    check (num_nonnulls(vendor_id, fulfillment_team_id) = 1);
```

The resolver gains one branch: when `vendor_id IS NULL`, skip the `vendor_service_areas` join and use `catalog_menus.space_id` alone for spatial scoping. `catalog_menus.space_id IS NULL` continues to mean "applies to every location" (with the existing closure-expansion semantic) — internal-team menus that aren't location-scoped (e.g. tenant-wide canteen) leave both `space_id` and `vendor_id` resolution paths in their existing wildcard mode.

### 3.3 New tables

```
booking_bundles
  id, tenant_id
  bundle_type            ('meeting'|'event'|'desk_day'|'parking'|'hospitality'|'other')
  requester_person_id, host_person_id
  primary_reservation_id (nullable — always set in sub-project 2 because every bundle is created on first-service-attach to a reservation; nullable for sub-project 3+ visitor-only / hospitality-only bundles)
  location_id            (NOT NULL — visibility anchor; from primary reservation OR first delivery_location_id)
  start_at, end_at, timezone
  source                 ('portal'|'desk'|'api'|'calendar_sync'|'reception')
  cost_center_id         (nullable FK)
  template_id            (nullable FK to bundle_templates)
  -- Calendar sync columns for services-only bundles:
  calendar_event_id, calendar_provider, calendar_etag, calendar_last_synced_at
  -- status_rollup is NOT a column. Computed lazily via booking_bundle_status_v.
  created_at, updated_at

service_rules
  id, tenant_id, name, description
  target_kind            ('catalog_item' | 'menu' | 'catalog_category' | 'tenant')
  target_id              (FK appropriate to target_kind, nullable for 'tenant')
  applies_when           jsonb (predicate AST; same engine as room rules)
  effect                 ('deny' | 'require_approval' | 'allow_override' | 'warn' | 'allow')
  approval_config        jsonb (approver_target = role | person | derived; thresholds; SLA)
  denial_message
  priority, active
  template_id            (nullable)

service_rule_versions
service_rule_simulation_scenarios
service_rule_templates    -- mirrors room_booking_rule_templates; seeded with 7 v1 templates

asset_reservations
  id, tenant_id, asset_id (FK to assets)
  start_at, end_at
  time_range tstzrange GENERATED ALWAYS AS tstzrange(start_at, end_at, '[)') STORED
  status                 ('confirmed' | 'cancelled' | 'released')
  requester_person_id, linked_order_line_item_id (FK), booking_bundle_id (FK nullable)
  created_at, updated_at
  exclude using gist (asset_id with =, time_range with &&) where (status = 'confirmed')

bundle_templates
  id, tenant_id, name, description, icon, active
  payload jsonb (room_criteria, default_duration_minutes, services[], default_cost_center_id)
  created_at, updated_at

cost_centers
  id, tenant_id, code (unique per tenant), name, description
  default_approver_person_id (FK)
  active
  created_at, updated_at

booking_bundle_status_v   -- VIEW
  -- joins reservations + orders + tickets where booking_bundle_id matches,
  -- returns status_rollup as derived enum:
  --   'pending_approval' | 'confirmed' | 'partially_cancelled' | 'cancelled' | 'completed'
```

### 3.4 Column additions

| Table | Column | Notes |
|---|---|---|
| reservations | (FK only) | `add foreign key (booking_bundle_id) references booking_bundles(id)` |
| orders | `booking_bundle_id` (nullable, FK) | Coexists with `linked_reservation_id`; bundle is canonical when set |
| orders | `requested_for_start_at`, `requested_for_end_at`, `policy_snapshot jsonb` | Standalone orders use these as the service window |
| orders | `recurrence_series_id` (nullable, FK) | Materialiser finds linked orders by series |
| orders | `recurrence_rule jsonb` (nullable) | Captured for future standalone-recurrence (sub-project 2.5+) |
| order_line_items | `linked_ticket_id` (nullable, FK) | Cart-state ↔ execution-event link |
| order_line_items | `service_window_start_at`, `service_window_end_at` | Per-line window override |
| order_line_items | `policy_snapshot jsonb` | Snapshot the matched service rule + name fallback |
| order_line_items | `recurrence_overridden boolean default false` | Per-occurrence override flag |
| order_line_items | `recurrence_skipped boolean default false` + `skip_reason text` | Per-occurrence skip |
| order_line_items | `repeats_with_series boolean default true` | Per-line "this repeats with the meeting" toggle (decision 7). When false, the materialiser does NOT clone this line for future occurrences — used for one-off setup that only the master needs |
| order_line_items | `linked_asset_reservation_id` (nullable, FK) | Connects line to its asset_reservations row |
| tickets | `booking_bundle_id` (nullable, FK), `linked_order_line_item_id` (nullable, FK) | NO `kind` column — `ticket_kind` already exists |
| approvals | `scope_breakdown jsonb` | Multi-entity coverage |
| approvals | unique partial idx `(target_entity_id, approver_person_id) where status='pending'` | DB-enforces dedup |
| catalog_menus | `fulfillment_team_id` + nullable `vendor_id` + XOR check | Internal-team menus |

### 3.5 Module boundaries (Nest)

- **`BookingBundlesModule`** — owns `booking_bundles` + `BundleVisibilityService` + cascade orchestration. Status rollup is a view (`booking_bundle_status_v`), so there is no recompute path; reads compute on the fly. **Visibility tiers, in order of precedence:**
  1. **Participant** — `requester_person_id`, `host_person_id`, anyone in `scope_breakdown.approver_person_id`s for any approval row, or any `assignee_user_id` of a linked work-order ticket. Sees full bundle.
  2. **Operator** — anyone with `rooms.read_all` permission whose location-grant covers `bundle.location_id` (closure-expanded). Sees full bundle including denied/restricted services.
  3. **Admin** — anyone with `rooms.admin`. Sees everything tenant-wide.
  Otherwise hidden. Sub-project 4 (reception) consumes this same service.
- **`ServiceCatalogModule`** — owns `service_rules` + `ServiceRuleResolverService` + `ServiceEvaluationContext`. Uses shared `PredicateEngineService`. Existing `vendors` / `catalog_menus` / `menu_items` admin folds in here.
- **`OrdersModule`** — wraps `orders` + `order_line_items` + `asset_reservations`. Includes a `spawnWorkOrder()` helper that calls `TicketService.create({ ticket_kind: 'work_order', sla_id: null, parent_ticket_id: null, booking_bundle_id, linked_order_line_item_id })`. **No separate `WorkOrdersModule`.**
- **`BundleTemplatesModule`** — admin CRUD over `bundle_templates`.
- **`CostCentersModule`** — admin CRUD over `cost_centers`.
- **`RecurrenceService`** — unchanged signature; the materialiser hook gains a "fan out to linked orders" step that delegates to `OrdersModule.cloneOrderForOccurrence(orderId, newReservationId)`.

`BookingFlowService` gains one dependency on `BookingBundlesModule` for the lazy create-on-attach hook.

### 3.6 Cross-cutting

- **RLS** — every new table gets `tenant_isolation` policy via `current_tenant_id()`.
- **Audit events** — `bundle.created`, `bundle.cancelled`, `bundle.partially_cancelled`, `bundle.recurrence_split`, `bundle.recurrence_cancel_forward`, `service_rule.{created,updated,deleted}`, `order.created`, `order.cancelled`, `order.line_added`, `order.line_cancelled`, `order.line_overridden`, `asset_reservation.{created,cancelled}`, `approval.dedup_merged` (when an additional rule joins an existing approval row). Best-effort try/catch.
- **Realtime channels** — `booking_bundles:tenant_<id>:requester_<id>`, `booking_bundles:tenant_<id>:host_<id>`, `booking_bundles:tenant_<id>:approver_<id>` (so an approver gets live updates when a peer in the same role decides), `booking_bundles:tenant_<id>:operator_<location>` (sub-project 4 will consume). Mirrors reservation pattern.
- **Calendar sync** — when a bundle has a reservation, the reservation's `calendar_event_id` is canonical; bundle's is null. Services-only bundles own the calendar event, written to the **requester's** calendar by default (host's calendar when `host_person_id` is set and differs from requester). `OutlookSyncAdapter.toGraphEventPayload` extends to read bundle services and append a "Catering / AV / Setup" block to the description.
- **Notifications** — `bundle_pending_approval`, `bundle_confirmed`, `bundle_cancelled`, `service_at_risk` (lead time about to expire).
- **Work-order SLA suppression** — `OrdersModule.spawnWorkOrder` always passes `sla_id: null`.

## 4 · Booking flow + standalone orders + approval routing

### 4.1 Composite booking flow (room + services)

The existing portal picker (`/portal/rooms`) and confirm dialog stay as the primary entry point. The dialog already hosts a Recurrence section; three new collapsed sections appear alongside it — Catering / AV / Setup — each rendered only when at least one menu/item is available for the booking's location + time + requester. Final dialog has up to four collapsed sections (Catering · AV · Setup · Recurrence) plus the always-visible header (When · Room · Attendees) and footer (cost roll-up + actions).

Per-section UX:
- Menu picker (auto-selected when one menu, picker when multiple).
- Item rows from `menu_items` with quantity, lead-time hint, dietary tags.
- Per-line "when" picker defaulted to the reservation window with override.
- Per-line cost (or "—" when `price` is null) updating the bundle total live.
- Service rule outcome chip when a rule fires (deny / require_approval / warn).

Submit is atomic via extended POST `/reservations`:

1. `BookingFlowService.create` runs the room pipeline.
2. If `payload.services` present, `BundleService.attachServicesToReservation(reservation_id, services)`:
   - Creates bundle + sets `primary_reservation_id`, `cost_center_id`, `template_id`.
   - Creates orders + line items, snapshotting menu+vendor+item via `resolve_menu_offer`.
   - Creates `asset_reservations` per line where `linked_asset_id` set (conflict guard fires on overlap).
   - Spawns work-order tickets via `OrdersModule.spawnWorkOrder`.
   - `ServiceRuleResolverService.resolveBulk` returns per-line outcomes.
   - `ApprovalRoutingService.assemble` runs dedup + creates approvals with `scope_breakdown`.
3. Single Postgres transaction. Asset conflict → 409 with conflicting asset + alternatives, full rollback.

### 4.2 Standalone-order flow

`/portal/order` — top-level page with a single form (no wizard):

1. Where (location picker — required).
2. When (date + time window).
3. Order (menu picker → items → quantity → per-line window).
4. Cost center. **Recurrence toggle is disabled in v1** with an inline hint "Recurring standalone orders coming soon". The `orders.recurrence_rule` column ships now (forward-compat) but the form doesn't write to it. Lights up automatically when sub-project 2.5 generalises the recurrence engine — no schema migration needed at that point. This avoids the "user thought weekly snacks were scheduled but they only happened once" trap.

Backend: `POST /orders/standalone` in `OrdersModule`. Same code path as composite — branching only on "no reservation, use the order's `requested_for_*` window for line defaults".

Predicate engine: rules referencing `booking.*` evaluate as no-match when reservation is absent (engine's path resolver returns null/false on undefined paths — verified, not assumed).

### 4.3 Service rule resolution

```
ServiceRuleResolverService.resolveBulk(
  lines: Array<{ catalog_item_id, menu_id, quantity, service_window_*, ... }>,
  context: ServiceEvaluationContext  // requester, cost_center, reservation if any
): Map<line_id, RuleOutcome>
```

Calls `PredicateEngineService.evaluate(predicate, context)` against rules where `target_kind` matches the line (item / item's category / item's menu / tenant). Specificity sort: `catalog_item` > `menu` > `catalog_category` > `tenant`.

### 4.4 Approval assembly + dedup

```
1. Collect every matched rule across the room pipeline + all service lines.
2. For each rule with effect ∈ ('require_approval', 'allow_override'):
   a. Resolve approver_target → concrete {kind, id} pair:
      - 'person', personId
      - 'role', roleId         → list of role members; **first-approver-wins**
                                  (any member can approve; their decision
                                  closes the row for the rest). All-of-N
                                  approval is sub-project 5+ work.
      - 'derived', expr        → evaluate (e.g. requester.manager,
                                  cost_center.default_approver,
                                  menu.fulfillment_team_lead)
   b. Capture the entity ids the rule covered.
3. Group by approver_id. For each, build one approval row:
   - target_entity_type='booking_bundle' (or 'order' for standalone)
   - target_entity_id=bundle.id
   - approver_person_id
   - scope_breakdown jsonb = {
       reservation_ids, order_line_item_ids, ticket_ids,
       reasons: [{ rule_id, denial_message }]
     }
   - status='pending'
4. Upsert via application-layer merge (not raw `||`):
   - SELECT existing pending approval for (target_entity_id, approver_person_id) inside the bundle transaction.
   - If found: deep-merge new arrays into existing arrays in TypeScript (concat + dedupe per key), UPDATE the row.
   - If not found: INSERT.
   - The unique partial index `(target_entity_id, approver_person_id) WHERE status='pending'` is the safety net — concurrent inserts surface as `23505` and the second writer retries the upsert.
   - Why not raw `INSERT ... ON CONFLICT DO UPDATE SET scope_breakdown = scope_breakdown || EXCLUDED.scope_breakdown`? The jsonb `||` operator does shallow merge — `reservation_ids: [r1]` paired with `reservation_ids: [r2]` keeps only the EXCLUDED side (r2), losing r1. Application-layer merge is the only way to concat arrays per key.
```

Approver UI:
```
Approve booking — Sales kickoff Apr 30
  ✓ Meeting Room 2.12 · 09:00–11:00 · 14 attendees
  ✓ Catering: Continental breakfast for 14 · $420 · delivers 12:00
  ✓ AV: Projector setup
[ Approve all ]   [ Reject ]   [ Comment per item ]
```

Per-item reject splits the approval: approved entities → `confirmed`, rejected entities → `cancelled` with `cancellation_reason='approval_rejected'`. Bundle's status_rollup view then reports `partially_cancelled`.

### 4.5 Cost computation

`CostService.computeBundleCost(bundle_id) → { lines, total_per_occurrence, total_annualised? }`

- Per line — depends on `menu_items.unit`:
  - `'per_item'` → `unit_price × quantity`
  - `'per_person'` → `unit_price × (quantity_per_attendee ?? 1) × bundle.attendee_count`
  - `'flat_rate'` → `unit_price` (quantity is informational, doesn't multiply)
  - `unit_price` is snapshotted onto `order_line_items.unit_price` at create time so future menu repricing doesn't change historical totals.
- Bundle total: line totals + reservation `cost_amount_snapshot`.
- Annualised: when `bundle.recurrence_rule` set, multiply per-occurrence by `expandOccurrences(rule, 1y).count`.
- Null `unit_price` lines render as "—", contribute 0.
- Approval thresholds compute against per-occurrence (`$.order.total_per_occurrence`), not annualised.

### 4.6 Bundle templates

`bundle_templates.payload`:

```json
{
  "name": "Executive Lunch Package",
  "room_criteria": { "min_attendees": 6, "must_have_amenities": ["video"], "preferred_floor_id": "..." },
  "default_duration_minutes": 90,
  "services": [
    { "catalog_item_id": "...", "menu_id": "...", "quantity_per_attendee": 1,
      "service_window_offset_minutes": 30 },
    { "catalog_item_id": "...", "menu_id": "...", "quantity": 1,
      "service_window_offset_minutes": -30 }
  ],
  "default_cost_center_id": "..."
}
```

User picks a template from a new dropdown above the time picker on `/portal/rooms`. Form pre-fills with editable defaults. `quantity_per_attendee` lets templates say "1 lunch per attendee" without hardcoding. `service_window_offset_minutes` is signed minutes from `start_at` (negative = before the meeting).

**Recurrence + templates compose naturally.** Once the template hydrates the form, the recurrence toggle works exactly as for a manual booking. Each occurrence's catering window is recomputed by applying `service_window_offset_minutes` to that occurrence's `start_at` — so a "30 min after start" template item that lands on a 9am Monday becomes 9:30 catering on Monday and 9:30 next Monday, even if the user later shifts next Monday's reservation. **Manual per-occurrence overrides** (user picks an absolute time on Wednesday) detach that occurrence's line from the offset — subsequent occurrences keep using the offset, but the overridden Wednesday is now an absolute timestamp and won't track the meeting if it moves.

**Naming clarification.** "Service rule templates" (Section 6.1) and "bundle templates" (Section 4.6) are different. Service rule templates are predicate-engine starting points admins use to create approval / availability / blackout rules. Bundle templates are pre-filled composite booking shapes users pick from the dropdown.

## 5 · Recurrence + cancellation

### 5.1 Recurrence + services

Recurrence stays anchored on reservations. Orders inherit the reservation's series via `orders.recurrence_series_id`.

At bundle-create time when `recurrence_rule` is set:
- `recurrence_series` row created (existing path).
- Order rows reference master occurrence as parent.
- Line `service_window_*` are always stored as absolute timestamptz on each row (master and clones). The "offset" is computed at materialisation as `delta = master.line.service_window_start_at − master.reservation.start_at`, then applied: `clone.line.service_window_start_at = newReservation.start_at + delta`. No separate offset column. Template-derived lines pass `service_window_offset_minutes` through this same delta math at master-creation time, never as stored data.

At occurrence materialisation (`RecurrenceService.materialize`):

1. Load orders where `recurrence_series_id` = this series + `parent_reservation_id` = master.
2. For each order, `OrdersModule.cloneOrderForOccurrence(orderId, newReservationId, occurrenceStartAt)`:
   - Clone order row, line items, asset reservations (conflict guard fires here; per-occurrence asset conflict only blocks that occurrence — sets `recurrence_skipped=true` with `skip_reason='asset_conflict'`).
   - Spawn work-order tickets parented to the new reservation.
3. Service rules re-resolve against each occurrence's context. Rule outcomes can change per occurrence (e.g. holiday-specific deny on Dec 25).

### 5.2 Per-occurrence overrides + skip

User edits this Wednesday's catering quantity 14 → 20:
- `order_line_items.recurrence_overridden=true` for that occurrence's clone.
- Detaches from "follow the series" — future series-level edits don't override.
- Cancelling series-level catering only cancels future-non-overridden occurrences.
- UI shows "modified for this occurrence" badge with revert action.

User skips one occurrence's catering:
- `order_line_items.recurrence_skipped=true` for that occurrence's clone.
- Doesn't affect siblings.

### 5.3 Cancellation cascade

Three entry points, distinct semantics:

**Cancel one service line:**
- Affects only that line's order_line_item + spawned work-order ticket.
- Work-order → `closed` with `resolution='cancelled'`.
- `asset_reservations` → `cancelled`.
- Pending approvals — rebuild `scope_breakdown` for affected rows; if scope drops to empty, auto-close.

**Cancel the reservation:**
- Smart default cascade dialog: pre-checked list of every linked entity.
- User unchecks anything to preserve.
- Fulfilled lines (`fulfillment_status` past `'confirmed'`) appear greyed with "cannot cancel — already fulfilled".
- Bundle stays alive if non-fulfilled lines remain after cascade.

**Cancel the bundle:**
- Always full cascade. Bundle = "this whole event".
- Same fulfilled-line protection.
- Linked approvals → `cancelled` with comment "Bundle cancelled; voiding approval".

**Recurring scope cancel** (`this`, `this_and_following`, `series`):
- Reuses existing `RecurrenceService.cancelForward`.
- `scope='this'` — that occurrence's bundle + linked entities.
- `scope='this_and_following'` — every occurrence ≥ pivot; `series_end_at` capped.
- `scope='series'` — past + future.

### 5.4 Edit semantics

Edit the room: re-run `BookingFlowService.editOne` + re-resolve service rules against new context + recompute approvals + re-anchor asset reservations.

Edit a service line: `OrdersModule.editLine` — single-line scope; doesn't re-resolve room rules.

Edit at series scope: reuses the recurrence split-series mechanism.

### 5.5 Edge cases

| Case | Behaviour |
|---|---|
| Cancel reservation, catering already delivered | Catering line stays; bundle marked `partially_cancelled` |
| Asset conflict on occurrence #5 of a 12-week series | Occurrence #5 marked `recurrence_skipped` with `skip_reason='asset_conflict'`; user notified; siblings materialise normally |
| User edits this Wed's order then cancels series | This Wed (overridden) survives; future siblings cancel; user warned |
| Vendor archives a menu while bookings exist | Existing snapshots in `policy_snapshot` keep offering name + price visible in audit |
| Cost center deleted while bundles reference it | FK is `ON DELETE SET NULL`; bundles surface "Cost center deleted"; reports group as `cost_center_unknown` |
| Approver person deactivated mid-approval | Approval row stays open; admin surface flags "approver no longer active — reassign" |

## 6 · Surfaces

### 6.1 Admin

All on `SettingsPageShell`:

- **`/admin/booking-services`** (`xwide`) — index with Vendors / Menus / Items cards. Click-through to vendor / menu / item detail pages.
- **`/admin/booking-services/rules`** — mirror of `/admin/room-booking-rules`. Index + detail + template editor + simulation.
- **`/admin/cost-centers`** (`default`) — index + detail. Code, name, default approver. Bulk import.
- **`/admin/bundle-templates`** (`wide`) — index + detail with form-driven editor. Live preview pane shows how the template renders in the user's confirm dialog.

V1 service rule templates (seeded):

| Template | Effect |
|---|---|
| Per-item lead time | warn / require_approval |
| Cost threshold approval | require_approval |
| External-vendor approval | require_approval (when amount > threshold) |
| Cost-center owner approval | require_approval (derived approver = cost_center.default_approver) |
| Item availability blackout (e.g. "no catering on Mondays") | deny |
| Role-restricted item | deny |
| Min-attendee for item | warn |

### 6.2 Operator

**`/desk/bookings`** gets a sixth scope chip (Bundles), a "Bundle / Room" combined column, and a Services section in the row drawer:

```
Services
  ✓ Catering   Mary's Catering · Continental for 14   delivers 12:00   $420
                Approved by Sarah Lee · 2h ago
  ⏱ AV         Internal AV · Projector + screen        setup 8:30      —
                Pending: assigned to Carlos
  ✓ Setup      Facilities · U-shape layout              setup 8:00      —
  ─────────────
  Bundle total $420 · 1 weekly recurrence ($21,840 annualised)
```

Each line opens the corresponding ticket detail in a side panel.

**Fulfillment teams** use the existing `/desk/tickets` and `/desk/scheduler` filtered by `ticket_kind='work_order'`. New view preset: "Work orders". Row component shows a chip with vendor/team owner + service window.

### 6.3 Requester

**`/portal/me/bookings/:id`** gets a Services section + audit-history timeline (reads `audit_events` filtered by bundle scope). Renders whatever events have happened — system-generated at minimum, plus any vendor/operator updates that happen to flow in. No real-time tracking promise; "see everything we know, in order".

## 7 · Phasing (within sub-project 2)

Five sub-slices, dependency-driven:

**2A · Schema + module skeletons** (~3 days)
- All migrations land here; modules return 501. Tests verify migration + tables + RLS.

**2B · Predicate engine reuse + service rule resolver** (~4 days)
- `ServiceEvaluationContext` + `ServiceRuleResolverService`. Approval routing assemble + dedup. Rule template seeding. Concurrent-insert stress on dedup index.

**2C · Composite booking flow + bundle creation** (~5 days)
- `BundleService`, `OrdersModule` composite + standalone paths, asset reservation creation. End-to-end "book room + catering + AV + setup" tests.

**2D · Recurrence + cancellation** (~4 days)
- `cloneOrderForOccurrence`, per-occurrence override + skip, cascade dialog + cascade logic. 12-week series + mixed overrides + asset conflict tests.

**2E · Frontend surfaces** (~6 days)
- Confirm-dialog three sections, `/portal/order`, admin pages, operator drawer extension. Playwright happy paths.

Total: ~22 working days for one engineer, ~3 weeks calendar with two engineers (backend ∥ frontend after 2A).

## 8 · Migrations summary

```
00139  booking_bundles (without primary_reservation_id FK) + bundle_templates + cost_centers + service rule template seed table
00140  service_rules + service_rule_versions + service_rule_simulation_scenarios
00141  asset_reservations with GiST exclusion + per-line conflict guard helpers
00142  catalog_menus.fulfillment_team_id + vendor_id nullability + XOR check
00143  orders/order_line_items column additions
00144  tickets column additions (booking_bundle_id, linked_order_line_item_id)
00145  approvals.scope_breakdown + unique partial index
00146  reservations.booking_bundle_id FK constraint + booking_bundles.primary_reservation_id FK constraint (both added here together — the two tables FK-reference each other; Postgres allows the cycle but the FKs must land in a single migration so neither table is created with an unresolvable reference)
00147  booking_bundle_status_v view + bundle visibility helpers
00148  service rule template seed data
```

Each migration trailing `notify pgrst, 'reload schema'`. Every new table with `tenant_isolation` RLS policy.

## 9 · Testing posture

| Layer | Tests |
|---|---|
| Schema | Migration applies cleanly; idempotent re-run; FK constraints enforce; GiST exclusion catches concurrent asset bookings; unique partial index prevents approval duplicates |
| Service unit | Predicate evaluation against `ServiceEvaluationContext`; rule resolver specificity; approval dedup grouping; cost computation (per-occurrence vs annualised); cancellation cascade with fulfilled-line protection |
| Recurrence | Per-occurrence service materialisation; offset-vs-absolute window normalisation; per-occurrence override; skip; asset conflict on one occurrence doesn't block siblings |
| Integration | Full bundle create/edit/cancel pipeline; bundle template hydration; standalone order; multi-approver dedup with concurrent inserts |
| API e2e | POST /reservations with services payload; POST /orders/standalone; cascade cancel via DELETE /booking-bundles/:id; partial reject from approver |
| UI | Confirm-dialog three-section composition; per-line window picker default + override; cost roll-up live update; admin pages CRUD; Playwright happy path "book lunch + projector + setup, get one approval, see it on /desk/bookings, approver clicks approve all" |
| Concurrency | 1000 concurrent bundle creates against same room/asset window — exclusion constraints catch all races; 0 dual-bookings; structured 409 with alternatives every time. Concurrency suite folds into slice 2C (composite booking flow + asset reservations) since both ship together. |
| Migration safety | catalog_menus.vendor_id nullability + XOR check on remote with existing rows; tickets schema additions don't break existing routing/dispatch tests |

## 10 · Acceptance criteria (sub-project 2 v1 shippable)

1. Booking-confirm dialog atomically books room + N services. Conflict guard catches every duplicate asset booking under 1000-concurrent stress (0 dual-accepts).
2. Standalone `/portal/order` flow places non-room orders end-to-end (catering / AV-equipment / setup).
3. Smart approval dedup: when two rules route to the same approver, the approver sees ONE row with full scope. Approver clicks "Approve all" once. Per-line reject works.
4. Recurring weekly bookings materialise services per occurrence. Per-occurrence override + skip work. Annualised cost shown.
5. Cancellation cascade dialog shows pre-checked entities; user can opt out per line; fulfilled lines protected.
6. Five admin pages built per the SettingsPageShell pattern. Seven service rule templates configurable + simulatable.
7. Operator `/desk/bookings` shows Bundles scope, Services section in drawer, and clickable line → ticket detail.
8. Audit events: every lifecycle decision emits a `bundle.*` / `order.*` / `asset_reservation.*` event.
9. Bundle templates reduce a typical "Executive Lunch" booking to one click + minor edits.
10. Cost center routing: requester's primary cost center auto-fills on bundle create; reports group spend by cost center.

## 11 · Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Asset GiST exclusion contention under booking storms | Medium | Medium | Same pattern proved out for reservations under 1000-concurrent in sub-project 1; index covers status='confirmed' only |
| Vendor adoption stays low → service status timeline reads sparse | High | Low | Reframed as audit history (Section 4.6 + decision 18); useful day-1 with system events alone |
| Bundle template proliferation → admin clutter | Medium | Low | `active` flag + admin filter; usage analytics (count of bundles created from template) surfaces dead templates |
| Approval dedup index race under concurrent line additions | Medium | High | Application-layer merge inside the bundle transaction (Section 4.4); the unique partial index acts as the safety net — concurrent inserts surface as `23505`, the second writer retries the SELECT-merge-UPDATE path. Tests stress this explicitly. |
| `catalog_menus.vendor_id` relaxation breaks existing menu resolver | Low | High | Tested before remote push; resolver branch kept narrow ("when vendor_id IS NULL, skip vendor_service_areas join"); migration includes resolver function update in same transaction |
| Cost-center FK with ON DELETE SET NULL leaves orphan bundles | Low | Low | Reports already handle `cost_center_unknown`; admin tooling will surface affected bundles for re-tagging |

## 12 · What changes in `docs/room-booking.md` when this ships

The operational reference needs new sections (sub-project 2 trigger files added to the MANDATORY sync list):

- "Bundles + service flow" — the lazy-create rule, cascade entry points, dedup approval algorithm.
- "Service catalog" — vendor menus + templates + cost centers.
- "Asset reservations" — conflict guard parallel to rooms.
- "Audit events" table extended with `bundle.*` / `order.*` / `asset_reservation.*`.

Trigger files added: `apps/api/src/modules/booking-bundles/**`, `apps/api/src/modules/orders/**`, `apps/api/src/modules/service-catalog/**`, `apps/api/src/modules/bundle-templates/**`, `apps/api/src/modules/cost-centers/**`. Frontend: `apps/web/src/pages/portal/order/**`, `apps/web/src/pages/admin/booking-services/**`, `apps/web/src/pages/admin/cost-centers/**`, `apps/web/src/pages/admin/bundle-templates/**`.

## 13 · Performance, UX, design — best-in-class lens

The technical design above is necessary but not sufficient. Below is how the slice holds up against ServiceNow / Eptura / Robin / Envoy at their best — through the eyes of every persona that touches it.

### 13.1 Performance budgets (server)

| Surface | p50 | p95 | How |
|---|---|---|---|
| Booking-confirm "what services apply here" probe | < 80 ms | < 200 ms | Single SQL: `resolve_menu_offer` + service_rules in parallel. Fires only when the dialog opens, not on every keystroke. |
| Atomic bundle submit (room + 3 service lines + 2 work orders + 1 asset_reservation + approvals) | < 350 ms | < 800 ms | Single transaction; all writes pipelined. Picker re-run for alternatives only on conflict. |
| Standalone-order submit | < 250 ms | < 500 ms | Same path minus the room pipeline. |
| `/desk/bookings` Bundles scope, 200 rows + service preview | < 400 ms | < 900 ms | One round-trip joining bundles + reservations + a per-bundle "service summary" subquery. Covered by index `idx_orders_bundle` + `idx_tickets_bundle`. |
| Bundle detail drawer (room + services + audit timeline) | < 250 ms | < 600 ms | Three queries in parallel — bundle-with-status-view, services with provenance, audit_events filtered by bundle scope. |
| Admin `/admin/booking-services/rules` simulation against last 30 days | < 1.5 s | < 3 s | Reuses the room rules simulation infra; cached per (rule_id, scenario_id). |

Each PR touching these queries pastes EXPLAIN ANALYZE in the description. WARN-log threshold is 2× the p95 budget (matches Phase K convention).

### 13.2 Index hot paths

```
idx_orders_bundle           on orders (booking_bundle_id) where booking_bundle_id is not null
idx_orders_recurrence       on orders (recurrence_series_id) where recurrence_series_id is not null
idx_oli_bundle_via_order    -- accessed via orders.booking_bundle_id; explicit not needed
idx_oli_window              on order_line_items (service_window_start_at) where service_window_start_at is not null
idx_oli_recurrence_skipped  partial idx (occurrence-level skip lookup)
idx_tickets_bundle          on tickets (booking_bundle_id) where booking_bundle_id is not null
idx_tickets_kind_bundle     composite (ticket_kind, booking_bundle_id) for the operator "Work orders" preset
idx_asset_reservations_*    GiST on (asset_id, time_range) where status='confirmed' (the conflict guard itself)
idx_approvals_pending       unique partial on (target_entity_id, approver_person_id) where status='pending' (dedup safety net)
idx_bundles_location        on booking_bundles (location_id) (for visibility filter)
idx_bundles_status_search   on booking_bundles (tenant_id, start_at) where status_rollup = 'pending_approval'  -- VIEW-driven; we materialise this one because the operator inbox sorts by it
```

The GiST exclusion on `asset_reservations` does the heavy lifting on the conflict-guard write path — single index lookup, sub-80ms even under contention (proved out by the equivalent on `reservations` in sub-project 1).

### 13.3 Frontend performance

- **Booking-confirm dialog**: each service section lazily renders only when expanded. A user who only adds catering doesn't pay for the AV section's menu fetch until they expand it. React Query keys are scoped per (location_id, time_window, requester_id); idle expansions stay cached for 30s (matches the picker stale time).
- **Bundle detail drawer**: audit-history timeline virtualised at 100+ rows (TanStack Virtual). Not expected to hit that for v1 but cheap insurance.
- **Operator scheduler integration**: bundle service blocks render as a single colored shadow on the room row, no per-cell cost. Hover reveals the full service detail.

### 13.4 UX — through every persona

**Employee booking a meeting** (the 80% case):
- Defaults are aggressive: today, next round-half-hour, prefilled cost center from primary org membership, attendee count = 1.
- Service sections start collapsed. The user shouldn't see catering/AV unless they want them.
- One-click templates: "Recent: Sales kickoff" / "Recent: Daily standup" / "Template: Executive Lunch" sit above the time picker as chips. Picking one fills 90% of the form.
- The cost roll-up updates inline, never blocks the form. Annualised total shows a tooltip only when hovering — doesn't shout at the user.
- Service rule outcomes (warn / require_approval) appear as a chip inline on the line, with the rule's `denial_message` as the explanation. Never a generic "approval needed" banner.
- Submit confirmation: one toast "Booked Sales kickoff with catering · 1 approval pending from Sarah Lee · See bookings →". Not three separate toasts for room + catering + approval.

**Employee placing a standalone order** (office party planner):
- `/portal/order` opens with location prefilled from primary work location. Date defaults to next-business-day.
- Recurrence toggle visibly disabled with "Coming soon" — no false promise.
- Cost roll-up identical to composite — same component, reused.

**Approver reading their queue** (manager / finance / facilities):
- One row per bundle in their inbox. The dedup makes "approve all 3 things" one click.
- Per-line reject is a small "× this only" button next to each line, not a primary action — defaults are biased toward "approve all".
- Approval row shows `scope_breakdown.reasons` as a collapsible "Why this needs approval" section. Each rule's `denial_message` shown verbatim.
- After approval, the row clears from the inbox immediately (optimistic update + realtime confirm).

**Fulfillment team member** (catering vendor / AV team / facilities):
- They live in `/desk/tickets` filtered by `ticket_kind='work_order'`. Their inbox is unchanged.
- New row chip shows the bundle context: "Bundle: Sales kickoff · 09:00 · Meeting Room 2.12".
- Service window (`service_window_start_at`) sorts the inbox by when they need to act — not by when the meeting is. AV setup at 8:30 sorts above the 9:00 meeting it serves.
- Mobile-friendly: the same ticket row component works on mobile (already shipped in sub-project 1).

**Operator triaging today's bookings** (service desk):
- `/desk/bookings` Bundles scope shows everything that's a bundle today + tomorrow.
- Row drawer shows the Services section with click-through to each work-order ticket — no need to leave the bookings page to check on a catering line.
- Cancellation cascade dialog is the operator's single point of "make this not happen" — no surgery across multiple pages.

**Admin configuring services** (workplace ops lead):
- `/admin/booking-services` index card layout makes the three concepts (vendors, menus, items) immediately legible. No mental model to figure out.
- Bundle template editor has a live preview pane — admin sees exactly what the user will see, without doing test bookings.
- Rule simulation against last 30 days surfaces "this rule would have fired on 12 bookings" before publishing — same pattern as room rules sub-project 1.

### 13.5 Design tokens + accessibility

- All forms compose from `Field` primitives per CLAUDE.md mandate.
- Service sections use the same expand/collapse pattern as Recurrence — visual continuity.
- Cost numbers in `tabular-nums` so live-updating totals don't shift.
- Status pills (Approved / Pending / Cancelled / Fulfilled) reuse the existing `BookingStatusPill` colour system — green / amber / muted / outline. No new colour conventions.
- Dark mode + light mode covered by tokens (no hard-coded colours).
- Keyboard navigation: every dialog and drawer fully keyboard-traversable; per-line "when" picker uses the existing `DateTimePicker` (already keyboard-accessible).
- Reduced-motion respected globally (already wired in `apps/web/src/index.css`).
- Approver UI's "Approve all" / per-line reject buttons have proper ARIA labels naming what they cover ("Approve room booking, catering for 14, AV setup").

### 13.6 What we DON'T over-promise to users

The slice is honest about its limits:
- **Vendor real-time tracking** — not promised. Timeline shows what we know, no more.
- **Standalone order recurrence** — toggle disabled, "Coming soon" inline.
- **Floor-plan service placement** — not in scope; no UI affordance pretending otherwise.
- **Performance scorecards** — not in this slice; the `/admin/booking-services/vendors/:id` page has a "Performance" section stub with an explicit "Available in a future release" message.

### 13.7 Empty / loading / error states (first-class)

For every new surface:
- **Empty state** — explicit illustration + one-line explanation + primary CTA. No bare "No data".
- **Loading** — skeleton variant matching final shape, never a centered spinner unless it's a sub-second operation.
- **Error** — inline alert with the actual server message + retry button + link to operator if it's a permission issue.
- **Partial state** — e.g. "approval pending" lines show a clock icon next to the value, not just blank. Status is always legible without hovering.

### 13.8 Notifications (sub-project 5 will own delivery; we capture the events here)

| Event | Recipient | Default channel |
|---|---|---|
| Bundle pending approval | Approvers | Email + in-app |
| Bundle approved / rejected | Requester + host | Email + in-app |
| Service line at risk (lead time about to expire without confirmation) | Requester + fulfillment team | In-app + nudging email if T-2h |
| Bundle cancelled (any path) | Requester, host, all approvers, fulfillment team for fulfilled lines | Email + in-app |
| Per-line reject on a bundle approval | Requester + host | In-app explaining what was kept / cancelled |

Each event ships with a self-explaining body — same pattern as sub-project 1's auto-release email — including deep link to the bundle detail and a "what does this mean for me" sentence per persona.
