# Room Booking — Operational Reference

This is the living operational reference for the room booking module. Same
mandate as `docs/assignments-routing-fulfillment.md` and `docs/visibility.md`:
**when code in the trigger list below changes, update this doc in the same
PR**. Silent drift is how room-booking bugs hide.

## Mental model — orthogonal axes

The room booking module separates four concerns. Keep them separate when
reasoning about a bug or feature:

1. **Availability** — does the conflict guard let this slot exist? Owned by
   the `reservations.time_range` GiST exclusion constraint and the buffers
   trigger (00122/00123).
2. **Access & policy** — should this requester even be allowed, or be sent
   to approval, or be warned? Owned by `room_booking_rules` (the D engine)
   and `RuleResolverService`.
3. **Execution** — once a booking is confirmed, what side effects fire?
   Notifications, calendar sync push, workflow events. Owned by
   `BookingFlowService` (post-write fan-out) and the cron jobs (auto-release,
   reconcile).
4. **Visibility** — who can see / edit / list reservations they didn't
   create? Owned by `ReservationVisibilityService` (three tiers:
   participant, operator, admin).

When something goes wrong, ask "which axis" first. A booking that won't
save is axis 1 or 2. A booking that saved but didn't notify is axis 3. A
booking that's invisible to the wrong user is axis 4.

## Reservation status — the seven-state model

```
draft               admin/api scratchpad; not on the picker
  ↓
pending_approval    rule effect = require_approval; counts toward the conflict guard
  ↓
confirmed           in the room; counts toward the conflict guard
  ↓
checked_in          requester has acknowledged at start_at; counts toward the conflict guard
  ↓
released            no-show auto-release; FREES the slot
cancelled           soft cancel; FREES the slot
completed           past end_at + grace; counts as historical only
```

The conflict-guard exclusion constraint covers `('confirmed','checked_in',
'pending_approval')`. Other statuses do not block new bookings.

## Booking creation pipeline

`BookingFlowService.create(input, actor)` is the **only** path that writes a
new reservation row. The portal, desk scheduler, calendar-sync intercept,
and recurrence materialiser all funnel through it.

```
1. Snapshot from space:    setup_buffer_minutes, teardown_buffer_minutes,
                           check_in_required, check_in_grace_minutes,
                           cost_per_hour
2. Compute effective time: start_at - setup_buffer  →  effective_start_at
                           end_at + teardown_buffer →  effective_end_at
                           (collapsed to zero when prior or following
                           booking on the same room shares requester_person_id)
3. RuleResolver.resolve(requester, space, time, criteria):
     - load rules where target matches the space's chain
       (room → space_subtree → room_type → tenant)
     - evaluate `applies_when` predicate against booking context
     - sort: specificity desc, then priority desc
     - aggregate effects: deny wins → require_approval → warn → allow
4. If any 'deny' (and not overridden) →
     throw 403 with denial_message + 3 picker alternatives
5. If any 'require_approval'           →
     status='pending_approval', create approvals row(s), fire workflow event
   else                                 →
     status='confirmed'
6. INSERT reservations
   On 23P01 (exclusion violation): never retry; build alternatives and
   return structured 409. The user always sees the alternatives panel.
7. Fan-out side effects:
     - reservation.created event
     - calendar sync push (Outlook outbound)
     - notification dispatch (confirmation email + portal toast)
     - realtime channel publish
```

## Predicate engine

Booking rules use the same predicate language as routing rules and request
type predicates. Helper SQL functions added in 00119:

| Function | Used for |
|---|---|
| `public.in_business_hours(at, calendar_id)` | "off-hours need approval" rules; respects calendar timezone + holidays |
| `public.org_node_descendants(root_id)` | "restrict to org subtree" — returns root + all descendants |
| `public.space_descendants(root_id)` | applying rules whose `target_scope='space_subtree'` |

When adding a new template that needs a new primitive, add a SQL helper
function in a new migration first, then expose it in the predicate engine
service.

## Rule templates (the admin's 95% surface)

12 starter templates ship in v1. Power users can drop into raw predicate
mode for the remaining 5%. The full list lives in
`apps/api/src/modules/room-booking-rules/rule-templates.ts`.

```
restrict_to_roles                       → deny by role allowlist
restrict_to_org_subtree                 → deny by org-node subtree
off_hours_need_approval                 → require_approval outside business hours
min_lead_time / max_lead_time           → deny if lead time outside range
max_duration                            → deny if booking too long
capacity_tolerance                      → over-capacity by factor (deny/warn/approve)
long_bookings_need_manager_approval     → duration over X → approval
high_capacity_needs_vp_approval         → attendees over X → approval
capacity_floor                          → deny if attendees < space.min_attendees
soft_over_capacity_warning              → warn if attendees > space.capacity
service_desk_override_allow             → allow_override for service desk role
```

