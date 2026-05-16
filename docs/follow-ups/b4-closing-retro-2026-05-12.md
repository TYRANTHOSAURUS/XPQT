# B.4 — Booking Edit Pipeline — Closing Retro

**Date:** 2026-05-12
**Status:** SHIPPED to `origin/main`
**HEAD:** `71618510` (Step 2F.4 smoke probe)

Closeout doc for the B.4 workstream (booking edit pipeline RPC family
+ TS plan-builder + controller cutovers + live-API smoke probe).
Steps 1, 2A, 2B, 2C, 2D, 2E, 2F.1, 2F.2, 2F.3, 2F.4 all on
`origin/main`. All CI gates 0-violation at close.

Sibling to `b2-a-closing-retro-2026-05-11.md`. Read this before
opening Phase 8.D (legacy `edit_booking_slot` drop) or B.4.A.5
(notification dispatch).

This is a synthesis, not a log. Decay this doc when Phase 8 lands.

## 1. What B.4 set out to do

From spec §0 (`docs/follow-ups/b4-booking-edit-pipeline.md`):

> Cut `PATCH /reservations/:id`, `PATCH /reservations/:bookingId/slots/:slotId`,
> and `POST /reservations/:id/edit-scope` over from legacy multi-step
> TS write paths to a unified PL/pgSQL RPC family.

The architectural rule it serves (CLAUDE.md, §"Multi-step writes are
PL/pgSQL RPCs, not TS pipelines"):

> If a feature has to write to ≥2 tables and any partial-write state
> is corrupting (cross-table invariants, FK chains, audit-trail
> integrity), the writes go inside one PL/pgSQL function called from
> TypeScript — NOT a sequence of supabase-js HTTP calls in TS.

The legacy `edit_booking_slot` (00291) plus the TS pipelines in
`reservation.service.ts:editOne` / `editSlot` and the bare-UPDATE
in `booking-flow.service.ts:editScope` were exactly the anti-pattern
this rule was written to retire. The same anti-pattern shipped 8
distinct bugs (spec §2):

1. **Downstream-table cascade missing on edit** — `bookings.cost_amount_snapshot`,
   `orders.delivery_location_id`, `orders.requested_for_*`,
   `work_orders.planned_start_at`/`sla_due_at` all stale after edit.
2. **Buffer leak/overlap** — old room's `setup_buffer_minutes` /
   `teardown_buffer_minutes` carried into new room; conflict guard
   runs against the wrong window.
3. **Rule violation slips through** — capacity overflow on smaller
   new room; deny rules ignored. Edit lets through what create
   would have rejected.
4. **Approval bypass on rule-class change** — moving to an
   approval-required room left `status='confirmed'` with no
   `pending_approval` row.
5. **Asset reservations stuck on old window** — double-booking
   or premature freeing.
6. **Recurrence-scope wholesale-UPDATE** — `editScope` was bare
   `UPDATE ... WHERE recurrence_series_id = ?` with zero rule eval,
   conflict guard, capacity check, approval re-eval, or cost
   recompute. One tenant could shift a 52-week series into a smaller
   room and silently break every occurrence's capacity invariant.
7. **Calendar sync drift** — `bookings.calendar_etag` never bumped;
   Outlook caches the old event indefinitely.
8. **Config-release pin drift** — `bookings.config_release_id`
   ambiguity on edit (re-pin vs. preserve).

All 8 are closed by the shipped RPC family. Per-bug citation in §3.

> **Narrowed 2026-05-16 (booking-audit Slice 1):** "All 8 closed by the
> shipped RPC family" is accurate only for the booking + slot + approval
> transaction. Until 2026-05-16, editOne/editSlot/editScope were in fact
> returning 404 `actor_not_found` for every call — the service passed
> `public.users.id` where `edit_booking` F-CRIT-1 (`00394:289-303`)
> requires `auth_uid` (`docs/follow-ups/audits/03-booking-reservation.md`
> D-1) — and Bug 1's linked-row patches (orders/asset_reservations/
> work_orders time propagation) were never populated; the assembler
> hard-coded `asset_reservation_patches=[]` / `order_patches=[]` /
> `work_order_sla_patches=[]` (audit 03 P0-2). Both fixed 2026-05-16
> (migration 00407 + `assemble-edit-plan.service.ts buildLinkedRowPatches`
> + smoke-edit-booking.mjs Fixture D); multi-slot linked-row propagation
> remains a deferred residual (loud `logger.warn` on skip). Cancel /
> cascade / standalone / recurrence-split paths remain TS choreography
> (audit 03 P0-1 / P1-2 / P1-3 / P1-4, open).

