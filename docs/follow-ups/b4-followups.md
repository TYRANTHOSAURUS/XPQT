# B.4 follow-ups

Deferred / known-issue index for the B.4 booking-edit-pipeline workstream.
Items here are intentional non-fixes, documented so future readers don't
re-discover them as bugs. Sibling to `docs/follow-ups/b2-followups.md`.

## Workstream status — COMPLETE (2026-05-12)

B.4 is shipped to `origin/main` at HEAD `71618510`. Steps 1, 2A, 2B,
2C, 2D, 2E, 2F.1, 2F.2, 2F.3, 2F.4 all live. All CI gates 0-violation.

**Closing retrospective:** `docs/follow-ups/b4-closing-retro-2026-05-12.md`.

This file is now an **open-items index**. Each section below is either:
- Marked **CLOSED** with a date — preserved for audit history.
- **OPEN** — deferred to a future Step / Phase. The closing retro §10
  cross-references the open list.

## Step 2F.4 — shipped (2026-05-12)

Live-API smoke probe for the recurrence-scope edit pipeline is live at `apps/api/scripts/smoke-edit-booking-scope.mjs`, exposed as `pnpm --filter @prequest/api smoke:edit-booking-scope` (also wired at the workspace root). Covers all 13 scenarios spec'd in `docs/follow-ups/b4-booking-edit-pipeline.md` §5: setup verification + scope='series' dry-run + commit + idempotent replay + payload-mismatch (409); scope='this_and_following' dry-run (splitSeries suppressed) + commit (splitSeries fires, new series minted, forward bookings move, backward bookings preserved); validation gates (scope='this' → `wrong_endpoint`, `start_at` → 422 `edit_booking_scope.time_shift_not_supported`, invalid scope + non-boolean `dry_run` → 400 `edit_booking_scope.invalid_plans`, missing `X-Client-Request-Id` → 400 `client_request_id.required`).

Fixture seed bypasses `POST /reservations` and writes the recurrence_series + 5 booking + slot rows via psql with `session_replication_role='replica'` (same pattern as the concurrency tests at `apps/api/test/concurrency/edit_booking_scope.spec.ts:97-159`). The create-flow's rule resolver + conflict guard are out of scope for an edit-pipeline probe; going through the public create path adds enough flake (any pre-existing booking on the target room in the chosen window kills the fixture) to be net-negative. Cleanup runs in `finally` (LIFO: audit_events → domain_events → outbox.events → approvals → command_operations → booking_slots → bookings → recurrence_series) so a failed run never leaves orphans.

CLAUDE.md "Smoke gate" section updated to mandate the probe before claiming any work touching `ReservationService.editScope` / `assembleScopeEditPlan` / `edit_booking_scope` RPC is complete.

## Tier B item #3 — `pnpm smoke:edit-booking` sibling probe — CLOSED (2026-05-12)

Closing-retro §10 item #10 (single-occurrence smoke probe for editOne + editSlot) shipped at `apps/api/scripts/smoke-edit-booking.mjs`. Exposed as `pnpm --filter @prequest/api smoke:edit-booking` (also wired at the workspace root). Sibling to `smoke-edit-booking-scope.mjs` — same fixture pattern (psql-seeded with `session_replication_role='replica'`), same Admin JWT mint, same LIFO finally cleanup.

20 scenarios across two fixtures + an op-discrimination probe:

- **Fixture A** (single booking + 1 slot, +130d on ROOM_HUDDLE) drives 11 editOne probes: setup verification, edit space_id, idempotency replay, payload-mismatch (409 `command_operations.payload_mismatch`), geometry shift, invalid_window (start>=end), invalid_window (parse-fail `start_at='invalid-date'`), invalid_space_id (empty string), reference.not_in_tenant (freshly-minted ghost-uuid space_id), booking_not_found (freshly-minted ghost-uuid booking id), missing X-Client-Request-Id.
- **Fixture B** (single booking + 2 slots, +131d, primary on ROOM_HUDDLE display_order=0 + non-primary on ROOM_BOARD display_order=1 — both seeded explicitly so the primary-slot selector at `assemble-edit-plan.service.ts:558-571` resolves deterministically) drives 8 editSlot probes: setup verification, edit non-primary slot.space_id (verify primary unchanged), URL mismatch (Fixture A's slotId + Fixture B's bookingId → `booking_slot.url_mismatch`), MIN(slots) rollup on non-primary start_at shift, idempotency replay (cached), payload-mismatch (409), invalid_space_id (empty string), missing X-Client-Request-Id.
- **Op-discrimination probe** (1 scenario): fires `editOne(crid=X)` on Fixture A + `editSlot(crid=X)` on Fixture B non-primary slot — verifies both `command_operations` rows exist for crid=X with distinct prefixes (`booking:edit:one:` + `booking:edit:slot:`). Locks the Step 2F.3 cross-op key-namespacing contract from `packages/shared/src/idempotency.ts:374-382`.