## Calendar sync (Outlook only in v1)

Two patterns per room. Mode chosen in `spaces.calendar_sync_mode`:

- **Pattern A** (default): Outlook room mailbox exists, auto-accept off,
  Prequest is the calendar processor. Inbound invites flow through the
  intercept pipeline (`RoomMailboxService.handleNotification`) which calls
  the same `BookingFlowService.create` as the portal — rules and conflict
  guard run on every invite regardless of source.
- **Pattern B**: no Outlook room mailbox. Only the portal/desk creates
  bookings; Prequest writes the meeting to the user's personal calendar
  with the room as free-text `location`.

Reconciliation policy: **Prequest is authoritative**. Outlook attempts
that conflict with Prequest rules or with another booking are rejected
with the rule's `denial_message` written into the user's Outlook decline
email — the self-explaining differentiator extends across both surfaces.

The `room_calendar_conflicts` table is the conflicts inbox; admins resolve
unrecoverable cases via `/admin/calendar-sync/conflicts`. Healthy
deployments see this table empty.

## Recurrence

Each occurrence is a separate `reservations` row linked by
`recurrence_series_id`. The series row in `recurrence_series` carries the
recurrence rule, holiday calendar, and `materialized_through` rolling
window cap. `recurrenceRollover` cron extends the materialized horizon
nightly.

Edit semantics:

- **Edit this occurrence** — flip `recurrence_overridden=true` on the row,
  apply patch, leave others intact.
- **Edit this and following** — split the series at this occurrence: new
  series_id for the rest, new recurrence_rule.
- **Edit entire series** — patch the series row, then either re-materialise
  (if pattern changed) or apply per-row patches (if only metadata).
- **Skip occurrence** — flip `recurrence_skipped=true`, status='cancelled'.

Edits always show **impact preview** before commit: how many future
occurrences are affected, whether any of them now conflict, with options
to skip/find-alternative/cancel-series.

## Visibility tiers

Reservations are not tickets. Three tiers:

1. **Participant** — `requester_person_id`, anyone in `attendee_person_ids[]`,
   or `booked_by_user_id`. Implicit read of own data.
2. **Operator** — `rooms.read_all` permission OR a per-site grant. Reads
   across requesters but cannot edit.
3. **Admin** — `rooms.admin` permission. Full read + write + rule mgmt.

`ReservationVisibilityService.loadContext` caches per-request; the
controller injects `WHERE` clauses via `filterIds(ctx)` to avoid N+1.

## Background jobs

| Job | Cadence | Purpose |
|---|---|---|
| `autoReleaseScan` | every 5 min | flip uncheckedin → released; emits self-explaining release email |
| `checkInRemindersScan` | every 5 min | send reminder + magic-link 5 min before start |
| `recurrenceRollover` | nightly (3 am) | extend `materialized_through` for active series, capped 100 occurrences/tick |
| `outlookSyncPoll` | every 5 min | pull deltas from Microsoft Graph for active links |
| `outlookWebhookRenew` | hourly | renew Graph webhook subscriptions before expiry |
| `roomMailboxWebhookRenew` | hourly | renew Pattern-A room mailbox webhooks |
| `calendarHeartbeatReconcile` | hourly | per-room diff against Outlook calendar; raise drift |
| `cancellationGraceCleanup` | hourly | clear past-due `cancellation_grace_until` |
| `impactPreviewWarmer` | nightly | precompute aggregate stats for rule analytics |

Cron registrations live alongside their owning service (`CheckInService`,
`RecurrenceService`, `BookingNotificationsService`, `WebhookRenewalService`,
`ReconcilerService`).

## Notifications

The `BookingNotificationsService` is the single seam for booking-lifecycle
notifications. Each event maps to a `notification_type`:

| Trigger | notification_type | Audience |
|---|---|---|
| `BookingFlowService.create` (status='confirmed') | `reservation_created` | requester |
| `BookingFlowService.create` (status='pending_approval') | `reservation_approval_requested` | approvers |
| Approval decided (Phase J) | `reservation_approved` / `reservation_rejected` | requester |
| `ReservationService.cancelOne` | `reservation_cancelled` | requester |
| `CheckInService.autoReleaseScan` flips → released | `reservation_released` | requester (self-explaining) |
| `BookingNotificationsService.checkInRemindersScan` (T-5 min) | `reservation_check_in_reminder` | requester (with magic link) |