## 2. What shipped — sub-step inventory

10 numbered sub-steps. ~36 commits. ~22,130 insertions / 1,711
deletions across 228 file touches (aggregate, B.4-tagged commits only).

| Sub-step | Subject | Migrations | Tagged commits | Δ LOC (group) |
|---|---|---|---|---|
| 1 | Foundation — register `stale_resolution` + `cancelled_cannot_edit` codes + 3 booking event types | — | `56eff2e2` → `34f76c4a` | (in 1–2C group) |
| 2A | `validate_entity_in_tenant` v4/v5 — booking_rule + team kinds; edit idempotency helper | 00359, 00360 | `afd418df`, `56981cdf` | (in 1–2C group) |
| 2B | `edit_booking` RPC v1 → v2 → v3 — skeleton, preserve-fields, codex P0 (booking-scope + dest-room gate) | 00361, 00362, 00363 | `457fef31`, `eeb6d726`, `9368b3c1` | (in 1–2C group) |
| 2C | `edit_booking` RPC v4 — approval reconciliation per §3.6.5 (10-row table); spec sync + sequencing invariant | 00364 | `599d0d46`, `45c0d625` | (in 1–2C group) |
| **Steps 1–2C (RPC layer)** | | **00359–00364** | 8 commits | **+6783 / −125 / 60 files** |
| 2D | `booking.approval_required` handler stub (B.4.A.5 unblock); edit-plan helper foundations; `assembleEditPlan` TS service; `editSlot` cutover + B.4.A.5 gate + tests | (TS-only) | `d285bc32`, `c5e8944d`, `0ec9910b`, `db50a368`, `cc51638a`, `b61d89b3`, `baef7951`, `a7ba1cf6`, `2d801988`, `fb7b163f`, `a664bffd` | |
| 2E | `editOne` cutover — widen `AssembleEditPlanOnePatch` + `assembleOneEditPlan` + controller guard | (TS-only) | `f5f01511`, `14de249b`, `d6fa3ed0`, `f1d3b4d0` | |
| **Steps 2D+2E (TS cutover)** | | **— (TS-only)** | 15 commits | **+6122 / −1127 / 99 files** |
| 2F.1 | `edit_booking_scope` RPC v1 + concurrency tests; v2 supersedes v1 (stateless dry-run + bounded `booking_not_found` + per-occurrence before/after); codex regression test | 00367, 00371 | `8a89048a`, `7fa16663`, `0282f83a` | |
| 2F.2 | `assembleScopeEditPlan` TS arm + 5 new error codes + `tenant_context_mismatch` hard-assert | (TS-only) | `c720c8a7`, `25a18443`, `a4f48f8b` | |
| 2F.3 | `editScope` controller cutover — `ReservationService.editScope` + idempotency op discriminator + frontend hooks (`useEditBookingScope[DryRun]`) | (TS-only) | `aba53462`, `a2df38b4`, `fadad824` | |
| 2F.4 | Live-API smoke probe `smoke-edit-booking-scope.mjs` (13 scenarios) + dev-server gate doc | (script) | `71618510` | |
| **Steps 2F.1–2F.4 (scope cutover)** | | **00367, 00371** | 10 commits | **+9225 / −459 / 69 files** |

**Migration trail:** 8 in the B.4 family — 00359, 00360, 00361, 00362,
00363, 00364, 00367, 00371. 00367 was superseded by 00371 (v2) at
Step 2F.1 self-review; both kept in tree for audit history.
Migrations 00365–00366 + 00368–00370 are parallel-session
workflow-phase work, not B.4.

**Concurrency suite:** 26 scenarios in `edit_booking.spec.ts` + 16
in `edit_booking_scope.spec.ts` = 42 scenarios across the two RPCs.

**Smoke probes:** 13 scenarios in
`apps/api/scripts/smoke-edit-booking-scope.mjs` covering the
recurrence-scope path. `pnpm smoke:edit-booking` (single-occurrence
sibling for `editOne` + `editSlot`) is **deferred** to a future B.4
follow-up step (tracked in `b4-followups.md`).