Citations baked into the script header: `apps/api/src/modules/reservations/reservation.controller.ts:301-380`, `apps/api/src/modules/reservations/reservation.service.ts:600-1450`, `packages/shared/src/idempotency.ts:331-382`, `supabase/migrations/00364_edit_booking_rpc_v4.sql`. Both fixtures intentionally have no linked services / orders / work_orders so the 00364 RPC's §10.c-§10.d cleanup branches are no-ops on these bookings — cascade behaviour is covered by the assembler unit tests + the scope smoke.

CLAUDE.md "Smoke gate" section updated to mandate the probe before claiming any work touching `ReservationService.editOne` / `ReservationService.editSlot` / `assembleEditPlan` (kinds `'one'` + `'slot'`) / the `edit_booking` RPC is complete.

## Tier B item #4 — Phase 8.D drop dead `edit_booking_slot` RPC — CLOSED (2026-05-12)

Closing-retro §10 item #2 (drop the legacy `edit_booking_slot` RPC introduced by 00291 + extended by 00293 + 00294, superseded by 00364 `edit_booking` v4) shipped via migration `supabase/migrations/00379_drop_edit_booking_slot_rpc.sql`. The migration is a single `drop function if exists public.edit_booking_slot(uuid, jsonb, uuid);` — `CASCADE` intentionally omitted so the drop fails loudly on unexpected dependencies rather than silently nuking them.

Pre-drop verification (all 0 hits):
- `grep -rE "\.rpc\(\s*['\"]edit_booking_slot['\"]" apps/ packages/` — zero TS callers.
- `grep -nE "perform\s+(public\.)?edit_booking_slot|select\s+(public\.)?edit_booking_slot" supabase/migrations/*.sql` — zero PL/pgSQL invocations across migration bodies.
- `grep -rE "edit_booking_slot" --include="*.json" --include="*.sh" .` — zero infrastructure references.

Remote DB state confirmed via `select to_regprocedure('public.edit_booking_slot(uuid, jsonb, uuid)')` → NULL after the drop applied. PostgREST schema cache reloaded with `NOTIFY pgrst, 'reload schema'`.

Regression guard wired into `apps/api/scripts/smoke-edit-booking.mjs` as a pre-flight assertion (runs before fixture seed): if a future migration re-creates `public.edit_booking_slot(uuid, jsonb, uuid)`, the smoke trips `Phase 8.D regression: public.edit_booking_slot(uuid, jsonb, uuid) still exists on remote.` and exits 1 before any HTTP probe runs. The asserting helper is `runPsqlQuery` (lines added alongside `runPsql`); the assertion lives in `main()` between the API health check and the fixture seed block.

Remaining references in migration files (`00292`, `00293`, `00294`, `00373`) and TS comments (`tenant-validation.ts`, `bundle-cascade-integration.spec.ts`, `reservation.service.events.spec.ts`, `reservation-edit-tenant-validation.spec.ts`, `reservation.service.ts` legacy docstrings) are all backward-looking lineage citations, not live invocations. Left as-is — historical context for future readers.

## Step 2F.3 — shipped (2026-05-12)

`POST /reservations/:id/edit-scope` cut over from `BookingFlowService.editScope` (bare-UPDATE, deleted) to `ReservationService.editScope` → `assembleScopeEditPlan` → `edit_booking_scope` RPC (00371 v2).