The release email is the differentiator (spec §12): tells the user *why* (no
check-in within grace), with deep-links to rebook this slot or see
alternatives.

## Magic-link check-in

Endpoint: `POST /reservations/:id/check-in/magic?token=<HMAC>` — `@Public()`.

Token shape (URL-safe base64): `${reservation_id}.${requester_person_id}.${expiry_ms}.${HMAC-SHA256}`

- Signed with `CHECK_IN_MAGIC_SECRET` env var.
- 30-minute expiry; mismatch / signature-fail / expired all reject with 400.
- Verifier asserts that the token's `requester_person_id` matches the
  reservation's `requester_person_id`, so a token can't be reused on another
  booking even if the IDs were swapped in the URL.

The reminder email includes this link so users can check in without logging
in. See `apps/api/src/modules/reservations/magic-check-in.token.ts`.

## Outlook intercept (Pattern A)

Wired in `ReservationsModule.onModuleInit` via
`RoomMailboxService.registerIntercept`. The handler:

1. Resolves `draft.organizer_email` → `persons.id` (case-insensitive `ilike`,
   tenant-scoped). Unknown organizer → `{ outcome: 'denied', denialMessage: 'Organizer email is not a registered Prequest user.' }`.
2. Resolves attendees the same way; missing emails are dropped silently
   from the internal-attendee list.
3. Calls `BookingFlowService.create` with `source='calendar_sync'` and a
   synthetic actor (no override).
4. Maps booking outcome → intercept outcome:
   - success → `{ outcome: 'accepted' }`
   - `ForbiddenException` (rule deny) → `{ outcome: 'denied', denialMessage }`
   - `ConflictException` (slot taken) → `{ outcome: 'conflict' }`
   - any other error → `{ outcome: 'deferred' }` (audit + retry on next tick)

The `RoomMailboxService` then writes accept/reject back to the room calendar.

## Audit events

Every booking-lifecycle decision emits a row to `public.audit_events`. The
event_type vocabulary (consumed by reporting + activity feeds):

| Event type | Where it fires | Notes |
|---|---|---|
| `reservation.created` | `BookingFlowService.create` | one per row, including each occurrence of a recurring series and each room of a multi-room group |
| `reservation.updated` | `ReservationService.editOne` / `BookingFlowService.editScope` | patch diff in `details` |
| `reservation.cancelled` | `ReservationService.cancelOne` (single occurrence) | scope='this' |
| `reservation.recurrence_cancel_forward` | `RecurrenceService.cancelForward` | scope='this_and_following' or 'series'; details includes pivot + cancelled_count |
| `reservation.recurrence_split` | `RecurrenceService.splitSeries` | edit-this-and-following promotes a sub-tail to its own series |
| `reservation.restored` | `ReservationService.restore` | within the cancellation grace window only |
| `reservation.checked_in` | `CheckInService.checkIn` | both explicit + magic-link paths |
| `reservation.auto_released` | `CheckInService.autoReleaseScan` | grace expired without check-in |
| `reservation.multi_room_created` | `MultiRoomBookingService.createGroup` | one per atomic group; per-room rows still fire `reservation.created` |
| `reservation.multi_room_rolled_back` | `MultiRoomBookingService.createGroup` (failure path) | sibling failed → group cancelled; `details.failures` carries reasons |
| `room_booking_rule.{created,updated,deleted}` | `RoomBookingRulesService` | rule lifecycle |
| `reservation.override_used` | `BookingFlowService.create` (override path) | actor used `rooms.override_rules` to bypass a deny |
| `outlook.intercept_outcome` | `RoomMailboxService` | one per Pattern-A invite handled, with outcome enum |
| `bundle.created` | `BundleService.attachServicesToReservation` | composite booking — entity arrays in `details` (orders, lines, asset_reservations, approvals) |
| `bundle.cancelled` | `BundleCascadeService.cancelBundle` | full or partial cascade; `keep_line_ids`, `fulfilled_line_ids`, and entity-cascade arrays in `details` |
| `order.created` | `OrderService.createStandalone` | services-only bundle (no reservation) |
| `order.line_cancelled` | `BundleCascadeService.cancelLine` | single-line cancel; cascaded ticket + asset_reservation ids; `closed_approval_ids` if any approval row dropped to empty scope |

## Bundles + service flow (sub-project 2)

Bundles are the orchestration parent that ties a reservation to one or more
**service lines** (catering, AV, room setup) and a **standalone-order**
shape (no reservation). Created lazily on first-service-attach — room-only
bookings stay simple.

