# Plan B.4 — Booking edit pipeline

> **Status:** v2 spec, planning. NO code, NO migrations.
>
> **Reading order before implementation:**
> 1. CLAUDE.md "Multi-step writes are PL/pgSQL RPCs"
> 2. `docs/superpowers/specs/2026-05-04-domain-outbox-design.md` §1, §3.1, §7.6 (canonical RPC pattern)
> 3. `docs/follow-ups/b2-survey-and-design.md` §0.2 (source-of-truth invariant table — adapt for bookings)
> 4. This doc §1 + §3
>
> **Why this exists:** booking edits today silently skip every recompute that booking creation runs through. The edit path writes new geometry but keeps stale cost, stale buffers, stale rule evaluation, stale approval status, and stale catering / asset / work-order linkages. This produces bugs ranging from cosmetic (display lies) to financial (catering routed to old room) to operational (work-orders fire for the wrong time/place).

## Revision history

- **v1 (2026-05-08).** First spec. Hand-verification was thin; internal review surfaced 7 critical citation/contract errors + missed items.
- **v3 (2026-05-08, codex pass).** Closes 2 criticals + 3 importants + 1 nit on v2:
  - §3.6.5 approval reconciliation extended to cover ALL terminal + non-terminal states. Terminal `approved` + new-different-chain-config is the dangerous gap codex called out: silently preserving the old approval would bypass new approvers. v3 explicitly handles it by expiring old chain + inserting a fresh chain even when terminal-approved.
  - "Partial" defined: `partial` ≡ "chain has at least one `pending` or `delegated` row, mixed with any number of `approved` rows." Distinguished from terminal states.
  - §3 step 5 (semantic re-derivation): the "PG wins on stale plan" claim was unimplementable — `RuleResolverService` is TS-only. v3 clarifies: TS re-runs the resolver inside the RPC call wrapper (synchronously, BEFORE the PG transaction). If the re-run yields a different outcome, the call returns 409 with `automation_plan.semantic_mismatch` and the caller must retry with a fresh plan. PG row-lock via SELECT FOR UPDATE inside the RPC tx prevents another writer from racing past during the commit. NO PL/pgSQL re-implementation of the rule resolver — the contract is TS-side re-validation, not server-internal arbitration.
  - §3 step 1 lock claim corrected: `delete_booking_with_guard` (00292:75-83) uses `SELECT ... FOR UPDATE` (row-level lock), not advisory. v3 spec uses the same row-lock pattern; serialization comes from the row lock, not advisory keys. Aligns with the existing booking RPC family.
  - `approvals.reason` does NOT exist — only `comments` (00012:14-17). v3 corrects: when expiring an old approval chain, write `comments = 'superseded_by_edit (booking edit at <timestamp>)'`. The audit trail uses the existing column.
  - §9 status updated: questions previously marked "RESOLVED" are now "addressed in §3.6.5" with truthful language pointing at the spec section that handles them.

- **v2 (2026-05-08).** Folds the v1 review:
  - Every file:line citation re-verified against current main. Specifically corrected: `rule-resolver.service.ts:77` → `:87`; `cost.service.ts` body actually 57-152, but the per-booking cost is in `booking-flow.service.ts:1289-1310`'s `computeCost` (approval-row builder is at a different line — clarified inline).
  - Removed fabricated `order_line_items.requested_for_start_at` claim. The window-anchor columns are on `orders` (`requested_for_start_at`/`requested_for_end_at` per migration 00144). OLI lines pin via their parent order, not a per-line column.
  - Approval-status enum gap: `'cancelled'` is NOT in the enum (`pending|approved|rejected|delegated|expired` per `00012_approvals.sql:14`). v2 either adds an enum-extension migration as a B.4 dependency OR uses `'expired'` with reason='superseded_by_edit'. Decision pinned in §4.
  - `validate_entity_in_tenant` + `command_operations` are flagged inline as `[B.2 dependency]` everywhere they appear — they don't exist yet.
  - Recurrence-scope edit (B.4.C) — replaces "continue + aggregate" with **two-phase plan-then-commit**. Per-occurrence partial commit violates the architectural rule the spec opens by quoting.
  - §3.1 invariant table expanded from 4 rows to 12.
  - Hard-cutover replaces the "thin wrapper" deprecation for 00291.
  - Approval-chain reset/preserve semantics on edit decided (§9.2 closed).
  - Added missing concerns: `cost_center_id` cascade, `config_release_id` re-pin question, EDIT-vs-CANCEL race, SLA-timer reseat on planned_start_at change, audit-event payload diff format.
  - Estimate bumped 11-17 days → 3-4 weeks (recurrence two-phase + approval-chain semantics added real work).