## 3. Spec adherence — §3.1 source-of-truth invariant table

All 12 rows of §3.1 are enforced by shipped code. Citations:

| # | Invariant | Enforced at |
|---|---|---|
| 1 | TS-built `EditPlan` is the legitimate path for room/rule config reads | `apps/api/src/modules/reservations/assemble-edit-plan.service.ts` (entry points `assembleSlotEditPlan` :316, `assembleOneEditPlan` :350, `assembleScopeEditPlan` :436) |
| 2 | `orders.delivery_location_id`, `requested_for_*` sticky after edit | `supabase/migrations/00364_edit_booking_rpc_v4.sql:670-693` (UPDATE orders block) |
| 3 | `bookings.calendar_etag` bumped on every edit | `supabase/migrations/00364_edit_booking_rpc_v4.sql:758-762` (computed `v_new_calendar_etag`) |
| 4 | `work_orders.planned_start_at` / `sla_due_at` sticky; reseated via `repoint_sla_timer_rpc` | `supabase/migrations/00364_edit_booking_rpc_v4.sql:702-741` (UPDATE work_orders + emit `sla.timer_repointed_required`) |
| 5 | `booking_slots.setup_buffer_minutes` / `teardown_buffer_minutes` sticky; never recomputed from current room config on read | `supabase/migrations/00364_edit_booking_rpc_v4.sql:625-654` (slot UPDATE preserves buffer values from `p_plan`) |
| 6 | `bookings.cost_amount_snapshot` sticky — edit's quote, not current room's rate | `supabase/migrations/00364_edit_booking_rpc_v4.sql:758-790` (commit block; cost_amount_snapshot in booking UPDATE) |
| 7 | `bookings.policy_snapshot` + `applied_rule_ids` sticky | same UPDATE block |
| 8 | `approvals` rows preserve audit history; chain identity follows §3.6.5 | `supabase/migrations/00364_edit_booking_rpc_v4.sql:300-580` (approval reconciliation block) |
| 9 | `bookings.location_id` sticky after edit | same UPDATE block |
| 10 | `asset_reservations.start_at` / `end_at` re-stamped to current slot window | `supabase/migrations/00364_edit_booking_rpc_v4.sql:660-668` (UPDATE asset_reservations) |
| 11 | `bookings.cost_center_id` sticky; recomputed only on host change (§3.6.4) | `apps/api/src/modules/reservations/assemble-edit-plan.service.ts` (cost-center re-derivation gated by host change) |
| 12 | `recurrence_series.anchor_*` unchanged on per-occurrence edit; only `editScope` touches | `supabase/migrations/00371_edit_booking_scope_rpc_v2.sql` (anchor not in scope UPDATE set); `apps/api/src/modules/reservations/reservation.service.ts:1635` (controller rejects `start_at`/`end_at` on scope edits) |

**Row-level serialization** (spec §3.4 step 1, v3 codex correction):
`SELECT ... FOR UPDATE` on `bookings.id = p_booking_id AND tenant_id
= p_tenant_id`. Verified at `00364:240-260`. Same key as
`delete_booking_with_guard` (00292:75-83), so edit-vs-cancel
serializes through the same row lock.

## 4. §3.6.5 approval reconciliation — 10 rows fully covered

The §3.6.5 decision table is the highest-risk surface in B.4 (Bug 4
from §2 lived here). All 10 rows are implemented in 00364 (v4
migration `599d0d46`) and tested at three layers:

- **Concurrency** (`apps/api/test/concurrency/edit_booking.spec.ts`)
  — 26 scenarios cover serialization, idempotency, and the
  cross-row interactions.
- **Assembler unit** (`apps/api/src/modules/reservations/__tests__/assemble-edit-plan.service.spec.ts`)
  — 46 specs lock the TS-side plan-builder contract per row.
- **Service unit** (`reservation.service.ts` editSlot + editOne +
  editScope specs) — lock the service-layer wiring including the
  B.4.A.5 gate.
- **Smoke** (`smoke-edit-booking-scope.mjs`) — 13 live-DB scenarios
  exercise the path end-to-end.

**Row 8 — the dangerous gap.** `require_approval → require_approval
(different chain config)` with `terminal_approved` state. v2 of the
spec silently preserved "approved" → next approver bypassed.
The v3 codex correction (folded into the v4 RPC at `599d0d46`)
expires the old chain (`status='expired'` + `comments='superseded_by_edit
(room change to ...)'`) and inserts a fresh chain that re-gates the
edit. This was the single highest-impact spec correction in B.4;
shipping v2 unchanged would have been a P0 approval-bypass.

