# Audit 05 — RPC / Transaction Boundary / Idempotency

Date: 2026-05-13
Auditor: orchestrator subagent (Claude / Opus 4.7 1M)
Scope: every API-facing mutation in `apps/api/src/modules/**`, every PL/pgSQL
function in `supabase/migrations/**`, the outbox spec
(`docs/superpowers/specs/2026-05-04-domain-outbox-design.md`), the
idempotency module (`packages/shared/src/idempotency.ts`), live smoke
scripts (`apps/api/scripts/smoke-*.mjs`).

---

## Executive verdict

**Status: mixed — strong on the new "B.2 / B.4 / B.0.D" canonical paths,
weak everywhere else.**

The codebase clearly has two architectural eras inside it at once:

1. **Era A — Canonical RPC era (everything labelled B.0 / B.2 / B.4 / Phase 1
   workflow).** Multi-table writes for tickets, work orders, bookings,
   approvals, dispatch, edit-booking, edit-scope, transition-status,
   assignment, SLA, and reclassify ALL go through PL/pgSQL RPCs (00309 /
   00310 / 00311 / 00312 / 00325 / 00327 / 00330 / 00331 / 00335 / 00336 /
   00337 / 00342 / 00349 / 00351 / 00354 / 00356 / 00357 / 00361 / 00362 /
   00364 / 00367 / 00371 / 00394 / 00395). Every one of those RPCs:
   - Takes an advisory_xact_lock keyed on (tenant_id, idempotency_key).
   - Writes a `command_operations` row keyed on the same.
   - Writes domain rows + ticket_activities + outbox.events in ONE
     Postgres transaction.
   - Returns a `cached_result jsonb` so replays short-circuit.
   - Has a smoke probe touching the real remote DB
     (`smoke-work-orders`, `smoke-tickets`, `smoke-edit-booking`,
     `smoke-edit-booking-scope`, `smoke-floor-plans`, `smoke-outbox`).
   - Has a typed idempotency-key builder in
     `packages/shared/src/idempotency.ts` so TS + smoke scripts cannot
     drift on the key shape.

   That is the right architecture. It matches the CLAUDE.md mandate.

2. **Era B — Pre-canonical TS-sequenced era.** Significant volume of
   multi-table writes that pre-date the B.0/B.2/B.4 cutover and **still
   ship code that violates the CLAUDE.md mandate**. These are mostly in
   visitors, recurrence, bundle-cascade, standalone orders, and the
   workflow-engine `approval` node. None of them have an advisory lock,
   a `command_operations` gate, an idempotency key, OR a same-tx outbox
   emit. A Node crash mid-flight in any of them leaves a corrupt
   cross-table state.

The headline summary: **the "production-critical" surfaces have been
fixed; the "still in flight" surfaces have not.** That maps roughly to
"things B.4 / B.2.A touched are fine; things only Phase A/B touched are
not."

**Highest-risk legacy patches still in production:**
- `OrderService.createStandalone` — 5+ tables in a TS loop with an
  in-process `StandaloneCleanup` compensator (legacy compensation
  pattern explicitly retired by CLAUDE.md).
- `BundleCascadeService.cancelLine` / `cancelBundle` — multi-table
  cascade with NO command_operations, NO advisory lock, NO outbox.
- `RecurrenceService.cancelForward` / `splitSeries` — booking + slots
  + orders + audit, 4-5 tables sequential, partial-state risk.
- `WorkflowEngineService` `approval` node — N approval inserts in a
  loop + workflow_instances status update; loop failure halfway leaves
  partial approvers + workflow stuck.
- `InvitationService.create` — visitors → visitor_hosts → tokens →
  approvals → audit → domain_events; 4 hard inserts + 2 best-effort,
  zero atomicity.
- `KioskService.walkUp` — persons.create → visitors → visitor_hosts →
  transition; if transition fails, walk-up is half-registered.

These are P1 — they're the real "next migration" candidates and they
match the residual `BookingTransactionBoundary` / `BookingCompensation`
plumbing that the spec already labels as legacy / Phase 6.

The good news is that the new canonical surface PATTERN is correct and
re-applying it to each of the above legacy services is mechanical work
— same primitives, same key-builder pattern, same smoke-probe shape.

---

## P0 — partial-state corruption already in production

### P0-1. `WorkflowEngineService` approval node — N approvals + status update, no tx

`apps/api/src/modules/workflow/workflow-engine.service.ts:1349-1477`.

The `approval` node:
1. Loops over `approvers[]` and inserts each into `approvals` (one
   round-trip per row).
2. Updates `workflow_instances.status = 'waiting'` in a separate write.

No transaction wraps these. No idempotency key. Per-row
`assertTenantOwned` round-trips happen between the inserts, widening
the failure window.