## 0. Scope contract

**What B.4 covers.** The booking-edit pipeline. Specifically:
- `PATCH /reservations/:id` (`apps/api/src/modules/reservations/reservation.controller.ts:291-299`, service `reservation.service.ts:editOne` at 624-917)
- `PATCH /reservations/:bookingId/slots/:slotId` (`reservation.controller.ts:320-333`, service `editSlot` at 957-1140)
- `POST /reservations/:id/edit-scope` (`reservation.controller.ts:360-386`, service `booking-flow.service.ts:editScope` at 1078-1206)
- The atomic primitive `public.edit_booking_slot(...)` (`supabase/migrations/00291_edit_booking_slot_rpc.sql`) gets **hard-replaced** by a richer `edit_booking(...)` RPC. No transition wrapper — see §7 cutover.

**What B.4 does NOT cover.**
- Booking creation — already shipped via `create_booking_with_attach_plan` (00309).
- Booking cancellation — Phase 6 hardening backlog.
- Visitor edits — visitor cascade trigger handles those independently.
- Recurrence series materialisation (cron) — orthogonal.

**Architectural rule (CLAUDE.md):**
> If a feature has to write to ≥2 tables and any partial-write state is corrupting (cross-table invariants, FK chains, audit-trail integrity), the writes go inside one PL/pgSQL function called from TypeScript — NOT a sequence of supabase-js HTTP calls in TS.

**TS keeps:** input validation, permission checks, plan assembly (load space, run rule resolver, run buffer collapse, compute cost — all read-only).
**PG owns:** advisory lock → tenant validation of every FK → state-machine check → atomic writes → outbox emit → return outcome.

## 0.1 Source-of-truth contract (mirrors B.2 §0.2)