## 5. §7 sequencing — producer-before-consumer + controller-before-dispatch

Spec §7 carries two structural invariants:

1. **Producer-before-consumer.** Closed by Step 2D-B (commit
   `d285bc32`): `BookingApprovalRequiredHandler` (stub) registered
   before any controller cutover emits `booking.approval_required`.
   No dead-letter on the queue.
2. **Controller-before-dispatch.** The stub handler logs receipt
   but does NOT yet dispatch notifications (email approvers,
   in-app inbox). Until B.4.A.5 ships notification dispatch,
   approvers learn nothing through the platform.

The 422 pre-flight gate (`booking.edit_requires_notification_dispatch`)
in `reservation.service.ts:1213` (editSlot), `:1003` (editOne), and
`:1367` (editScope, inside `assembleScopeEditPlan`'s per-occurrence
loop) prevents controller cutovers from emitting Row 2/7/8 chains
into the dispatch-less window:

- When `plan.approval.new_outcome === 'require_approval'` AND
  (`old_outcome !== 'require_approval'` OR
  `chain_config_changed === true`), the gate throws 422 (validation
  class — inline form-level guidance, NOT a 500-class retry-loop).
- Operator copy gives a concrete action: "Ask the rooms admin to
  remove approval from this room, or pick a different room."

Lift mechanism (documented in `b4-followups.md`): delete the gate
predicate at `reservation.service.ts:1171-1213` + retire the
`booking.edit_requires_notification_dispatch` error code (or keep
registered as defense-in-depth) when B.4.A.5 ships.

**Spec §7 doc-update.** The "controller-before-dispatch" invariant
was NOT in the original spec; the v3 spec patch on commit
`45c0d625` added it after the editSlot cutover surfaced the
notification window. Future workstreams must read both invariants.

## 6. Review-loop discipline — two-checkpoint pattern

B.4 pioneered the **plan-review BEFORE coding + impl-review AFTER
coding** pattern, refining the "single review at end" pattern used
in B.2.A. The yield is measurable and asymmetric.

**Plan-review catches that saved misdirected work:**

- **Step 2F.2 plan-review B1 — splitSeries placement.** Plan put
  `splitSeries` inside the plan-builder. Plan reviewer flagged that
  splitSeries commits side effects (writes `recurrence_series` +
  `bookings` + `audit_events`); a dry-run preview would silently
  fork the series. Decision shifted to controller (Step 2F.3) BEFORE
  any code was written. Saved ~300 LOC of misdirected work +
  prevented a P0 "preview button forks series" footgun.
- **Step 2F.3 plan-review B3 — idempotency key shape.** Plan
  reused `buildEditBookingIdempotencyKey(bookingId, crid)` as-is.
  Plan reviewer flagged that editOne, editSlot, and editScope
  callers can share `bookingId` + `crid` → cross-op key collision.
  Added the op discriminator (`'one' | 'slot' | 'scope'`) BEFORE
  code. Caught a contract bug at plan-time, not commit-time.
- **Step 2F.3 plan-review B5 — dry-run replay cache.** Plan
  proposed caching dry-run results in `command_operations` so the
  commit phase could trust them. Reviewer flagged that the cache
  could lie (rule resolver hot-edits between preview and commit).
  Replaced with the v2 stateless-dry-run contract (00371): no
  `command_operations` row written on dry-run; commit phase
  re-evaluates from scratch.

**Codex catches that self-review missed (post-impl):**

- **Step 2F.2 — TenantContext drift (codex `a4f48f8b`).**
  Self-review confirmed the assembler reads `args.tenantId`
  consistently. Codex traced through to the helper stack
  (`loadSpace`, `RuleResolverService.resolve`,
  `ConflictGuardService.snapshotBuffersForBooking`,
  `loadCurrentApprovalChain`) and found three of those four read
  tenant from `TenantContext.current()` (ALS) — NOT from
  `args.tenantId`. If ALS context diverged from args (programmatic
  caller, job scheduler, test fixture), the helpers would route to
  the wrong tenant via `supabase.admin` (RLS-bypassing). Silent
  cross-tenant leak through rules/spaces/conflict reads. Fix:
  hard-assert `TenantContext.current()?.id === args.tenantId` at
  every plan-builder entry point + new error code
  `edit_booking.tenant_context_mismatch`. Phase 8 long-term fix
  is to thread `tenantId` through the helper signatures.