**Failure mode:** Node crash after insert #2 of 5 → 2 approval rows
exist + 3 missing + workflow_instances still in `running`. On the next
WorkflowSpawnWakeHandler tick the workflow is replayed from scratch
(if the engine even has a "replay this node" path — it doesn't today)
and inserts a duplicate set of 5 approvers. Result: 7 approval rows
where there should be 5, the `parallel_group` count is wrong, and
`grant_booking_approval` v2 can either (a) resolve early because the
"all" threshold is met without realising 2 are duplicates, or (b)
deadlock waiting for grants on rows that no one is paged on.

**Evidence:** lines 1414-1462 are a per-row loop with an `await` on
the insert; lines 1469-1473 separately update workflow_instances.

**Severity:** P0 — silent decision corruption (wrong people approve;
double-grant; missed approvals). Hit rate scales with workflow
adoption.

**Fix:** consolidate into a single `start_workflow_approval_node` RPC
that takes the approvers[] array + threshold + chain id and writes all
N approval rows + the workflow_instances status flip in one tx. Mirror
the `dispatch_child_work_orders_batch` (00337/00342) shape — that RPC
already proves the "N rows in one tx with deterministic ids" pattern
for child work orders.

---

### P0-2. `OrderService.createStandalone` — legacy compensation pattern explicitly retired

`apps/api/src/modules/orders/order.service.ts:750-1064` (+
`StandaloneCleanup` class at :1348+).

Writes:
1. `bookings` (services-only) — 1 row.
2. `orders` — 1 row.
3. `asset_reservations` — N rows.
4. `order_line_items` — N rows.
5. `approvals` — N rows via `approvalRouter.assemble()` (which itself
   reads-then-writes — own race; see P1-1).
6. `orders.status` update — 1 row.
7. `order_line_items.pending_setup_trigger_args` — N updates.
8. `audit_events` — 1 row.
9. Outbox emissions for setup work orders — via TS calls.

Wrapped in a `StandaloneCleanup` class that tracks inserted ids and
deletes them on the catch path. **This is the legacy
BookingTransactionBoundary pattern that CLAUDE.md explicitly retired**
("BookingTransactionBoundary + in-process compensation is LEGACY
(Phase 6 hardening backlog)"). The cleanup itself can fail (network
hiccup, RLS edge case, FK ordering bug) — and when it does, half the
order persists.

No `command_operations` row. No idempotency key. A React Query retry
of the same submit creates a duplicate booking + duplicate order +
duplicate asset_reservations.

**Severity:** P0 — direct architectural-mandate violation; duplicate
orders on retry; orphaned asset_reservations on crash.

**Fix:** add a `create_standalone_order_with_attach_plan` RPC mirroring
`create_booking_with_attach_plan` (00309). Same TS-side plan
construction, same atomic SQL write. Standalone orders ARE just
"booking with zero slots + N attached services" per the comment on
line 743-748; the existing RPC already handles that — wire it through.

---

### P0-3. `BundleCascadeService.cancelLine` / `cancelBundle` — 5-table cascades, no tx

`apps/api/src/modules/booking-bundles/bundle-cascade.service.ts:76-200`
(`cancelLine`) and `:220-450+` (`cancelBundle`).

`cancelLine` writes (in TS sequence):
1. `asset_reservations.update` (cancel)
2. `work_orders.update` (close + closed_at)
3. `order_line_items.update` (cancel + clear pending_setup_trigger_args)
4. `approvals.update` (re-scope via `rescopeApprovalsAfterLineCancel`)
5. `audit_events.insert`
6. `BundleEventBus.emit` (fires cross-module subscribers)

`cancelBundle` is a fan-out of `cancelLine` over N lines with similar
non-atomic structure.

No `command_operations`, no advisory lock, no outbox event. A retry
isn't safe — the second call updates already-cancelled rows (mostly
no-op) but `audit_events` gets a duplicate row and `BundleEventBus`
fires a duplicate event (visitor cascade adapter would re-cancel
visitor invites that the first call already cancelled — subscriber
idempotency is the only safety net, and that's a separate audit).

**Severity:** P0 — cascade can stop halfway and leave asset reserved,
line cancelled, work order open, approval still scoped → triple
truth-source mismatch.

**Fix:** RPC `cancel_line` / `cancel_bundle` taking the line/bundle id
+ idempotency key. Mirror the shape of `grant_booking_approval`
(00310) — it cascades booking → slots → orders → setup-trigger emit
atomically.

---

### P0-4. `RecurrenceService.cancelForward` + `splitSeries` — multi-table, no tx

`apps/api/src/modules/reservations/recurrence.service.ts:878-970`
(`cancelForward`) and `:759-871` (`splitSeries`).

`cancelForward` writes:
1. `bookings.update` (cancel N rows)
2. `booking_slots.update` (cancel for N booking ids)
3. Per booking: `bundleCascade.cancelOrdersForReservation` — itself a
   multi-table sequence (P0-3 above).
4. `recurrence_series.update` (cap series_end_at)
5. `audit_events.insert`

`splitSeries` writes:
1. `recurrence_series.insert` (new series row)
2. `bookings.update` (re-anchor N rows to new series_id)
3. `recurrence_series.update` (cap source series)
4. `audit_events.insert`

Note that MEMORY.md already records this as
**"Tier B #5 splitSeries hardening — IN FLIGHT"** in
`project_b4_workstream_state` — confirms this is known but not done.

**Severity:** P0 — recurrence ops are inherently bulk; partial state
is highly visible (half the series cancelled, the other half visible
on the calendar).

**Fix:** `cancel_recurrence_forward_rpc(series_id, pivot_at, scope)`
and `split_recurrence_series_rpc(booking_id)` — both atomic, both
return cached_result, both bump audit/outbox in same tx. Stop calling
out to `BundleCascadeService` mid-flight and instead emit a
`bundle.cancel_required` outbox event per occurrence for downstream
processing.

---

### P0-5. `InvitationService.create` — 4 strict inserts + 2 best-effort, zero atomicity

`apps/api/src/modules/visitors/invitation.service.ts:71-318`.

Writes:
1. `visitors.insert` (hard fail on error)
2. `visitor_hosts.insert` N rows (hard fail on error)
3. `visit_invitation_tokens.insert` (hard fail on error)
4. `approvals.insert` (hard fail when status=pending_approval)
5. `audit_events.insert` (best-effort try/catch)
6. `domain_events.insert` (best-effort try/catch) — only when
   status='expected', carries the cancel-token plaintext for the
   email worker.

A crash after step 1 leaves a visitor row with NO hosts (visitor list
shows a name with no organizer). After step 2 leaves a visitor with no
cancel token (cancel link is unusable). After step 3 with
require_approval=true leaves a visitor stuck in pending_approval
forever (no approval row exists for anyone to grant).

The cancel token specifically is a privacy/security artifact — the
sha256 hash is written separately from the visitor row. A partial
write means the visitor exists with no recoverable cancel mechanism.

**Severity:** P0 — visitor data corruption is visible to end users
+ host email gets sent (best-effort step 6) referencing a non-
existent cancel link if steps 5/6 succeed but step 3 was rolled-back
by a later error. Hit rate proportional to visitor invite volume.

**Fix:** `create_visitor_invitation_rpc` — all 4 hard inserts in one
tx; emit the domain_event via `outbox.emit()` in the same tx (the
worker drains it). The `cancel_token` plaintext is computed in TS
before the RPC call and passed in; sha256 hashing happens TS-side or
SQL-side — either is fine, but the token-row insert is in the same
tx as the visitor row.

---

### P0-6. `KioskService.walkUp` — persons + visitor + hosts in TS

`apps/api/src/modules/visitors/kiosk.service.ts:480-563`.

1. `persons.create` (via PersonService — itself writes persons row)
2. `visitors.insert`
3. `visitor_hosts.insert`
4. `runArrivalUnderTenantContext` → transitionStatus (another write)

Failure between 1-4 leaves orphan person rows (visitors with no
hosts; persons with no visitor pointer). Walk-up flow is anonymous,
so failure recovery has no UI to recover from. Person rows are
permanent PII liability (GDPR retention rules now apply to data we
don't even reference).

**Severity:** P0 — same shape as P0-5; kiosk path runs without
auth so the operator has no way to retry cleanly.

**Fix:** `walkup_visitor_register_rpc(...)` mirroring P0-5 fix.

---

## P1 — design hazards on canonical paths; service-layer multi-table sequences

### P1-1. `OrdersApprovalRouting.upsertWithRetry` — read-then-write race

`apps/api/src/modules/orders/approval-routing.service.ts:351-440`.

SELECT existing approval → if found, UPDATE merged scope; else INSERT.
The retry-on-23505 handles the simultaneous-insert race, but the
SELECT-then-UPDATE branch is NOT serialized — two writers see the
same `existing.scope_breakdown`, both compute a merge against it, and
both write back; the second write clobbers the first writer's
addition to the breakdown.

**Severity:** P1 — partial scope merge means an approval row's
`order_line_item_ids[]` misses the second-writer's line; the
downstream cascade in `BundleCascade.rescopeApprovalsAfterLineCancel`
then doesn't auto-close the approval when its last visible line
cancels.

**Fix:** convert to an upsert RPC with a `SELECT FOR UPDATE` on the
existing row before the merge. Or — simpler — call
`grant_booking_approval`-style atomic SQL.

---

### P1-2. `SlaService.startTimers` — 2 tables, no tx

`apps/api/src/modules/sla/sla.service.ts:74-126`.

Writes:
1. `tickets` OR `work_orders` (via `updateTicketOrWorkOrder` dispatch)
   — updates `sla_response_due_at`.
2. Same table — updates `sla_resolution_due_at`.
3. `sla_timers.insert` — N rows.

The two `updateTicketOrWorkOrder` calls (line 101-103 + 118-120) and
the `sla_timers.insert` (line 124) are three round-trips. A crash
between any pair leaves the ticket showing one due date but no other +
sla_timers row missing.

This isn't called from the live request path anymore (the new combined
RPC handles SLA inline via `update_entity_sla` 00330), but
`startTimers` is still called from ticket-creation post-commit paths
and from internal callers.

**Severity:** P1 — only fires on ticket creation; new tickets without
sla_timers rows silently fall off the breach scan.

**Fix:** route `startTimers` through `update_entity_sla` (00330 v3) —
that RPC already does the timer-insert and ticket-update in one tx.
Delete `SlaService.startTimers` once nothing calls it.

---

### P1-3. `ReservationService.cancel` and `restore` — booking + slots + cascade

`apps/api/src/modules/reservations/reservation.service.ts:443-592`.

`cancel`:
1. `booking_slots.update` (cancel + grace_until)
2. `bookings.update` (status)
3. `audit_events.insert`
4. `BundleCascadeService.cancelOrdersForReservation` (multi-table; see
   P0-3)

`restore`:
1. `booking_slots.update` (confirm)
2. `bookings.update` (status)
3. `audit_events.insert`

No idempotency. A retry of cancel re-fires the cascade. Same race
window as P0-4 but per-occurrence.

**Severity:** P1 — these are the workhorse cancel/restore paths on
the desk and portal; user-facing.

**Fix:** `cancel_booking_rpc(booking_id, scope, idempotency_key)` and
`restore_booking_rpc(booking_id, idempotency_key)`. Same shape as
`edit_booking` (00364 v4) — atomic write, command_operations cache,
cascade emit via outbox.

---

### P1-4. `BookingFlowService.createApprovalRows` — best-effort post-create

`apps/api/src/modules/reservations/booking-flow.service.ts:1173-1194`.

After `create_booking` RPC succeeds, the TS code fires a SECOND insert
into `approvals` for each approver. On error it `log.warn(...)` and
returns. **A failing approval insert leaves the booking in
`pending_approval` status with NO approval rows** — nobody can grant
it, no notification fires, the booking is stuck forever.

This is reachable ONLY on the non-services booking path
(`createWithAttachPlan` writes approvals atomically via the RPC's
attach plan); the no-services path uses `create_booking` directly +
`createApprovalRows` afterward.

**Severity:** P1 — silent stuck-booking class. Reachable on the most
common booking path (no services).

**Fix:** extend `create_booking` RPC (00277) to accept an `approvers[]`
array and write the rows in the same tx. OR route every approval-
required booking through `createWithAttachPlan` with an empty
services[]. The second is cheaper to ship.

---

### P1-5. `TicketService.reassign` — tickets + routing_decisions + activity

`apps/api/src/modules/ticket/ticket.service.ts:1375-1394+`.

Post-cutover note: `TicketService.update` goes through
`update_entity_combined` RPC. But `reassign` (the routing-decision
write path) is still separate: line 1375 updates `tickets`, 1382
inserts `routing_decisions`, then `addActivity` writes
`ticket_activities`.

**Severity:** P1 — reassign is a routing audit event; missing
`routing_decisions` row hides why a ticket was reassigned.

**Fix:** add `reassign_ticket_rpc(ticket_id, target, reason)` —
mirror `set_entity_assignment` (00327) but with the routing-decision
+ activity emission baked in.

---

### P1-6. `BundleService` — orchestration writes via shadow trigger

`apps/api/src/modules/booking-bundles/bundle.service.ts:1620-2050+`.

Several flow paths call `resolve_menu_offer` and `bookings_with_orders
_for_tenant` RPCs (read-side), but the line-write paths in
`attachServicesToBooking` (legacy) and `addLinesToBundle` use direct
TS inserts. The CLAUDE.md mandate calls out
`create_booking_with_attach_plan` as the canonical write; the
shipped behaviour is that the canonical path is used for `create`,
but `addLinesToBundle` (post-create line additions) still goes
through TS.

**Severity:** P1 — only hits when users add lines to an existing
booking; less hot than the create path.

**Fix:** `attach_lines_to_booking_rpc` — accept the booking_id +
attach_plan, run the same body as `create_booking_with_attach_plan`'s
service-attach branch.

---

### P1-7. Smoke gates exist only for B.2/B.4 RPCs

Smoke probes today:
- `smoke-work-orders` — `update_entity_combined` for work orders
- `smoke-tickets` — `update_entity_combined` for cases
- `smoke-edit-booking` — `edit_booking` (00364)
- `smoke-edit-booking-scope` — `edit_booking_scope` (00371)
- `smoke-floor-plans` — `publish_floor_plan_draft` (00400)
- `smoke-outbox` — round-trip from create_booking → outbox →
  setup-work-order handler

Missing smoke probes (per CLAUDE.md "live-API integration probes that
mint a real Admin JWT and exercise the running dev server"):
- `dispatch_child_work_order` / `dispatch_child_work_orders_batch` —
  hot path, has typed idem-key builder, no live probe.
- `grant_booking_approval` / `grant_ticket_approval` — has typed
  builder, no probe.
- `create_ticket_with_automation` — has typed builder, no probe.
- `create_booking_with_attach_plan` — partially covered by
  smoke-outbox; covers happy path with services only.
- `reclassify_ticket` — has typed builder, no probe.

**Severity:** P1 — when a refactor lands that breaks any of these
RPCs at the integration boundary (RLS, signature drift, fk-validation
helper rename), the jest specs pass (mocked supabase) and the
unrelated smoke gates pass. Same failure class the CLAUDE.md doc
calls out for Slice 3.1 + 2026-05-01 P0.

**Fix:** add `smoke-dispatch`, `smoke-approval-grant`, `smoke-create-
ticket`, `smoke-create-booking-attach-plan`, `smoke-reclassify`.
Mechanical work; pattern is fixed.

---

## P2 — design quirks; not actively breaking

### P2-1. Outbox `OutboxService.emit()` has zero callers

`apps/api/src/modules/outbox/outbox.service.ts:21-59`.

The class itself documents "zero callers in non-test code (verified
2026-05-04)". Producer emits all happen inside RPC bodies via
`outbox.emit()` SQL function. The TS class survives only because spec
§11 open question 4 keeps it.

**Severity:** P2 — dead code + a "deprecated" class anyone could
inadvertently re-introduce as a "best-effort" emit. Should be deleted
per spec §16.1 cleanup, or the cleanup deferred should land.

**Fix:** delete the class once §16.1 cleanup is scheduled; for now
strengthen the @deprecated tag + add a CI grep gate.

---

### P2-2. `command_operations` `outcome` enum doesn't model `'failed'`

`supabase/migrations/00316_command_operations_table.sql:36-37`.

Outcome is `('in_progress', 'success')` only — the migration comment
says `'failed'` rows roll back with the tx (which is correct for
RPC-side failures). The hazard: a TS-side caller could in theory write
the in_progress row, raise, leave the row as `in_progress` if the
catch path swallows the error. Today no TS caller writes
command_operations directly (they all go through RPCs), but if a
future caller does, in_progress rows would accumulate.

**Severity:** P2 — defensive only; no live exposure.

**Fix:** add a janitor that prunes `in_progress` rows older than 5
minutes (`pg_cron` or a Nest scheduled task). Or document the
"in_progress rows older than X are presumed orphaned" rule.

---

### P2-3. `EditBookingOp` discriminator widening — partial back-compat

`packages/shared/src/idempotency.ts:374-382`.

`buildEditBookingIdempotencyKey` accepts an optional `op` — when
absent, mints a key that callers from before Step 2F.3 used. Comment
says "the 2-arg legacy shape is retained ONLY so historical fixtures
and smoke probes that pre-date Step 2F.3 keep compiling." That's a
silent-collision risk: a forgotten legacy caller passing the 2-arg
shape can collide with a 3-arg call from a different op against the
same booking.

**Severity:** P2 — narrow exposure (only matters if a stale caller
exists post-2F.3).

**Fix:** grep for `buildEditBookingIdempotencyKey(` and assert every
live call site passes `op`. Once verified, make `op` required.

---

### P2-4. Workflow `update_ticket` allowlist rejects 17 orphan fields

`apps/api/src/modules/workflow/workflow-engine.service.ts:1104-1194`.

The Step 9 cutover tightened the workflow-engine `update_ticket` node
to the 14 fields `update_entity_combined` supports. A pre-Step 9
workflow definition with any of the 17 orphan fields now throws
`workflow.update_ticket_field_not_allowed` at execution time —
NOT at workflow-definition save time. So an admin saves a workflow
that's broken at runtime.

**Severity:** P2 — pre-prod risk; memory says no production tenant
depends on this yet.

**Fix:** add a workflow-definition validator that rejects unsupported
fields at save time. Mirrors what
`workflow.update_ticket_field_not_allowed` currently throws.

---

## P3 — nits / housekeeping

### P3-1. Best-effort `audit_events.insert` everywhere

Many services swallow audit failures in `try { } catch { }`. That's
correct for never-block semantics, but means audit gaps go unnoticed.
Combine with the outbox plan from spec §3.1: domain-significant audit
events should be in-tx; visibility/compliance audits can stay
best-effort.

Files: order.service.ts:1334+, recurrence.service.ts:857+/959+,
booking-flow.service.ts:1205+, reservation.service.ts:462+/504+/583+,
check-in.service.ts:109+/224+, invitation.service.ts:261+,
visitors/visitor.service.ts:362, etc.

**Severity:** P3 — most are correctly "won't roll back the user-
visible mutation if audit fails." Improvement: emit them through
outbox.emit() inside the canonical RPC instead, so they're in-tx for
the operations that already use the canonical RPC.

---

### P3-2. Three different idempotency prefixes for similar operations

`packages/shared/src/idempotency.ts` defines:
- `PATCH_IDEMPOTENCY_KEY_PREFIX = 'patch'`
- `DISPATCH_IDEMPOTENCY_KEY_PREFIX = 'dispatch'`
- `DISPATCH_BATCH_IDEMPOTENCY_KEY_PREFIX = 'dispatch_batch'`
- `WORKFLOW_ASSIGNMENT_IDEMPOTENCY_KEY_PREFIX = 'workflow:assignment'`
- `WORKFLOW_UPDATE_TICKET_IDEMPOTENCY_KEY_PREFIX = 'workflow:update_ticket'`
- `CREATE_TICKET_IDEMPOTENCY_KEY_PREFIX = 'create:ticket'`
- `RECLASSIFY_IDEMPOTENCY_KEY_PREFIX = 'reclassify'`
- `APPROVAL_GRANT_IDEMPOTENCY_KEY_PREFIX = 'approval:grant'`
- `EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX = 'booking:edit'`

That's correct — separate prefixes prevent cross-RPC collisions in the
shared `command_operations` (tenant_id, idempotency_key) keyspace.
The hazard: there's no central registry that says "all prefixes ever
used must be listed here", so a future RPC could pick a colliding
prefix. (Same risk class as the role-permission catalog.)

**Severity:** P3.

**Fix:** add a `const ALL_IDEMPOTENCY_KEY_PREFIXES = [...] as const` +
a jest test asserting every `BUILD_X` helper uses a prefix in the
list. Pattern lifted from `permissions.ts` catalog enforcement.

---

## Mutation matrix

| Mutation | Tables touched | Boundary | Idempotency | Outbox same-tx? | Risk |
|---|---|---|---|---|---|
| Create case (with automation) | tickets + ticket_activities + outbox.events + (workflow_instances) | RPC `create_ticket_with_automation` (00349/00351) | command_operations + `create:ticket:<actor>:<crid>` | yes | OK |
| Update case (combined) | tickets + ticket_activities + sla_timers + outbox.events | RPC `update_entity_combined` (00335) | command_operations + `patch:case:<id>:<crid>` | yes | OK |
| Update work order (combined) | work_orders + ticket_activities + sla_timers + outbox.events | RPC `update_entity_combined` (00335) + 00384 plan_version lock | command_operations + `patch:work_order:<id>:<crid>` | yes | OK |
| Dispatch child WO | work_orders + routing_decisions + sla_timers + ticket_activities | RPC `dispatch_child_work_order` (00336/00338) | command_operations + `dispatch:<parent>:<crid>` | yes | OK |
| Dispatch child WO batch | as above × N | RPC `dispatch_child_work_orders_batch` (00337/00339/00342) | command_operations + `dispatch_batch:<parent>:<crid>` | yes | OK |
| Reclassify ticket | tickets + ticket_activities + routing_decisions + outbox | RPC `reclassify_ticket` (00354/00355) | command_operations + `reclassify:<id>:<crid>` | yes | OK |
| Grant ticket approval | approvals + tickets + sla_timers + outbox | RPC `grant_ticket_approval` (00356/00357) | command_operations + `approval:grant:<id>:<crid>` | yes | OK |
| Grant booking approval | approvals + bookings + booking_slots + outbox (+ setup-WO emit) | RPC `grant_booking_approval` (00310) + `approve_booking_setup_trigger` (00311) | advisory_xact_lock (00310:92) — NO command_operations key visible in TS layer | yes | OK (atomic) but no replay cache; double-grant is via CAS at the SQL level |
| Set entity assignment | tickets/work_orders + ticket_activities + outbox | RPC `set_entity_assignment` (00326/00327) | command_operations + `workflow:assignment:<wf>:<node>:<id>` (from WF) / `patch:...:<crid>` (from controller) | yes | OK |
| Transition entity status | tickets/work_orders + ticket_activities + outbox | RPC `transition_entity_status` (00325) | command_operations via outer combined RPC | yes | OK |
| Update entity SLA | tickets/work_orders + sla_timers + ticket_activities + outbox | RPC `update_entity_sla` (00328/00330) | command_operations via outer combined RPC | yes | OK |
| Create booking (no services) | bookings + booking_slots + outbox (creation lifecycle 00372) | RPC `create_booking` (00277) — atomic; **+ TS-side `createApprovalRows` append** | NO command_operations on create_booking path | bookings creation only | **P1-4** TS approval append can fail silently |
| Create booking with services | bookings + booking_slots + orders + order_line_items + asset_reservations + approvals + outbox | RPC `create_booking_with_attach_plan` (00309) | attach_operations table (00302) + `booking.create:<actor>:<crid>` | yes | OK |
| Edit booking (single occurrence) | bookings + booking_slots + outbox | RPC `edit_booking` (00361/00362/00364/00394) | command_operations + `booking:edit:one|slot:<id>:<crid>` | yes | OK |
| Edit booking scope (recurrence) | bookings × N + booking_slots × N + outbox | RPC `edit_booking_scope` (00367/00371/00395) | command_operations + `booking:edit:scope:<id>:<crid>` | yes | OK |
| Cancel booking (single) | booking_slots + bookings + audit_events + (cascade) | TS sequence in `ReservationService.cancel` | NONE | NO | **P1-3** |
| Cancel recurrence forward | bookings × N + booking_slots × N + orders cascade × N + recurrence_series + audit_events | TS sequence in `RecurrenceService.cancelForward` | NONE | NO | **P0-4** |
| Split recurrence series | recurrence_series + bookings × N + recurrence_series + audit_events | TS sequence in `RecurrenceService.splitSeries` | NONE | NO | **P0-4** |
| Cancel bundle line | asset_reservations + work_orders + order_line_items + approvals + audit_events + bundle_event_bus | TS sequence in `BundleCascadeService.cancelLine` | NONE | NO | **P0-3** |
| Cancel bundle | as above × N | TS sequence in `BundleCascadeService.cancelBundle` | NONE | NO | **P0-3** |
| Create standalone order | bookings + orders + asset_reservations × N + order_line_items × N + approvals × N + audit + outbox emissions | TS sequence + `StandaloneCleanup` compensator | NONE | NO | **P0-2** |
| Override/skip/revert line | order_line_items + audit | single-table | NONE | NO | low; single-table |
| Visitor invitation create | visitors + visitor_hosts × N + visit_invitation_tokens + approvals + audit + domain_events | TS sequence | NONE | NO | **P0-5** |
| Kiosk walk-up register | persons + visitors + visitor_hosts + transitionStatus (extra tables) | TS sequence | NONE | NO | **P0-6** |
| Workflow approval node | approvals × N + workflow_instances | TS loop | NONE | NO | **P0-1** |
| Workflow notification node | notifications | single-table; TS | NONE | NO | low |
| Workflow create_child_tasks | dispatch_child_work_orders_batch | RPC delegation (good) | dispatch idem key | yes | OK |
| Publish floor plan draft | floor_plans + floor_plan_history + spaces fixtures | RPC `publish_floor_plan_draft` (00399/00400) | RPC-internal advisory; no command_operations | partial (RPC writes audit_events) | OK (atomic; smoke probe exists) |
| Permission start SLA timers | tickets/work_orders + sla_timers | TS sequence in `SlaService.startTimers` | NONE | NO | **P1-2** |
| Reassign ticket | tickets + routing_decisions + ticket_activities | TS sequence | NONE | NO | **P1-5** |
| Add lines to bundle | bookings + orders + order_line_items + asset_reservations + approvals | TS sequence in `BundleService.addLinesToBundle` | NONE | NO | **P1-6** |
| Update role | roles + audit_events | TS sequence | NONE | NO | low; audit is best-effort |
| Create role assignment | user_role_assignments + audit_events | TS sequence | NONE | NO | low |
| Recurrence materialize tick | bookings + booking_slots + orders cascade × N + recurrence_series.materialized_through | mostly RPC (`create_booking`) + boundary-wrapped clone | `runWithCompensation` (legacy pattern) | partial | **P1**; cleanup queued (see memory) |
| Booking notifications fan-out | notifications | single-table | NONE | NO | low |
| Audit-style emits across modules | audit_events / domain_events | single-table best-effort | NONE | NO | nits (P3) |

---

## Highest-risk split writes (Node-crash partial-state)

Ranked by (visibility) × (frequency) × (recovery cost):

1. **OrderService.createStandalone** — P0; user-facing form; partial
   state is invisible to user but persistent.
2. **RecurrenceService.cancelForward / splitSeries** — P0; recurrence
   is bulk; partial state shows on the calendar.
3. **BundleCascadeService.cancelLine / cancelBundle** — P0; common
   cancel path on bundle-attached bookings.
4. **InvitationService.create** — P0; visitor flow is high-volume
   for tenants that use it; cancel-link broken if partial.
5. **WorkflowEngineService approval node** — P0; lower frequency
   today (memory says workflows aren't widely used yet) but the
   failure mode is approval-decision corruption.
6. **KioskService.walkUp** — P0; lower frequency for now but the
   anonymous path has no UI recovery.
7. **ReservationService.cancel / restore** — P1; happens often but
   the partial-state window is narrow (2 updates + 1 audit).
8. **BookingFlowService.createApprovalRows** — P1; silent stuck-
   booking class; appears only on approval-required bookings.
9. **SlaService.startTimers** — P1; only on ticket creation; partial
   state hides ticket from breach scan.

---

## RPC consolidation plan with sequence

Recommended slice ordering — each is an independent ship.

### Slice X.1 — cancel paths
1. `cancel_booking_rpc` (atomic; mirrors edit_booking shape)
2. `restore_booking_rpc` (atomic)
3. `cancel_recurrence_forward_rpc` (atomic over N bookings)
4. `split_recurrence_series_rpc` (atomic)
5. `cancel_bundle_line_rpc` + `cancel_bundle_rpc` (atomic over N lines)
6. Smoke probe `smoke-cancel-paths.mjs` covering all six.

**Closes:** P0-3, P0-4, P1-3.

### Slice X.2 — visitor + kiosk register
1. `create_visitor_invitation_rpc` — combines visitors / visitor_hosts /
   visit_invitation_tokens / approvals / outbox.emit (cancel-token email)
   in one tx.
2. `walkup_visitor_register_rpc` — combines persons.upsert (visitor type) /
   visitors / visitor_hosts / transition (arrival) in one tx.
3. Smoke probe `smoke-visitor-register.mjs`.

**Closes:** P0-5, P0-6.

### Slice X.3 — standalone orders
1. `create_standalone_order_with_attach_plan` — reuse
   `create_booking_with_attach_plan` body with `slots: []`.
2. Retire `StandaloneCleanup` class.
3. Smoke probe extends `smoke-outbox-roundtrip` to also cover services-
   only path.

**Closes:** P0-2.

### Slice X.4 — workflow approval node
1. `start_workflow_approval_node_rpc(instance_id, node_id, approvers[],
   threshold)` — atomic N-row insert + workflow_instances flip.
2. Smoke probe extending `smoke-workflow-engine` (new probe).

**Closes:** P0-1.

### Slice X.5 — residual P1 services
1. Add `approvers[]` to `create_booking` RPC (00277) signature; retire
   TS `createApprovalRows`. **Closes P1-4.**
2. Route `SlaService.startTimers` through `update_entity_sla`. **Closes
   P1-2.**
3. `reassign_ticket_rpc`. **Closes P1-5.**
4. `attach_lines_to_booking_rpc`. **Closes P1-6.**
5. `serialize_approval_rescope_rpc` to replace
   `OrdersApprovalRouting.upsertWithRetry`. **Closes P1-1.**

### Slice X.6 — smoke gate fill-in
1. `smoke-dispatch`, `smoke-approval-grant`, `smoke-create-ticket`,
   `smoke-create-booking-attach-plan`, `smoke-reclassify`.
2. Add them to the `pnpm smoke:*` matrix; document under
   `docs/smoke-gates.md`.

**Closes:** P1-7.

### Slice X.7 — housekeeping (P2/P3)
1. Delete `OutboxService` once spec §16.1 cleanup is scheduled.
2. Make `EditBookingOp` discriminator required after audit.
3. Workflow-definition save-time validator for unsupported fields.
4. `command_operations` janitor for stale `in_progress` rows.
5. `ALL_IDEMPOTENCY_KEY_PREFIXES` constant + CI gate test.

---

## Idempotency scope issues

### Too-broad scopes — NONE found in current code

The B.2.A retro caught all the wide-scope hazards already
(F-CRIT-1 actor-removed-from-key, F-CRIT-2 dispatch-actor-removed,
Step 2F.3 op-in-key fix that distinguishes editOne / editSlot /
editScope under the same booking_id + clientRequestId). Today the
keys are correctly scoped:

- `booking:edit:<op>:<id>:<crid>` — op-discriminated; safe across
  surfaces.
- `dispatch:<parent>:<crid>` vs `dispatch_batch:<parent>:<crid>` —
  separate prefixes; safe.
- `workflow:assignment:<wf>:<node>:<id>` — workflow-+ node-+ entity-
  scoped; replay-safe across engine restarts.
- `workflow:update_ticket:<wf>:<node>:<id>` — same.
- `approval:grant:<approval>:<crid>` — approval-scoped; cross-actor
  retries collapse correctly per the helper docstring.
- `create:ticket:<actor>:<crid>` — actor-scoped (the create path's
  one exception, and correctly so: user A double-submit is one retry;
  user B same crid is coincidence).
- `reclassify:<ticket>:<crid>` — ticket-scoped.

### Too-narrow scopes — NONE found that are wrong

`create:ticket` uses actor in the key, which is correct (see helper
docstring). Every other key omits actor, per F-CRIT-2 reasoning. Good.

### Missing scopes — many

Every operation flagged in P0 / P1 above has NO idempotency key. That
means a React Query retry hits the underlying TS sequence again from
scratch. For idempotent operations (cancel) the duplicate write is a
no-op (good); for non-idempotent operations (create visitor,
createStandalone) it duplicates rows (bad). Slices X.1 through X.5
fix this systematically.

---

## Outbox / audit / inbox same-tx audit

### Same-tx (good)
- Every B.0.D / B.2 / B.4 RPC uses `outbox.emit(...)` SQL helper
  inline; emission is in the same tx as the domain write. Tx rolls
  back ⇒ emission rolls back. No leaked notifications, no missed
  notifications.
- `create_booking_with_attach_plan` (00309), `grant_booking_approval`
  (00310), `approve_booking_setup_trigger` (00311),
  `transition_entity_status` (00325), `set_entity_assignment`
  (00326/00327), `update_entity_combined` (00335), and the create-
  ticket / reclassify / dispatch family all emit in-tx (grep above).

### Best-effort post-commit (acceptable for now)
- `OutboxService.emit()` (TS) — survives as a fire-and-forget surface
  with zero callers. If/when a caller appears, it's not in the
  business tx and a failure swallows silently. Spec §3.2 already
  flags this as the design.
- Per-module `audit_events.insert` from TS — best-effort try/catch
  pattern. Acceptable: audit failure shouldn't block user mutations.

### Broken (P0/P1 above)
- Every TS-sequence service from P0/P1 emits its audit / domain_events
  / outbox-shaped row OUTSIDE the business write. They're all
  best-effort. The hazard isn't the audit row itself — it's that the
  business write is non-atomic so the audit can be "correctly" written
  for a half-completed cascade.

### Inbox
- `inbox_notifications_realtime` + `inbox_notifications_triggers`
  (00401/00402) — DB-side triggers fire on the canonical write tables
  (approvals, tickets, etc.). Because they're triggers, they're
  inherently same-tx as the domain write. Safe.

---

## Advisory locks / row locks

### Used correctly
Every canonical RPC takes `pg_advisory_xact_lock(hashtextextended
(tenant_id::text || ':' || idempotency_key, 0))` BEFORE the
command_operations gate. Two simultaneous identical requests serialize
correctly:
- 00309 line 88 (create_booking_with_attach_plan)
- 00310 lines 92 + 158 (grant_booking_approval — two locks: outer +
  per-booking)
- 00325 line 98 (transition_entity_status)
- 00328 line 134 / 00330 line 112 (update_entity_sla)
- 00331 line 212 (update_entity_combined)
- 00336 line 207 (dispatch_child_work_order)
- 00337 line 109 / 00339 line 102 / 00342 line 101 (dispatch batch
  versions)
- 00349 line 168 / 00351 (create_ticket_with_automation)
- 00354 line 157 / 00355 (reclassify_ticket)
- 00356 line 185 / 00357 (grant_ticket_approval)
- 00361 line 309 / 00362 line 298 / 00364 line 375 / 00394 line 307
  (edit_booking versions)
- 00367 line 277 / 00371 line 249 / 00395 line 245 (edit_booking_scope
  versions)

00384 added an authoritative `SELECT FOR UPDATE` on
`work_orders.plan_version` inside `update_entity_combined` to close
the race the TS pre-check couldn't catch. Good defensive layering.

### Pre-canonical triggers using advisory_xact_lock
- `org_nodes` cycle trigger (00082)
- `work_orders` parent-close guard (00324)
- Reclassify support (00044, 00046)

All correct — they lock on (tenant_id) or (parent_id) keys that
serialize concurrent producers.

### Missing
Every P0/P1 TS-sequence service. They couldn't take a Postgres
advisory lock if they wanted to; they don't have a transaction. Moot
until they move to RPCs.

---

## Summary scoreboard

- **PL/pgSQL RPCs:** ~22 canonical write RPCs + many helpers; all
  correctly atomic + idempotent + outbox-emitting + advisory-locked.
- **TS-sequenced multi-table writes remaining:** ~12 services
  catalogued above as P0 / P1.
- **`command_operations` coverage:** 9 idempotency-key families
  (patch / dispatch / dispatch_batch / workflow:assignment /
  workflow:update_ticket / create:ticket / reclassify /
  approval:grant / booking:edit). All correctly scoped.
- **Smoke probes:** 6 (work_orders, tickets, edit_booking,
  edit_booking_scope, floor_plans, outbox-roundtrip). 5+ missing
  (dispatch, approval-grant, create-ticket, create-booking-attach-
  plan, reclassify; plus the proposed cancel-paths / visitor-register
  / standalone-order probes once those RPCs ship).
- **Legacy compensation pattern (BookingTransactionBoundary +
  BookingCompensationService):** still wired up; called from
  `RecurrenceService.materialize` clone path; CLAUDE.md says Phase 6
  retires it. Not actively wrong (the clone is a single write
  bracketed by deleteBooking on error), but it's a smell.
- **Same-tx outbox emits:** 100% on canonical RPC paths; 0% on TS-
  sequence paths.

The audit's recommendation: ship slices X.1–X.5 in order. Each closes
a specific P0/P1 cluster; each is independently verifiable; the
pattern is already proven by B.2/B.4.

— end of audit —

---

## Closure Ledger

Maintainer rule: every agent that closes, partially closes, or deliberately defers a finding from this RPC/transaction audit must update this ledger in the same change. Do not rely on chat history as the record of truth. Add concrete evidence: changed files, migration numbers, tests/smokes run, and any residual risk.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/05-rpc-transactions.md` | Not run | All findings remain open unless a later row says otherwise. |

## Agent Handoff Prompt

```text
You are the lead RPC/transaction-boundary remediation agent for:
docs/follow-ups/audits/05-rpc-transactions.md

Goal:
Close every actionable transaction-boundary and idempotency finding in this audit. Own the whole file, but land the work as small slices. The end state is that every multi-table write where partial state is corrupting is a single Postgres RPC or has a documented, low-risk exception.

Read first:
- AGENTS.md / CLAUDE.md
- docs/follow-ups/audits/05-rpc-transactions.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/superpowers/specs/2026-05-04-domain-outbox-design.md
- packages/shared/src/idempotency.ts
- supabase/migrations/00309 through latest canonical RPCs
- apps/api/scripts/smoke-*.mjs

Recommended slice order:
1. Workflow approval node: add a transactional RPC for N approval rows + workflow waiting-state update.
2. Standalone order create: replace TS cleanup/compensation with a combined RPC or reuse the attach-plan pattern.
3. Booking bundle line/bundle cancellation: move multi-table cascades into RPCs.
4. Recurrence cancel/split: add transactional RPCs and idempotency.
5. Visitor invitation and kiosk walk-up: replace multi-insert TS sequences with RPCs or an equivalent transactional boundary.
6. Booking user-cancel path: coordinate with the booking audit so `cancel_booking_with_cascade` is implemented once.
7. Add or extend smoke tests for each new RPC family.
8. Retire obsolete TS outbox/compensation helpers only after the last caller is removed.

Execution rules:
- Before editing, build a matrix: mutation -> tables written -> current boundary -> idempotency key -> audit/outbox behavior -> target boundary.
- Work one mutation family at a time.
- Do not invent a second idempotency mechanism. Use `command_operations` or the existing domain-specific operation table pattern where already established.
- Every RPC must tenant-validate every FK-bearing input and lock rows in deterministic order.
- Use parallel agents only for read-only inventories or disjoint mutation families.
- Do not push/apply migrations remotely without explicit user approval.

Required closure behavior:
- Update this file's Closure Ledger after every slice.
- Update idempotency docs/constants when new key prefixes are introduced.
- Update smoke docs when a new mandatory probe is added.
- Record migration numbers, tests/smokes run, and residual risk.

Completion bar:
- No P0 TS-sequence multi-table write remains without an explicit deferred rationale.
- New RPCs are idempotent, tenant-safe, and emit audit/outbox/inbox rows in the same transaction where required.
- Smoke coverage exists for the high-risk RPC families or is explicitly tracked with owner and deadline.
```