The committed booking row is the source of truth post-edit. Specifically:
- `bookings.location_id` is committed at edit time and sticky.
- `bookings.cost_amount_snapshot` is the price as quoted at edit time.
- `bookings.policy_snapshot` is the rule evaluation at edit time.
- `bookings.applied_rule_ids` is the set of rules in effect at edit time.
- `booking_slots.setup_buffer_minutes` / `teardown_buffer_minutes` are sticky after edit (reads NEVER recompute from the room's current config).

Edits to `request_type_scope_overrides`, `booking_rules`, or room config do NOT retroactively change committed booking config. Re-derivation in PG happens only at edit-RPC entry to validate the TS plan.

## 1. Survey — what an edit changes today vs. should change

| Mutable field | Where it lives | What edits today | What B.4 should additionally update |
|---|---|---|---|
| `space_id` (slot) | `booking_slots.space_id` | Direct write in `edit_booking_slot` (00291:131-139); `bookings.location_id` mirrored only on primary-slot edit | rule re-eval, buffer recompute (new room's `setup_buffer_minutes`/`teardown_buffer_minutes`), cost recompute (new room's `cost_per_hour`), `asset_reservations` (linked window invalidates), `orders.delivery_location_id`, `orders.requested_for_start_at`/`end_at` (if window changed), `work_orders.planned_start_at`/`sla_due_at` for setup tickets, approvals row reconciliation (§3.6.5), calendar_etag bump, `bookings.cost_center_id` cascade if host's default differs by building |
| `start_at` / `end_at` (slot) | `booking_slots.start_at/end_at` → `bookings.start_at = MIN(slots)`, `bookings.end_at = MAX(slots)` | Direct write; mirrored | conflict-guard tstzrange re-check, `asset_reservations.start_at/end_at`, `orders.requested_for_start_at`/`end_at`, SLA timers on setup WOs (via repoint), recurrence-series anchor |
| `attendee_count` (slot) | `booking_slots.attendee_count` | Direct write | catering pricing recompute, capacity rule re-check |
| `attendee_person_ids` (slot) | `booking_slots.attendee_person_ids` | Direct write | multi-attendee conflict guard, visitor cascade (already fires) |
| `host_person_id` (booking) | `bookings.host_person_id` | Direct write | notifications, possible cost-center cascade |
| `recurrence_overridden` | `bookings.recurrence_overridden` | Direct write in scope-edit | series projection |

**Citation:** every "edits today" line is verified against current main (`grep` confirmed at v2 review).

## 2. Bug inventory (8 distinct — closed by B.4)

These are deduplicated. v1 listed 10; on review, items 1/5/7 are three faces of the same root ("downstream-table cascade missing on edit") and item 10 is a consequence of others, not a separate bug.

1. **Downstream-table cascade missing on edit (3 manifestations).** Editing a booking does NOT cascade to `bookings.cost_amount_snapshot`, `orders.delivery_location_id`/`requested_for_*`, or `work_orders.planned_start_at`/`sla_due_at`. Catering routes to old room; setup teams arrive at the wrong time; reports lie about cost.
2. **Buffer leak/overlap.** Old room's `setup_buffer_minutes`/`teardown_buffer_minutes` carried into new room. Conflict-guard runs against wrong window. New room over-buffered (eats slots) or under-buffered (cleaning crew blindsided).
3. **Rule violation slips through.** Capacity overflow on smaller new room; allowed-roles violated; deny rules ignored. Edit lets through what create would have rejected.
4. **Approval bypass on rule-class change.** Moving from no-approval room to approval-required room leaves `bookings.status='confirmed'` with no `pending_approval` row. Approver never sees it.
5. **Asset reservations stuck on old window.** Asset double-booked or freed prematurely.
6. **Recurrence-scope wholesale-UPDATE.** `editScope` (`reservation.service.ts:1078-1206` / `booking-flow.service.ts:1078-1206` per actual file path) is bare `UPDATE ... WHERE recurrence_series_id = ?` with ZERO rule eval, conflict guard, capacity check, approval re-eval, or cost recompute. One tenant can shift a 52-week series into a smaller room and break every occurrence's capacity invariant. This is bugs 1-5 amplified across N occurrences.
7. **Calendar sync drift.** `bookings.calendar_etag` not bumped on edit; Outlook caches the old event indefinitely.
8. **Config-release pin drift (open question).** `bookings.config_release_id` (00277:285) pins reproducibility. On edit: re-pin to current release? Or stay pinned to the old one (now violating it)? Spec §9.4 must decide before implementation.

## 3. Architectural shape — combined RPC `edit_booking`

### 3.1 Source-of-truth invariant table (12 rows)

| Reader path | Source of truth | Allowed columns | Why |
|---|---|---|---|
| §3 `edit_booking` RPC entry (TS plan-build) | TS-built `EditPlan` + PG re-derivation | All §1 fields | Single legitimate read of room/rule config |
| Daglijst / catering renderer | `orders` (committed) | `delivery_location_id`, `requested_for_start_at`, `requested_for_end_at` | Sticky after edit |
| Calendar sync | `bookings.calendar_etag` | etag bumped on every edit | Forces Outlook re-sync |
| WO setup planner | `work_orders` (committed) | `planned_start_at`, `sla_due_at` | Sticky; reseated via `repoint_sla_timer_rpc` (B.2 §3.10) |
| Conflict guard | `booking_slots.effective_start_at` / `effective_end_at` | computed by trigger from sticky `setup_buffer_minutes`/`teardown_buffer_minutes` | Buffers committed at edit time, NEVER re-derived from current room config |
| Cost reporting | `bookings.cost_amount_snapshot` | sticky | edit's quote, not current room's hourly rate |
| Rule audit | `bookings.policy_snapshot` + `applied_rule_ids` | sticky jsonb | what rules said at edit time |
| Approval audit | `approvals` rows | state-machine, NEVER reset on edit (see §3.6.5) | preserve audit history |
| Visibility predicates | `bookings.location_id` | sticky after edit | location-scoped operators see consistent state |
| Asset booking | `asset_reservations` | start_at, end_at — sticky | windows match committed slot |
| Cost-center attribution | `bookings.cost_center_id` | sticky after edit; recomputed only if host changes (§3.6.4) | finance/billing |
| Series projection | `recurrence_series.anchor_*` | unchanged on per-occurrence edit; only `editScope` touches | series semantics |

### 3.2 RPC signature

```sql
public.edit_booking(
  p_booking_id    uuid,
  p_plan          jsonb,    -- TS-resolved EditPlan
  p_tenant_id     uuid,
  p_actor_user_id uuid,
  p_idempotency_key text
) returns jsonb     -- { booking: row, follow_ups: [...event types emitted] }
```

### 3.3 TS plan-build phase

1. Load current booking + slots + linked orders/OLIs/asset_reservations/work_orders/approvals.
2. Apply patch to compute target slot set + booking mirror.
3. Load target space (`loadSpace` in `booking-flow.service.ts:1264-1282`).
4. Run `RuleResolverService.resolve` (`rule-resolver.service.ts:87`) on target state.
5. Run `ConflictGuardService.snapshotBuffersForBooking` (`conflict-guard.service.ts:129`).
6. Compute new room cost via `BookingFlowService.computeCost` (`booking-flow.service.ts:1289-1310`); compute service-bundle cost via `CostService.computeBundleCost` (`apps/api/src/modules/orders/cost.service.ts:57`).
7. Determine new approval requirement from rule outcome.
8. Build `EditPlan` jsonb (room ids, slot patches with effective windows, cost delta, rule outcome, approval delta, asset window patches, OLI updates, WO time patches, calendar_etag bump).

### 3.4 Body sketch (atomic write)

1. **Row-level lock** via `SELECT ... FOR UPDATE` on `bookings.id = p_booking_id AND tenant_id = p_tenant_id` (mirrors the pattern in `delete_booking_with_guard`, `00292_delete_booking_with_guard_rpc.sql:75-83`, and `edit_booking_slot`, `00294_edit_booking_slot_validate_space.sql:74-80`). Concurrent edits on the same booking serialize through this row lock; concurrent edit-vs-delete also serializes since both take the same lock. **No advisory lock** — v2 incorrectly claimed advisory; this is row-lock serialization. v3 / codex correction.
2. **`command_operations` idempotency gate** [B.2 dependency — see §8].
3. SELECT current booking + slots + linked rows FOR UPDATE.
4. **Tenant-validate every FK in `p_plan`** via `validate_entity_in_tenant` [B.2 dependency]. Rooms, asset ids, line items, work orders.
5. **Semantic re-derivation gate** — TS-driven, NOT PG-internal (v3 / codex correction). `RuleResolverService` is TS-only (`apps/api/src/modules/room-booking-rules/rule-resolver.service.ts:87`); there's no PL/pgSQL equivalent. Implementation pattern:
   - The RPC accepts `p_plan.rule_outcome_fingerprint` (a hash of the resolver outcome — final + matched_rule_ids + effects).
   - **Inside the RPC**, after acquiring the row lock, PG returns the `booking_rules.updated_at` MAX for the affected request_type+scope. If `> p_plan._resolution_at`, the rule set has shifted since plan-build → return 409 `automation_plan.stale_resolution` immediately.
   - **The TS caller** wraps the RPC call: if 409 stale_resolution, re-run the resolver, assert the outcome fingerprint matches the previous attempt's, retry once. If the fingerprint changed (new rule, new effect), return 422 `automation_plan.semantic_mismatch` with both fingerprints and the detected delta — operator must review the new outcome before retrying.
   - Single retry by design — repeated stale_resolution implies a hot tenant with admins thrashing rules; user gets surfaced friction, not silent commit of stale state.
   - The PG row lock prevents another writer from racing PAST the gate during the commit; the TS-driven re-derivation handles the case where rules changed BEFORE the gate fired.
6. **Atomic write block:**
   1. UPDATE `booking_slots` (space_id, start_at, end_at, setup_buffer_minutes, teardown_buffer_minutes, attendee_count, attendee_person_ids).
   2. UPDATE `bookings` (location_id mirror, start_at = MIN(slots), end_at = MAX(slots), cost_amount_snapshot, policy_snapshot, applied_rule_ids, status if transitioning to `pending_approval`, calendar_etag bump, cost_center_id if host's default differs by building).
   3. UPDATE `asset_reservations` (start_at, end_at) for any reservation tied to a moved/resized slot.
   4. UPDATE `orders` (delivery_location_id if primary slot location changed, requested_for_start_at/end_at if window changed).
   5. **Approval reconciliation (§3.6.5).** See decision table below.
   6. UPDATE `work_orders` (planned_start_at, sla_due_at) for any linked setup WOs. **Emit `sla.timer_repointed_required` outbox event for each WO with an active SLA timer** so `repoint_sla_timer_rpc` [B.2 §3.10] reseats the timer.
7. INSERT `audit_events` (`booking.edited`, payload jsonb diff `{before:{}, after:{}}` matching B.2 audit format).
8. INSERT `domain_events` (`booking_edited`).
9. Emit outbox events atomically:
   - `booking.location_changed` if `space_id` changed.
   - `booking.cost_changed` if cost delta non-zero.
   - `booking.approval_required` if status went to `pending_approval`.
   - `sla.timer_repointed_required` per setup WO with active timer.
10. UPDATE `command_operations` to outcome='success'.
11. Return `{ booking: row, follow_ups: [...] }`.

### 3.6.5 Approval reconciliation decision table (v3 — terminal + non-terminal states)

**Definitions:**
- `none` — no approvals row exists for this booking.
- `pending or partial` — at least one row in `pending` or `delegated`, possibly mixed with `approved`. Chain not yet resolved.
- `terminal_approved` — chain fully resolved approving (no `pending`/`delegated`/`rejected` rows; at least one `approved` row).
- `terminal_rejected` — at least one `rejected` row exists (booking was already cancelled per `00310_grant_booking_approval_rpc.sql:162-172`).

When the rule resolver's `final` changes between create and edit:

| Old `final` | New `final` | Active approvals state | Action |
|---|---|---|---|
| `allow` | `allow` | none | no-op |
| `allow` | `require_approval` | none | INSERT new approvals chain (per new rule's `approval_config`); status → `pending_approval` |
| `require_approval` | `allow` | pending or partial | UPDATE existing approvals to `'expired'` with `comments='superseded_by_edit (booking edit at <ts>)'`; status → `confirmed` |
| `require_approval` | `allow` | terminal_approved | no approvals action (the historical chain stands as audit); status stays `confirmed` |
| `require_approval` | `allow` | terminal_rejected | edit is on a cancelled booking; should reject upstream — return 422 `booking.cancelled_cannot_edit` |
| `require_approval` | `require_approval` (same chain config) | pending or partial | **preserve in-flight grants.** Edit changes booking metadata; approvers' decisions on unchanged approval-target stand. |
| `require_approval` | `require_approval` (different chain config) | pending or partial | UPDATE existing chain to `'expired'` with `comments='superseded_by_edit'`; INSERT fresh chain per new config; status stays `pending_approval` |
| **`require_approval`** | **`require_approval` (different chain config)** | **terminal_approved** | **DANGEROUS GAP — explicit handling.** Old chain says "approver A approved this booking at room R1." Edit moves to room R2 with a different chain (approver B). Silently preserving "approved" would bypass approver B. v3 fix: UPDATE old chain to `'expired'` with `comments='superseded_by_edit (room change to R2)'`; INSERT fresh chain per new config; status → `pending_approval`. Old chain stays in audit; new chain gates the edit. |
| `require_approval` | `require_approval` (different chain config) | terminal_rejected | edit on a cancelled booking; reject upstream |
| `require_approval` | `deny` | any state | reject the edit with 422 (or 403 with `actor.has_override_rules` check); approvals untouched |

**Why `'expired'` not `'cancelled'`:** the approvals enum has no `'cancelled'` value (`00012_approvals.sql:14`: `pending|approved|rejected|delegated|expired`). v3 reuses `'expired'` with the explanation in `comments` (the table has no `reason` column — `comments` is the existing audit-payload column).

**Chain identity:** "different chain config" means the new rule's `approval_config` differs in approver_targets, sequential vs parallel, or required_count. Same-config = preserve in-flight grants.

## 4. Migration plan

| # | File | Purpose |
|---|---|---|
| 00339 | `edit_booking_rpc.sql` | The combined RPC. **Hard-replaces** 00291's `edit_booking_slot` — see §7 cutover. |
| 00340 | `bookings_calendar_etag_bump_helper.sql` (optional) | If the etag bump becomes a hot path. Defer until smoke shows latency. |

2 migrations. **No enum extension** — the approvals.status `'expired'` value already supports the supersede semantics (see §3.6.5).

`validate_entity_in_tenant` and `command_operations` are NOT B.4 migrations — they're B.2 dependencies. B.4 starts AFTER B.2.A foundation lands; if B.2.A delays past B.4's planned start, B.4 can ship with stub helpers (rejecting any non-tenant-scoped FK) and switch to B.2's once it lands.

## 5. Test plan

**Mocked-jest specs:**
- One `*.spec.ts` per RPC code path: geometry-only edit, location change, attendee resize, approval gate flip in each direction (allow→require_approval, require→allow same-chain, require→allow different-chain, require→deny), cost delta, recurrence scope, idempotency replay, semantic-mismatch gate.
- ~70-90 specs.

**Live-API smoke probe** (`pnpm smoke:edit-booking`):
- Plain time edit (no recompute beyond mirror).
- Location to bigger room (rules allow).
- Location to smaller room (capacity rule denies → 422).
- Location to room with approval rule → status flips, approvals row inserted.
- Time change with linked catering → `orders.requested_for_start_at` updates, `delivery_location_id` updates if room changed.
- Idempotency replay: same key → cached_result.

**Real-DB concurrency probes** (extend `apps/api/test/concurrency/`):
- Two concurrent edits on the same booking → second blocks via advisory lock, then commits or returns `cached_result` if same idempotency_key.
- Edit vs concurrent cancel → first wins via advisory lock; second gets a deterministic state-machine error.
- Edit at T0 + admin updates `booking_rules` at T0+ε → semantic-mismatch gate either rejects or commits with PG's recomputed result + audit breadcrumb (per §3.6 step 5).

## 6. Estimated scope

- 1 RPC migration + tests: ~3-5 days
- TS plan-build refactor (extract reusable `assembleEditPlan` from create-flow): ~3-4 days
- Cutover of `editOne` / `editSlot` controllers: ~2 days
- **Recurrence-scope edit (B.4.C — two-phase plan-then-commit)**: ~5-8 days. Per-occurrence dry-run validation must aggregate failures; commit step uses one outer advisory lock + per-occurrence inner work; failure-aggregation UI surfacing on the response.
- Smoke probes + concurrency tests: ~2-3 days
- Approval-chain reconciliation (§3.6.5 — six-case decision table needs careful tests): ~2-3 days

**Total: 17-25 working days = 3-5 weeks** for one engineer.

## 7. Sequencing

1. **B.4.A foundation.** Migration 00339 (the RPC), TS `assembleEditPlan` helper, mocked-jest specs covering all six rows of §3.6.5. Cutover `editSlot` only (geometry-only edits use the RPC).
2. **B.4.B `editOne` cutover.** All booking-level patches now route through the combined RPC. Hard-cut: `edit_booking_slot` (00291) callers go to `edit_booking` in the same migration. No transition wrapper (the wrapper would have to skip the new recomputes, defeating the point — see v1 review finding #12).
3. **B.4.C `editScope` two-phase cutover.** Recurrence-series fan-out is the hardest case. **Two-phase:** (1) dry-run all occurrences through TS plan-build + PG semantic gate (no writes); aggregate failures. (2) If all dry-runs pass, run the commit phase across N occurrences inside one tx. If any fail at commit, abort all (rollback). User sees one atomic result: "all 52 occurrences moved" OR "none moved + here's the conflict on occurrence 14." This violates the "max single tx duration" rule for very large series — define a series-size threshold (e.g. >100) above which we explicitly chunk + surface "this edit will commit in 3 batches; partial state is possible if interrupted" in the UI, and require explicit user confirmation.
4. **B.4.D smoke + concurrency probes.**

## 8. Dependencies

- **B.0 (shipped):** `create_booking_with_attach_plan` is the structural template.
- **B.2 (planned, pending B.0 soak):** `validate_entity_in_tenant`, `command_operations`, the §0.2 invariant table pattern, `repoint_sla_timer_rpc`. **B.4 should NOT start until B.2.A foundation lands.** If schedule pressure: B.4 can ship with stub helpers (defensive: reject any non-tenant-scoped FK with NotFound) and swap to B.2's helpers once they land.
- **A.0 allowlist (shipped):** new B.4 reads of `request_types.workflow_definition_id` / `sla_policy_id` (via the rule resolver chain) need triage in `apps/api/src/modules/.b2-config-reads-allowlist.txt` — same as B.2.
- **Concurrency harness (shipped):** B.4 concurrency tests extend `apps/api/test/concurrency/` per its existing pg.Pool helper.

## 9. Open questions

1. **Deny on edit.** The rule resolver returns `final='deny'` for an attempted edit. Reject 422 (no override)? Allow with `actor.has_override_rules`? Recommend: 422 unless override; mirror CREATE.
2. **Approval-chain semantics.** **Addressed in §3.6.5.** Decision table covers all 10 (old, new, state) combinations including the dangerous `terminal_approved → require_approval (different config)` gap. Implementation must mirror the table exactly. Open sub-question for product: should the requester be notified when a previously-approved booking re-enters approval after an edit? Recommend yes; new approval-required event needs a notification template.
3. **Recurrence-scope failure aggregation.** **Addressed in §7 step B.4.C.** Two-phase plan-then-commit, all-or-nothing for series ≤100; explicit chunked confirmation for larger series. Open sub-question for product: should the chunked-commit threshold be 100 (a guess) or computed from session timeout? Defer to first real customer with >100-occurrence series.
4. **`config_release_id` re-pin on edit.** Decision needed before implementation. Recommend: re-pin to current release on every edit (matches "edit = new commit" semantics). Implications for replay/audit.
5. **EDIT-vs-CANCEL race lock key.** Verify `delete_booking_with_guard` (00292) takes the same `(tenant_id, booking_id)` advisory lock key. If not, the edit and cancel locks don't serialize; one could fire while the other is mid-write.
6. **Calendar sync push timing.** Bump `calendar_etag` immediately (forces next read to refetch from Outlook), or also trigger a push to Outlook from the RPC? Latency impact on user.

## 10. Out of scope (deferred)

- Booking-cancellation cascade. Phase 6 hardening — bigger surface than just the cancel write.
- Multi-room booking + service attach edits. Edge case; can be Phase 6.
- Visitor pass assignment edits. Separate codebase.
- Bulk admin edits ("move all bookings from Room A to Room B over the next 30 days"). Tooling spec, not B.4.

---

**Status:** Spec v2 — ready for codex review. After codex pass clean: implementation per §7 sequencing, gated on B.2.A foundation landing.