Key shape changes:
- **Dry-run support** via `EditScopeDto.dry_run` (default false). Dry-run path skips `splitSeries` (the assembler's new `forwardOnlyFromStartAt` arg filters scope-rows to the forward subset of the current series) and the visitor cascade emit (nothing committed → nothing to cascade).
- **Idempotency op discriminator** — closes the cross-op-collision followup (below). editOne/editSlot/editScope mint distinct keys.
- **Idempotency keyed on PIVOT bookingId**, not new series id, so a retry after `splitSeries` succeeds still hits the cached `command_operations` row (splitSeries is non-idempotent across retries).
- **Frontend hooks** at `apps/web/src/api/room-booking/mutations.ts`: `useEditBookingScopeDryRun` + `useEditBookingScope` (Pattern A — caller mints `requestId` once per attempt; dry-run + commit share the crid by 00371 v2 design).

## Sequencing — `edit_booking` controller cutover MUST land in or after notification dispatch (B.4.A.5)

Self-review on commit `d285bc32` (the `booking.approval_required` handler
stub) flagged that the stub-now / dispatch-later split creates a
notification window if Step 2D-D (editSlot cutover) ships before
B.4.A.5 (notification dispatch). During that window:

- Admin edits a booking → §3.6.5 row 2/7/8 fires
- 00364 inserts the new approval chain rows + emits
  `booking.approval_required`
- The stub handler logs receipt and acks (no dead-letter, no
  notification)
- Approvers learn nothing until B.4.A.5 ships

Spec §7 line 270 already states the producer-before-consumer invariant,
but the spec doesn't yet name the **controller-before-dispatch**
invariant. Add to B.4.A.5's spec entry: "do NOT ship the editSlot /
editOne / editScope controller cutovers until notification dispatch is
live in the same commit, or the deferral risks silent stalls on every
approval-flipping edit."

Until B.4.A.5 ships:
- Step 2D-D (editSlot cutover) only triggers row 2/7/8 emits when the
  edit changes the rule resolver outcome (location → require_approval
  flip, attendee resize across capacity threshold, etc).
- Most editSlot calls (geometry-only edits within the same room and
  rule outcome) will NOT trigger an emit and are safe.
- **Implemented (commit `a7ba1cf6` + remediation `fb7b163f`):** the
  pre-flight gate lives in `apps/api/src/modules/reservations/reservation.service.ts:1213`
  (the `editSlot` body, post-`assembleEditPlan`). It throws **422**
  `booking.edit_requires_notification_dispatch` when the assembled plan
  has `new_outcome='require_approval' AND (old_outcome != 'require_approval'
  OR chain_config_changed=true)`. 422 (not 503) routes to the
  `validation` class in the web error classifier — surfaces as inline
  form-level guidance, not the retry-loop bait + contact-support of a
  500-class toast. Operator copy gives a concrete action ("Ask the
  rooms admin to remove approval from this room, or pick a different
  room"). Lift mechanism when B.4.A.5 ships notification dispatch:
  delete the gate predicate at `reservation.service.ts:1171-1213` +
  retire the error code (or leave registered for defense-in-depth).

## UUID_RE consolidation — pre-existing tech debt + intentional strict copy

Code review on commit `d285bc32` (codex 2026-05-12) flagged the
duplication of UUID-shape regex constants. Verified breakdown:

| File:line | Shape | Notes |
|---|---|---|
| `common/tenant-validation.ts:16` | LOOSE (no version/variant) | Exported in commit `c5e8944d` — shared shape for new code. |
| `common/middleware/client-request-id.middleware.ts:32` | **STRICT** (`[1-5]` v1-v5 + `[89ab]` variant — RFC 4122 only) | **DO NOT BLINDLY CONSOLIDATE.** The middleware accepts client-supplied UUIDs as the idempotency boundary; rejecting non-RFC-4122 inputs (v6+, v0, malformed) is a deliberate input-validation contract, not duplication. |
| `modules/sla/sla-policy.controller.ts:10` | LOOSE | Pre-existing duplicate of the now-exported shape; safe to consolidate. |
| `modules/work-orders/work-order.service.ts:617` | LOOSE | Pre-existing duplicate; safe to consolidate. |
| `modules/outbox/handlers/booking-approval-required.handler.ts:2` | (imports from `tenant-validation`) | New handler — uses the shared export. |

The 2 LOOSE local copies (`sla-policy.controller.ts`, `work-order.service.ts`)
are intentionally NOT consolidated here to keep blast radius minimal.
Consolidation is a separate sweep; bundle into the next routine refactor
pass touching those files.

The STRICT copy in `client-request-id.middleware.ts:32` is **intentional**.
A future consolidation that drops it without thought would relax the
client-request-id format contract — a subtle weakening of the idempotency
boundary that no test currently catches. If a consolidation sweep ever
unifies UUID_RE across the codebase, it must EITHER (a) keep
`client-request-id.middleware.ts`'s strict regex inline + cite the
contract decision here, OR (b) export a SECOND constant
(`UUID_RFC4122_RE`) from `tenant-validation.ts` and have the middleware
import that instead.

**Why loose vs strict in general:** Postgres `gen_random_uuid()` produces
v4 UUIDs today, but a future move to v7 (timestamp-prefixed, RFC 9562)
MUST not require a regex bump across the codebase for INTERNAL uuids
(rows generated by our own writes). The loose pattern admits any
RFC-shaped uuid. INPUT validation is different — accepting only known-good
shapes (RFC 4122 v1-v5) protects against the long tail of hand-rolled or
upstream-system uuids; the middleware uses STRICT for that reason.

## Directory rename `reservations/` → `bookings/` — pending Phase 8 sweep

The `apps/api/src/modules/reservations/` directory is the canonical home
of booking-related TS code (post-B.0 rename of `booking_bundles` →
`bookings` table; the `reservations` table itself was renamed to
`booking_slots`). The directory name still says `reservations/` and
TS file paths in citations still reflect that.

Three citations in the B.4.A.4 handler commit (the docstring + two
comment block lines + one test docstring) reference the path
`apps/api/src/modules/reservations/event-types.ts`. These are all
honest/accurate at write time but will need updating when the directory
renames.

Consolidation candidate: rename `apps/api/src/modules/reservations/` →
`apps/api/src/modules/bookings/` in one Phase 8 commit, sweep all import
paths + docstrings, drop the B.4 section header in
`.naming-allowlist.txt` since the citations would then reference the
canonical path.

Not load-bearing for any production code path; pure naming hygiene.

## Audit_events.details augmentation — `chain_config_changed` not surfaced

Inherited from B.2.A. Self-review on 00364 (edit_booking RPC v4) surfaced
that the `audit_events.details` payload for `booking.edited` carries
approval action + outcomes + chain_id but does NOT carry the TS-computed
`chain_config_changed` boolean from the plan. Lets post-hoc auditors
detect plan-builder bugs (separating "TS plan-builder bug" from "RPC
executed correctly given input").

Migrations are immutable; defer to next v5 supersession of `edit_booking`
when a real defect requires touching the RPC. See `b2-followups.md`
section "B.4.A.4 audit payload — chain_config_changed visibility".

Low-priority — only matters when investigating a tenant complaint about
unexpected approval re-trigger.

## create-time approvals — backfill `approval_chain_id`

Self-review on Step 2D-C surfaced (CRITICAL C3 — corrected): every
approval row inserted via `BookingFlowService.createApprovalRows`
(`apps/api/src/modules/reservations/booking-flow.service.ts:1275-1296`)
and via `supabase/migrations/00309_create_booking_with_attach_plan_rpc
.sql` (the create RPC) is written WITHOUT an `approval_chain_id`. The
column is left NULL by default. Only edit-driven chains (00364
`edit_booking` v4) emit a non-null chain id (`gen_random_uuid()` at
:598).

This is not a correctness bug today: `loadCurrentApprovalChain` in
`apps/api/src/modules/reservations/edit-plan-helpers.ts` groups by
`approval_chain_id` with a NULL bucket, and edit-driven chains are
always newer than create-time NULLs (so the MAX(created_at) selection
picks the right bucket). But:

- The bucket key is asymmetric (NULL vs. uuid), and a future helper
  that joins on chain_id would silently drop create-time chains.
- Audit-event payloads that include chain_id will show `chain_id=NULL`
  for the original create-time chain, which is hard to read.
- A booking that has NEVER been edited has `approval_chain_id IS NULL`
  on every approval row — comparing two such bookings by chain id is
  meaningless.

**Fix shape (deferred to Phase 8 cleanup, not Step 2D scope):**
1. Add `chain_id uuid` parameter to `createApprovalRows`; default to
   `gen_random_uuid()` per call.
2. Update 00309's INSERT block to mint and pass the chain id.
3. Add a one-shot migration that backfills `approval_chain_id` for
   pre-existing rows by grouping rows-per-booking and assigning a fresh
   uuid per group.
4. Drop the NULL-bucket case in `loadCurrentApprovalChain`.

Tracked here so the next person touching `loadCurrentApprovalChain`
knows the NULL bucket is the dominant case for approve-on-create
bookings, not a "legacy rows" edge case.

## TS-vs-RPC race window — `chain_config_changed` (I-PLAN-2)

Self-review on Step 2D-C raised the race window between TS-side
`loadCurrentApprovalChain` and the RPC's row lock. Sequence:

1. TS edit-plan builder reads `approvals` (current chain).
2. Some time elapses (rule resolver runs, conflict snapshot, etc.).
3. An admin's `grant_booking_approval` lands and flips a row.
4. TS computes `chain_config_changed` from the now-stale read.
5. RPC takes its row lock + applies the plan.

The TS-computed `chain_config_changed` may be stale at step 5. In
practice the impact is bounded:
- `grant_booking_approval` sets `responded_at` + `responded_by` but does
  not change `parallel_group` / `approver_person_id` / `approver_team_id`,
  so the chain CONFIG (the structural shape we compare) is invariant.
- A second admin edit landing in the window WOULD change the chain;
  edit serialization (the RPC's `pg_advisory_xact_lock` per booking) is
  the primary defense and prevents that.

**Decision: ACCEPT the race for now.** The advisory lock + the
chain-config-not-status semantics make the window safe in practice.

**Future hardening (when worth the engineering cost):**
- The RPC re-reads approvals INSIDE its row lock and recomputes
  `chain_config_changed` from `new_chain_config` + live state. This
  retires the TS-computed boolean as a contract field — the RPC becomes
  the single source of truth for chain identity.
- Tracked here so the next time `chain_config_changed` is mentioned in
  a defect (e.g., audit-trail discrepancy), this is the first place to
  look.

Documented in code at `loadCurrentApprovalChain`'s docstring + this
followup so the contract decision is auditable.

## Idempotency key cross-operation collision — CLOSED (Step 2F.3, 2026-05-12)

**Shipped in Step 2F.3.** `buildEditBookingIdempotencyKey` now takes an optional 3rd parameter `op: 'one' | 'slot' | 'scope'`. Every booking-edit producer route passes its discriminator:

- `editOne` → `'one'`
- `editSlot` → `'slot'`
- `editScope` → `'scope'`

Key shape with op: `booking:edit:<op>:<booking_id>:<crid>`. Tests at `apps/api/src/common/idempotency.spec.ts` lock the contract (deterministic, distinct per op, distinct from the legacy no-op shape). Helper at `packages/shared/src/idempotency.ts`.

The 2-arg legacy shape is retained for backward compat (historical fixtures + pre-2F.3 smoke probes) but every new caller passes `op`. Migration impact: no — `command_operations.idempotency_key` is free-form text, and the v1→v2 cutover passes through naturally because old keys (without op) never collide with new keys (with op — different colon position).

## Step 2F.1 dry-run idempotency contract — shipped (00371 v2)

Self-review on commit `8a89048a` (Step 2F.1 v1, 00367) flagged two
convergent issues in the dry-run × idempotency-key contract. The v2
migration (00371) drops + recreates `edit_booking_scope` with a clean
contract.

**The v1 bug:** the payload_hash on 00367 mixed `p_dry_run` into the
md5, AND the dry-run path wrote a `command_operations` row before the
per-occurrence loop. Two consequences:

1. If a TS caller used one idempotency key across an end-to-end user
   intent — `client_request_id = abc-123` covering both the "preview"
   (dry-run=true) AND the "commit" (dry-run=false) — the commit phase
   raised `command_operations.payload_mismatch` (409) because the
   hashes differed (the preview wrote a row hashed with `p_dry_run=true`;
   the commit's hash was for `p_dry_run=false`).
2. Every preview clicked an idempotency row that lived indefinitely.
   An operator previewing N times = N persisted rows.

**The v2 contract (00371):**

- Dry-run is a **stateless preview**. The function runs the
  validation block (cancelled guard, semantic re-derivation, FK
  validation, approval reconciliation, B.4.A.5 emit gate, per-occurrence
  before/after capture) and returns predicted outcomes — but does NOT
  touch `command_operations` at all. No replay check, no insert, no
  success update. No advisory lock either (no command_operations row =
  nothing to serialise).
- Commit (dry_run=false) is unchanged from v1 except the payload_hash
  is now `md5(p_plans::text)` — no `p_dry_run` mix.
- Consequence: dry-run and commit CAN share an idempotency key. The
  natural pattern (one `clientRequestId` per user-visible action) is
  the correct pattern.
- The 5-arg function signature `(jsonb, uuid, uuid, text, boolean)` is
  unchanged — TS callers don't change.

Other v2 changes folded into the same migration:

- **`booking_not_found` error bounded.** v1 raised
  `... requested=<v_booking_id_set>` which interpolated up to 200
  UUIDs (~7.6KB error string). v2 raises with a count + the first
  missing id only (DETAIL). Error string stays under 200 bytes.
- **Per-occurrence `space_id_before/after` + `start_at_before/after`**
  in the return shape so Step 2F.3's visitor cascade fan-out reads
  the diff directly instead of N re-reads.
- **`recurrence_overridden` is rejected from scope-mode plans.**
  recurrence_overridden is a per-occurrence concept (single occurrence
  diverging from the series projection). v2 raises
  `edit_booking_scope.invalid_plans` if a scope plan sets it. The
  Step 2F.2 plan-builder will assert this at build time; the RPC
  guard is defense-in-depth.
- **NL voice updated** to use "reserveringen in de serie" /
  "reeks-wijziging" instead of "afspraken" / "seriewijziging" —
  consistent with the booking-voice in the rest of the app.

Reference: `supabase/migrations/00371_edit_booking_scope_rpc_v2.sql`.

Concurrency probe additions (commit-set with 00371):

- **Tighter rollback assertions** on scenarios 5 + 7 — verify zero
  `domain_events`, zero `outbox.events`, zero `approvals`, and every
  booking row's `location_id` preserved after the abort.
- **Scenario 13:** §3.6.5 Row 3 — require_approval → allow with
  pending approvals — verifies action='expire' + status flips to
  'confirmed'.
- **Scenario 14:** §3.6.5 Row 4 — require_approval → allow with
  terminal_approved — verifies action='noop' + 'confirmed' preserved.
- **Scenario 15:** N=200 cap boundary — exact-pass test (the cap is
  inclusive; only N=201 trips `too_many_occurrences`).
- **Scenario 8 timing:** replaced the 250ms sentinel race with
  deterministic `waitForRowLockBlocker(pid)` polling on
  `pg_stat_activity` for `wait_event_type='Lock' AND wait_event IN
  ('transactionid', 'tuple')`. Removes CI flakiness under load.

## Step 2F.2 — assembleScopeEditPlan deferred items

### splitSeries belongs at the controller (Step 2F.3), not the assembler

The assembler is a pure plan-builder. `RecurrenceService.splitSeries`
(`apps/api/src/modules/reservations/recurrence.service.ts:761`) commits
side effects (writes to `recurrence_series`, `bookings`, `audit_events`).
If splitSeries lived inside `assembleScopeEditPlan`, a **dry-run
preview** ("show me what 52 occurrences would change") would silently
fork the series — catastrophic for a preview UI button.

Decision: the Step 2F.3 controller resolves `effectiveSeriesId`:

- `scope='series'` → pivot booking's current `recurrence_series_id` (no
  split)
- `scope='this_and_following'` → call `splitSeries(pivotBookingId)` on
  the **commit** path only (never dry-run)

The assembler accepts `effectiveSeriesId` as input. It is contract-pure.

### Resolver-outcome hoist (deferred perf optimisation)

For an N-occurrence series edit, `assembleScopeEditPlan` calls
`buildSingleSlotPlan` N times. Each call runs `RuleResolverService.resolve`
independently. For weekly series where every occurrence has the same
day-of-week + time-of-day, the resolver outcome is provably identical
across all N — resolving once and broadcasting would save ~N-1 resolver
round-trips.

Caveats:

- Daily series spanning weekdays may hit day-of-week rules differently
  per occurrence — NO hoist safe.
- For weekly/biweekly/monthly with identical recurrence-rule semantics —
  hoist safe.

Defer to Step 2F.4 (smoke probes). If 200-occurrence series scope edits
exceed an acceptable p95 latency budget (target: <2s end-to-end),
implement the hoist with:

- A "resolver invariance" check (`recurrence_rule.frequency === 'weekly'
  && weekday count === 1` → hoist; else per-occurrence)
- Mock test fidelity: include both hoist-eligible and non-eligible
  series fixtures, with diverging per-occurrence rules

### Plan-builder helpers read tenant from ALS — Phase 8 refactor

**Vulnerability surface.** `AssembleEditPlanService.buildSingleSlotPlan`
fans out to three helpers that read the active tenant from
`TenantContext.current()` (AsyncLocalStorage), NOT from the explicit
`args.tenantId` flowing through the plan-builder:

- `BookingFlowService.loadSpace` —
  `apps/api/src/modules/reservations/booking-flow.service.ts:1251`
  (`const tenantId = TenantContext.current().id`).
- `RuleResolverService.resolve` —
  `apps/api/src/modules/room-booking-rules/rule-resolver.service.ts:88`
  (reads tenant from TenantContext at every entry).
- `ConflictGuardService.snapshotBuffersForBooking` —
  `apps/api/src/modules/reservations/conflict-guard.service.ts:138`.

A fourth helper —
`edit-plan-helpers.ts::loadCurrentApprovalChain` — already accepts
`tenantId` explicitly (its call site at `assemble-edit-plan.service.ts:
674` passes `args.tenantId`), so it's NOT part of this surface.

**Failure mode.** If `TenantContext.current()?.id !== args.tenantId`
(ALS not set, async context loss, programmatic caller mismatch — e.g.,
a job or test that builds args.tenantId from a different source than
the ALS-stored tenant), the helpers route their reads to the wrong
tenant via the `supabase.admin` client. The admin client bypasses RLS,
so the wrong-tenant rows return as if they were the right ones — silent
cross-tenant leak through rules/spaces/conflict-window reads. The pivot
booking + scope-rows reads in `assembleScopeEditPlan` (lines 425-487 in
the v3 file) filter by `args.tenantId` and are safe; the leak is in the
per-occurrence helpers.

**Step 2F.2 mitigation (shipped 2026-05-12).** A hard-assert at every
plan-builder entry point — `assembleSlotEditPlan` (Step 2D-C),
`assembleOneEditPlan` (Step 2E), `assembleScopeEditPlan` (Step 2F.2) —
raises `edit_booking.tenant_context_mismatch` (500) when
`TenantContext.current()?.id !== args.tenantId`. The assertion fires
BEFORE any DB I/O, so a drift can never reach the helpers. Tests at
`apps/api/src/modules/reservations/__tests__/
assemble-edit-plan.service.spec.ts` cover all three entry points.

**Proper long-term fix (Phase 8).** Thread `tenantId` explicitly
through every helper signature so they don't depend on `TenantContext`
for data-plane queries:

- `BookingFlowService.loadSpace(tenantId: string, spaceId: string)`
- `RuleResolverService.resolve(tenantId: string, input: ResolveInput)`
- `ConflictGuardService.snapshotBuffersForBooking(tenantId: string,
  input: ConflictGuardInput)`

This makes the tenant scope a typed argument the caller MUST provide
(can't be silently absent), and removes the ALS dependency from the
data-plane query path entirely. The TenantContext stays for
audit-event tagging, outbox emission, and middleware concerns where
ambient context is the right shape.

**If mitigation is bypassed.** Removing the hard-assert without
threading tenantId through the helpers re-introduces the silent
cross-tenant leak. The assertion is the load-bearing structural
defense until Phase 8 lands.

## Tier C item #8 — `emitVisitorCascadeForBundle` `@internal` tag — CLOSED (2026-05-12)

`apps/api/src/modules/reservations/reservation.service.ts:1972-1990` —
added `@internal` JSDoc tag explaining why the method is `public` (single
sibling-method caller inside the same service: `editScope`) and what
the proper home is when a second caller appears (a shared
`BundleEventEmitter`, not currently built). Discourages accidental
imports from outside `ReservationService`.

The tag itself is informational — TypeScript honors `@internal` only
when `stripInternal: true` is set in `tsconfig.json` (it isn't here),
so this is documentation for future maintainers rather than a compile-
time gate. The structural defense is the single-file location of the
caller; relax to `private` when no longer needed.

## Step 2F.3 — deferred items

### In-flight retry hazard across the deploy window — DEFERRED to launch-time

Step 2F.3 changed `buildEditBookingIdempotencyKey` to accept an
optional op discriminator. Existing callers (editOne, editSlot) now
pass `'one'` / `'slot'` / `'scope'` — minting 5-segment keys. In-
flight client retries from BEFORE the deploy used 4-segment legacy
keys; after the deploy, those retries mint NEW 5-segment keys and
miss the in-flight `command_operations` cached_result row.

**Risk:** double-write on retry across the cutover window (RPC re-
runs the write under a new key).

**Mitigation options:**
- **Option A — operational drain.** Pause writes to the booking-edit
  routes during the deploy window. Smallest code change (zero); the
  client-side `command_operations` cache shows in-flight retries
  via `outcome='in_progress'` rows — wait for those to terminal before
  flipping traffic.
- **Option B — fallback read in `command_operations` lookup.** If
  the 5-segment key misses, retry the lookup with the legacy
  4-segment shape (`booking:edit:<bid>:<crid>`). If the legacy hits
  with `outcome='success'` and a `cached_result`, return that as the
  retry response. Adds ~15 LOC to the idempotency-resolve path; net
  removable once the deploy window closes.

**Trigger condition.** The hazard fires ONLY across an actual
production deploy where customers have client-side state from the
pre-Step-2F.3 build. Per project status (`project_no_wave1_yet.md`)
no production customers exist yet; the deploy window for the
op-discriminator change has effectively already passed (all current
clients are post-2F.3 dev / smoke / staging).

**Resurfacing trigger.** When the project takes its first
customer-facing cutover that involves an op-discriminator-shape
change (or any wire-format change to `command_operations` idempotency
keys), revisit this section. At that point either Option A (drain) or
Option B (fallback read shim) ships in the same release as the
change. The pre-deploy runbook checklist should include "review
idempotency-key shape drift since last release; if non-zero, choose
drain or shim BEFORE the cutover."

**Test scenarios at `apps/api/src/common/idempotency.spec.ts:113-126`
already document the divergence at the unit-test level**, so a future
fallback-read implementation has a contract to write against without
re-discovering the failure mode.

**Status:** Tier B item #7 — CLOSED as DEFERRED (2026-05-12). The
risk is documented; the mitigation choice is parameterised by the
launch-time deploy posture (drain vs shim); the test fixture for the
shim already exists. Re-opening triggered by first customer-facing
cutover.

### Visitor cascade fan-out — batch optimization — CLOSED (2026-05-12)

Shipped at commit `b72b2bde` + remediation `1fc3750d`. New sibling
method `ReservationService.emitVisitorCascadesForBundles` batches the
visitor lookup from N `.eq('booking_id', bundleId)` calls (one per
moved occurrence) into one `.in('booking_id', bundleIds[])` query. For
200-occurrence series that's a 200→1 round-trip reduction post-RPC.

Implementation notes:
- **Singular method retained** for editOne/editSlot (1 bundle per call;
  no batching benefit). Both singular and plural now delegate to a
  shared private helper `emitVisitorCascadeEvents` so the per-visitor
  emit payload stays byte-identical between the two paths.
- **Single-tenant assertion** — plural throws `booking.cascade_cross_
  tenant_batch` (500 AppError, 5-site registry) if `items[]` spans
  multiple tenants. Defensive against future programmer error.
- **bundleId deduplication** — plural filters duplicate bundleIds out
  of the items array before the `.in()` query + emit loop. editScope's
  current caller can't produce duplicates (per_occurrence has unique
  booking_ids per the 00371 RPC contract), but the method's public
  contract no longer depends on caller-side uniqueness.
- **Per-bundle isolation** — inner try/catch around each emit so a
  thrown subscriber on bundle N doesn't block bundles N+1..M. Mirrors
  the singular's outer try/catch posture.
- **9 new vitest scenarios** at `reservation-edit-scope-cascade-batch
  .spec.ts` cover: empty input, missing bus, single item, multiple
  items + grouping, defensive (null axes), `.in()` error, `.in()`
  thrown (network-class), cross-tenant assertion, per-bundle emit
  isolation.

`editScope` cascade loop (was `reservation.service.ts:1909-1933`)
migrated to: collect cascadeItems[] from `result.per_occurrence`,
filter to time-or-room moved, then ONE call to the plural method.

### Frontend hook tests for useEditBookingScope[DryRun]

Sibling edit hooks (useEditBooking, useMoveBooking) are also
untested. Backlog for a future test-coverage sweep.

### `emitVisitorCascadeForBundle` exposure

Made public on `ReservationService` for the single new `editScope`
caller. Future cleanup: add `@internal` JSDoc tag to discourage
accidental imports, or move to a shared service if a third caller
appears.