```
booking_bundles                       (lazy on first attach)
  ├── primary_reservation_id ?────→  reservations
  ├── orders[1..N] ─────────────→ order_line_items[1..N]
  │                                  ├── linked_ticket_id    → tickets (work_order)
  │                                  └── linked_asset_reservation_id → asset_reservations
  └── approvals[*] (deduped by approver_person_id, scope_breakdown jsonb)
```

The four lifecycle methods + their entry points:

| Method | Entry point | Notes |
|---|---|---|
| `BundleService.attachServicesToReservation` | `POST /reservations` (with `services[]`) — called from `BookingFlowService.create` post-write | Lazy bundle create; one order per service_type group; per-line asset GiST conflict guard fires here |
| `OrderService.createStandalone` | `POST /orders/standalone` | Services-only bundle (`primary_reservation_id` null) |
| `BundleCascadeService.cancelLine` | (internal) | Per-line cancel + cascade to ticket + asset_reservation; auto-close empty-scope approvals |
| `BundleCascadeService.cancelBundle` | `POST /booking-bundles/:id/cancel` | Smart-default cascade with `keep_line_ids[]` opt-out; fulfilled lines protected |

### Service rule resolver

`ServiceRuleResolverService` shares `PredicateEngineService` with room rules
through a refactored `BaseEvaluationContext` shape. Service rules carry a
distinct `ServiceEvaluationContext` (catalog item / menu / order — not
room / space / booking) so predicates can address `$.line.menu.fulfillment_vendor_id`
or `$.order.total_per_occurrence` directly.

Specificity (lowest is most specific):
1. `target_kind='catalog_item'` — `target_id = line.catalog_item_id`
2. `target_kind='menu'` — `target_id = line.menu_id`
3. `target_kind='catalog_category'` — `target_id = catalog_items.category`
4. `target_kind='tenant'` — applies to every line

### Approval dedup

`ApprovalRoutingService.assemble` per spec §4.4:

1. Collect every `require_approval` / `allow_override` outcome across lines.
2. Resolve each rule's `approver_target` to concrete person_id list:
   - `person` → `[personId]`
   - `role` → expanded to active members (first-approver-wins enforced on
     approval submission, sub-project 5+)
   - `derived` (`cost_center.default_approver`) → `cost_centers` row lookup
3. Group by `approver_person_id`; merge `scope_breakdown.{reservation_ids,
   order_line_item_ids, asset_reservation_ids, ticket_ids, reasons}` arrays
   in TypeScript (concat + dedupe per key) — the jsonb `||` operator does
   shallow merge and would lose entries.
4. Upsert via SELECT-merge-UPDATE inside the bundle transaction; the unique
   partial index `(target_entity_id, approver_person_id) WHERE status='pending'`
   (migration 00146) is the safety net — concurrent inserts surface as
   `23505` and the second writer retries the SELECT-merge path.

### Bundle visibility

Three tiers per spec §3.5, mirrored in TS (`BundleVisibilityService`) and
SQL (`bundle_is_visible_to_user` from migration 00148). Both implementations
must agree.

1. **Participant** — `requester_person_id`, `host_person_id`, anyone in any
   approval row's `approver_person_id` for this bundle, or any work-order
   ticket's `assigned_user_id`.
2. **Operator** — `rooms.read_all` permission. Location-grant scoping is a
   sub-project 4 follow-up.
3. **Admin** — `rooms.admin` permission. Tenant-wide.

### Asset conflict guard

Asset reservations get the same GiST exclusion treatment as rooms (migration
00142). Two bookings can never reserve the same projector at overlapping
times. Cancelled / released reservations don't block new ones — the
exclusion's `WHERE` clause covers `status='confirmed'` only.

```
asset_reservations
  exclude using gist (asset_id with =, time_range with &&) where (status = 'confirmed')
```

### Status rollup

Bundles don't store a status column — `booking_bundle_status_v` derives it
at read time from linked entities. The CASE ladder:

```
no entities yet                     → 'pending'
any reservation = 'pending_approval' or order = 'submitted'
                                    → 'pending_approval'
all reservations cancelled/released AND
all orders cancelled/fulfilled      → 'partially_cancelled' (if any fulfilled)
                                       or 'cancelled' (otherwise)
any reservation/order cancelled     → 'partially_cancelled'
otherwise                           → 'confirmed'
```

A 'completed' state is in the spec but not yet emitted by the view — fold
it in when sub-project 4 (reception) actually consumes it.

Audit emission is best-effort (try/catch wrapping the insert) — the lifecycle
event commits even if audit insert fails. Audit gaps will show as warning
logs but the booking itself never blocks on audit.

## Performance instrumentation