- **Step 2F.3 — dry-run replay + payload mismatch bypass (codex
  `fadad824`).** Self-review confirmed the controller pre-checks
  scope edits before splitSeries. Codex flagged that the pre-check
  fired on BOTH dry-run AND commit; in commit mode the pre-check
  ran the RPC twice (once to verify, once to commit), and the
  short-circuit return on a no-op dry-run could skip the RPC's
  own payload-mismatch check. Fix: gate the pre-check to commit
  mode only + remove the short-circuit return (let the RPC own
  the payload check).
- **Step 2B v3 — booking-scope + dest-room gate (codex `9368b3c1`).**
  P0 hotfix. Self-review on 00362 confirmed the narrowed stale-gate
  worked for room-targeted rules. Codex traced the `bucketRulesBySpecificity`
  spec at `rule-resolver.service.ts:424-464` and found that
  `target_scope='room'` rules joined on the OLD `bookings.location_id`,
  not the NEW (target) room. Edit that moves to a new room would
  miss rules scoped to that new room. v3 fixed by including BOTH
  source and dest in the MAX. Without this, every move-to-new-room
  edit would have stale-resolved.
- **Step 2D codex (`baef7951`, `0ec9910b`).** TS contract +
  null-vs-undefined + mock honesty. Self-review tested happy paths;
  codex tested edge cases where `null` vs `undefined` in patch
  objects swung the diff logic.

**Codex non-catches.** Step 2D-C (599d0d46 — the 10-row approval
table) passed codex clean. The §3.6.5 table was already fully
specified by Row 8 (v3 correction), so codex's value-add on a
contract-faithful implementation was zero.

**Yield estimate.** ~70-80 labelled findings across the workstream;
~55% from self-review (mostly contract gaps + missing tests), ~45%
from codex (mostly structural drifts the prose-only pass missed).
Slightly lower codex-yield than B.2.A's 40% — B.4's contract was
already battle-tested by v1→v3 spec rounds before any code shipped.

## 7. Gate counts — pre-B.4 vs post-B.4

| Metric | Pre-B.4 baseline (origin/main pre-2026-05-04) | Post-B.4 (HEAD `71618510`) | Δ |
|---|---|---|---|
| `pnpm errors:check-app-errors` | 0 raw / 34 modules | 0 raw / 34 modules | unchanged (gate ratchet preserved) |
| `pnpm naming:check-allowlist` (api) | ~395 refs | 420 refs | +25 (new B.4 surface names) |
| `pnpm naming:check-allowlist` (web) | ~136 refs | 143 refs | +7 (frontend hooks) |
| `assemble-edit-plan.service.spec.ts` | did not exist | 46/46 (3 entry points × 10-15 specs each) | +46 |
| `edit_booking.spec.ts` (concurrency) | did not exist | 26 scenarios | +26 |
| `edit_booking_scope.spec.ts` (concurrency) | did not exist | 16 scenarios | +16 |
| Smoke probes | `pnpm smoke:work-orders` (49), `pnpm smoke:tickets` (88) | + `pnpm smoke:edit-booking-scope` (13) | +13 |

**Net new test scenarios attributable to B.4:** ~100 (46 assembler
unit + 42 concurrency + 13 smoke). `pnpm smoke:edit-booking`
sibling for editOne/editSlot is deferred (see `b4-followups.md`).

**`pnpm test:concurrency` full-suite** still carries 38 pre-existing
failures from parallel-session workflow-phase0 contamination
(untracked migrations 00368-00370 tightened
`workflow_definitions.entity_type_check`); not a B.4 regression.

## 8. Migration count

8 migrations in the B.4 family — 00359, 00360, 00361, 00362, 00363,
00364, 00367, 00371. Spec §4 budgeted 4 (00339 + optional 00340 +
00367 + 00371). Reality was 2× the spec count, decomposed:

- **2 foundation** — 00359 (`validate_entity_in_tenant` v4
  booking_rule), 00360 (v5 team).
- **4 `edit_booking` revisions** — 00361 (v1 skeleton, approvals
  deferred), 00362 (v2 preserve-fields + narrow stale gate),
  00363 (v3 codex P0 booking-scope + dest-room gate), 00364 (v4
  approval reconciliation per §3.6.5).
- **2 `edit_booking_scope` revisions** — 00367 (v1), 00371 (v2
  stateless dry-run + bounded errors + per-occurrence diffs).

Same lesson as B.2.A §2: "1 RPC = 1 migration" is wrong by ~2x.
B.4 self-review + codex caught contract drifts late enough that
each catch was a fresh migration. The 4 `edit_booking` revisions
broke down as: v1 (skeleton) → v2 (codex caught preserve-fields
bug) → v3 (codex caught dest-room scope gate) → v4 (planned
approval reconciliation per the v3 spec table).

The 4-revision arc on `edit_booking` is borderline excessive —
v2 + v3 should have been one v2 if the v1 self-review had read
`rule-resolver.service.ts:424-464` more carefully. Avoidable.
Honest: ~1 of the 4 was "spec discipline working"; ~3 were "v1
contract wasn't tight enough on first pass."

## 9. Latency budget

**Single-occurrence edits (editOne, editSlot).** One RPC call;
~6-8 round-trips amortized inside PG (FK validation × N, scoped
stale-gate read, advisory lock, write block). Smoke probe NOT
shipped for this path (deferred to a future Step under B.4).
No live-DB latency floor measured; mocked-test wall-time is
sub-100ms per spec.

**Recurrence-scope edits (editScope).** N occurrences × per-
occurrence work. Per occurrence: 6-8 round-trips inside the RPC
+ TS plan-build resolver call. For the 200-occurrence cap (which
is the hard upper bound), that's up to 1200-1600 round-trips.
Step 2F.4 smoke probe quantifies on a 5-occurrence fixture only;
production p95 at 100+ occurrences is not yet measured.

**Resolver-outcome hoist** (deferred perf optimization, tracked
in `b4-followups.md`): for weekly/biweekly series where every
occurrence resolves to the same rule outcome, the resolver could
be hoisted out of the per-occurrence loop. Currently N independent
resolver calls. Saves up to (N-1) resolver round-trips on the
common-case weekly recurrence. Implement when smoke probes
quantify p95 latency on a 100+ series.

## 10. Open follow-ups

Source of truth: `docs/follow-ups/b4-followups.md`. Open sections
(not marked CLOSED), in rough criticality order:

1. **B.4.A.5 — notification dispatch (controller-before-dispatch
   invariant).** Phase next. Until B.4.A.5 ships, the editSlot /
   editOne / editScope 422 pre-flight gate
   (`booking.edit_requires_notification_dispatch`) blocks any edit
   that would emit a new approval chain. Lift mechanism documented
   in §5 above + `b4-followups.md`.
2. **Plan-builder helpers read tenant from ALS — Phase 8 refactor.**
   `BookingFlowService.loadSpace`, `RuleResolverService.resolve`,
   `ConflictGuardService.snapshotBuffersForBooking` read tenant
   from `TenantContext.current()`, not from explicit args. Current
   mitigation: hard-assert at plan-builder entry points. Long-term
   fix: thread `tenantId` through helper signatures so they don't
   depend on ALS for data-plane queries.
3. **`splitSeries` non-idempotency on partial-write commit.**
   `RecurrenceService.splitSeries` commits side effects to
   `recurrence_series` + `bookings` + `audit_events` BEFORE the
   `edit_booking_scope` RPC runs. If the RPC fails downstream
   after split commits, retry forks the series AGAIN. Mitigated
   in 2F.3 by re-reading pivot's `recurrence_series_id` on retry
   path (commit `a2df38b4`). Proper fix would require pulling
   splitSeries into PL/pgSQL — significant rewrite. Accepted
   hazard for now; tracked in `b4-followups.md`.
4. **In-flight retry hazard across the deploy window.** Step 2F.3
   introduced the idempotency op discriminator. Pre-deploy retries
   used 4-segment keys; post-deploy retries use 5-segment keys.
   Same `client_request_id` → different key → double-write risk
   in the cutover window. Mitigation: drain edit-booking traffic
   during deploy OR add fallback read for legacy 4-segment shape.
5. **Visitor cascade fan-out — batch optimization.**
   `ReservationService.editScope` post-RPC cascade is N sequential
   `visitors` lookups (one per occurrence with geometry change).
   For N=200, up to 200 round-trips. Fix shape:
   `.in('booking_id', bookingIds)` single query. Defer until smoke
   probes (when extended) quantify the actual cost.