The picker emits a structured timing log per call so a Loki / DataDog
scrape rule can compute `room_booking_picker_latency_seconds` without
pulling in a dedicated metrics SDK:

```
picker tenant=<id> candidates=<n> returned=<n> elapsed_ms=<ms>
```

Calls slower than 2× the §6.1 budget (>500 ms) are logged at WARN level
so slow outliers surface in real time. Spec budgets:

| Surface | Target p95 | Status |
|---|---|---|
| Picker (`/reservations/picker`) | <250 ms server, <600 ms perceived | parallel pipeline + scope filter shipped (00138 era) |
| Desk scheduler open (50 rooms × 7 days) | <700 ms server, <1.2 s perceived | virtualised rows + `include_unavailable` shipped |
| Conflict-guard write | <80 ms | GiST exclusion constraint + buffer trigger |
| Auto-release scan tick | <200 ms | partial index `idx_reservations_pending_check_in` + 24h lower bound |

When adjusting any picker query, paste the EXPLAIN ANALYZE output into the
PR description and confirm the budget still holds.

## MANDATORY — keep this doc in sync

Trigger files. **If a change touches any of the below, update this doc in
the same commit / PR**:

Backend:
- `apps/api/src/modules/reservations/**`
- `apps/api/src/modules/room-booking-rules/**`
- `apps/api/src/modules/calendar-sync/**`
- `apps/api/src/modules/floor-plans/**`
- `apps/api/src/modules/booking-bundles/**`
- `apps/api/src/modules/orders/**`
- `apps/api/src/modules/service-catalog/**`
- `apps/api/src/modules/bundle-templates/**`
- `apps/api/src/modules/cost-centers/**`

Frontend:
- `apps/web/src/pages/portal/book-room/**`
- `apps/web/src/pages/portal/me-bookings/**`
- `apps/web/src/pages/portal/order/**`
- `apps/web/src/pages/desk/scheduler/**`
- `apps/web/src/pages/desk/bookings.tsx`
- `apps/web/src/pages/admin/room-booking-rules/**`
- `apps/web/src/pages/admin/booking-services/**`
- `apps/web/src/pages/admin/cost-centers/**`
- `apps/web/src/pages/admin/bundle-templates/**`
- `apps/web/src/pages/admin/calendar-sync.tsx`
- `apps/web/src/api/room-booking/**`
- `apps/web/src/api/room-booking-rules/**`
- `apps/web/src/api/calendar-sync/**`
- `apps/web/src/api/booking-bundles/**`
- `apps/web/src/api/orders/**`
- `apps/web/src/api/service-catalog/**`
- `apps/web/src/api/service-rules/**`
- `apps/web/src/api/cost-centers/**`
- `apps/web/src/api/bundle-templates/**`
- `apps/web/src/api/asset-reservations/**`

Migrations — any add/alter of:

- `reservations`, `recurrence_series`, `room_booking_rules`,
  `room_booking_rule_versions`, `multi_room_groups`,
  `calendar_sync_links`, `calendar_sync_events`,
  `room_calendar_conflicts`, `floor_plans`,
  `room_booking_simulation_scenarios`.
- `booking_bundles`, `bundle_templates`, `cost_centers`, `service_rules`,
  `service_rule_versions`, `service_rule_simulation_scenarios`,
  `service_rule_templates`, `asset_reservations`.
- `orders` and `order_line_items` columns added in sub-project 2
  (`booking_bundle_id`, `requested_for_*`, `recurrence_*`, `service_window_*`,
  `policy_snapshot`, `linked_asset_reservation_id`, `repeats_with_series`).
- `tickets.booking_bundle_id` / `tickets.linked_order_line_item_id`.
- `approvals.scope_breakdown` + the dedup unique partial index.
- `catalog_menus.fulfillment_team_id` + the XOR check + the resolver function.
- `spaces` columns related to booking config (`min_attendees`,
  buffers, check-in, calendar sync mode, floor_plan_polygon, etc.).
- `business_hours_calendars` if the working_hours / holidays jsonb shape
  changes — the `in_business_hours` helper depends on it.

When this doc and the code disagree, **fix this doc first, then align the
code to the corrected doc**.

## Related

- Design spec: [`docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md`](./superpowers/specs/2026-04-25-room-booking-foundation-design.md)
- Module decomposition: [`docs/superpowers/specs/2026-04-25-room-booking-module-decomposition.md`](./superpowers/specs/2026-04-25-room-booking-module-decomposition.md)
- North-star blueprint: [`docs/workplace-booking-and-visitor-blueprint-2026-04-21.md`](./workplace-booking-and-visitor-blueprint-2026-04-21.md)