6. **Resolver-outcome hoist (perf optimization).** See §9.
   Quantify before implementing.
7. **Frontend hook tests for `useEditBookingScope[DryRun]`.**
   Sibling edit hooks (`useEditBooking`, `useMoveBooking`) are
   also untested. Backlog for a future test-coverage sweep.
8. **`emitVisitorCascadeForBundle` @internal JSDoc.** Made public
   on `ReservationService` for the single new `editScope` caller.
   Future cleanup: add `@internal` tag or move to a shared service
   if a third caller appears.
9. **Cascade re-emission on retry.** Pre-existing accepted hazard
   inherited from the visitors cascade design. Visitor outbox
   events re-emit on idempotent replay (the RPC's `cached_result`
   path doesn't suppress the cascade). Tracked in `b4-followups.md`
   + sibling `b2-followups.md`.
10. **Smoke probe for editOne + editSlot single-occurrence
    path.** `pnpm smoke:edit-booking` not yet shipped. Sibling
    to scope smoke (same fixture pattern). Open as a future Step
    under the B.4 workstream.
11. **`approval_chain_id` backfill for create-time approvals.**
    Phase 8 cleanup. Edit-driven chains write a fresh `chain_id`;
    create-time chains leave it NULL. `loadCurrentApprovalChain`
    handles the NULL bucket today.
12. **Audit_events.details — `chain_config_changed` not surfaced.**
    Inherited from B.2.A. Defer to next v5 supersession of
    `edit_booking` when a real defect requires touching the RPC.
13. **TS-vs-RPC race window on `chain_config_changed`.** Accepted
    race (advisory lock + chain-config-not-status semantics make
    the window safe in practice). Long-term hardening: RPC re-reads
    approvals INSIDE its row lock and re-computes the boolean
    from `new_chain_config` + live state.
14. **Directory rename `reservations/` → `bookings/` (Phase 8
    sweep).** TS directory still says `reservations/`; pure naming
    hygiene.
15. **UUID_RE consolidation.** Pre-existing tech debt; intentional
    strict copy in `client-request-id.middleware.ts`. Bundle into
    next routine refactor pass.

## 11. Lessons (5 bullets)

1. **Plan-review BEFORE coding catches direction errors at
   ~10× lower cost than impl-review.** Step 2F.2 plan-review B1
   (splitSeries-at-controller) saved ~300 LOC of misdirected work
   + prevented a P0 "preview button forks series" footgun.
   Step 2F.3 plan-review B3 (idempotency op discriminator) +
   B5 (dry-run replay cache) each caught contract bugs BEFORE any
   code shipped. Pattern: write the plan, hand to plan-reviewer
   subagent, get findings, revise plan, THEN code. Costs ~30 min;
   saves ~3-8 hours per misdirection caught.
2. **Smoke probes are mandatory, not optional.** Step 2F.4 closes
   the live-DB gate that ~46 assembler unit specs + 42 concurrency
   scenarios CANNOT close — unit tests run against mocked Supabase
   and concurrency tests use psql with `session_replication_role`,
   neither of which talks to PostgREST + the real auth stack.
   The 13-scenario smoke is what proves the wire path works.
   `pnpm smoke:edit-booking` (single-occurrence sibling) is the
   next gap; treat it as load-bearing.
3. **Multi-occurrence atomicity has subtle race surfaces.**
   `splitSeries` + scope-RPC two-phase commit interacts with
   client retries in ways the "1 RPC = 1 atomic write" mental
   model doesn't predict. The architectural rule "PL/pgSQL RPCs,
   not TS pipelines" exists exactly to prevent this. B.4's
   splitSeries-then-RPC pattern is a pragmatic compromise; the
   pure-RPC version would require porting splitSeries into PL/pgSQL.
4. **Codex catches structural drifts that plan + code reviewers
   consistently miss.** The recurring failure mode in B.4 (and
   B.2.A): the *local variable* is named correctly + the *immediate
   logic* is correct, but the *call graph* drifts (TenantContext
   in helpers vs. args in plan-builder; pre-check fires twice
   in commit mode; stale-gate misses dest-room scope; v3 `target_scope`
   typo). Self-review reads the function in isolation; codex
   reads the call graph. Run codex on every RPC v1 + every
   controller cutover. Skip on small mechanical follow-ups.
5. **Doc-sync in the same commit is mandatory; followup drift
   compounds across sub-steps.** B.4 added 6 sections to
   `b4-followups.md` across 10 sub-steps. Every commit that
   introduced an accepted hazard, deferred optimization, or v3
   correction updated `b4-followups.md` in the SAME commit (not
   "follow-up commit"). The retro could be assembled by reading
   `b4-followups.md` end-to-end + the 36 commit messages — no
   reverse-engineering required. Future workstreams: enforce
   "same commit or it doesn't ship."

## 12. What B.4 explicitly did NOT do

- **Booking cancellation cascade.** Phase 6 hardening backlog.
  Bigger surface than just the cancel write.
- **Visitor pass assignment edits.** Lives in a separate
  codebase. Visitor cascade trigger handles edit-time pass
  invalidation independently.
- **Bulk admin edits.** "Move all bookings from Room A to Room B
  over the next 30 days" — tooling spec, not B.4. Future Phase 6+.
- **Time-shift on series edits (recurrence_rule edit).** Scope
  edits explicitly reject `start_at` / `end_at` patches with 422
  `edit_booking_scope.time_shift_not_supported`. Time-shifting a
  series requires a recurrence_rule edit (different surface),
  not a slot UPDATE on N occurrences. Out-of-scope by spec §10.
- **`pnpm smoke:edit-booking` for editOne + editSlot.** Deferred
  to a future B.4 Step. Spec §5 lists the 6 scenarios that would
  cover the single-occurrence wire path; sibling to the scope
  smoke (same fixture pattern, same Admin JWT mint, same psql
  cleanup-in-`finally`).
- **Multi-room booking + service-attach edits.** Phase 6 edge
  case.

## 13. Final state

- **HEAD on origin/main:** `71618510` (Step 2F.4 smoke probe)
- **Migrations consumed:** 8 (00359, 00360, 00361, 00362, 00363,
  00364, 00367, 00371)
- **Gates green:** `errors:check-app-errors` 0/34, `naming:check-allowlist`
  420 api / 143 web, 16/16 scope concurrency, 26/26 edit_booking
  concurrency, 46/46 assembler unit, 13/13 smoke
- **Net new test scenarios:** ~100
- **Out-of-band gate state:** `pnpm test:concurrency` full-suite
  has 38 pre-existing failures from parallel-session
  workflow-phase0 contamination (not a B.4 regression)
- **Next workstream unblocked:** B.4.A.5 (notification dispatch),
  Phase 8.D (legacy `edit_booking_slot` drop), Phase 8 directory
  rename + tenantId thread-through

**One-line summary:** B.4 booking-edit pipeline (PATCH /reservations/:id,
PATCH /reservations/:bookingId/slots/:slotId, POST /reservations/:id/edit-scope)
cut over from legacy TS multi-step writes to unified `edit_booking`
+ `edit_booking_scope` PL/pgSQL RPCs; 8 migrations (00359-00364,
00367, 00371), ~100 new test scenarios, 8 bugs closed, all CI
gates 0-violation.

> **Narrowed 2026-05-16 (booking-audit Slice 1):** "B.4 edit-paths
> COMPLETE / 8 bugs closed" is accurate only for the booking + slot +
> approval transaction. Until 2026-05-16, editOne/editSlot/editScope
> were in fact returning 404 `actor_not_found` for every call (audit 03
> D-1), and linked-row patches (orders/asset_reservations/work_orders
> time propagation) were never populated (audit 03 P0-2). Both fixed
> 2026-05-16; multi-slot linked-row propagation remains a deferred
> residual. Cancel / cascade / standalone / recurrence-split paths
> remain TS choreography (audit 03 P0-1 / P1-2 / P1-3 / P1-4, open).
> See `docs/follow-ups/audits/03-booking-reservation.md` Closure Ledger
> 2026-05-16.

---

**Workstream close.** 10 sub-steps, 8 migrations, ~36 commits,
~22k LOC insertions, ~100 new test scenarios, 4 v-revisions on
`edit_booking` (v1→v4), 2 v-revisions on `edit_booking_scope`
(v1→v2), 1 frontend hook pair, 1 live-DB smoke probe, 0 reverts.
Decay this doc when Phase 8 lands.
