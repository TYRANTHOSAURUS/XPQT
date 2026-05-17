# Slice 3 (multi-room atomic create) — §7a validator table-assignment decision + residuals

Booking-audit remediation Slice 3 (audit `docs/follow-ups/audits/03-booking-reservation.md`
P1-1, D-4). Mirrors the honesty/structure of
`docs/follow-ups/cancel-booking-equivalence-checklist.md`: every
non-obvious decision and every accepted residual is enumerated EXPLICITLY
— none is silent.

## 1. The §7a / §7c / §7d table-assignment decision (migration 00410)

`validate_attach_plan_internal_refs` (live body: 00313, superseded by
00410) snapshot-validates three id arrays before any insert inside
`create_booking_with_attach_plan`. Each must point at the table whose ids
it actually carries:

| Block | Field validated | Correct table | Decision |
|---|---|---|---|
| **§7a** | `p_booking_input->'applied_rule_ids'[]` | `public.room_booking_rules` | **00410: repointed `service_rules` → `room_booking_rules`** (the D-4 fix) |
| **§7c** | `attach_plan.order_line_items[].setup_emit.rule_ids[]` | `public.service_rules` | **UNCHANGED** — genuine attach-plan service-rule ref |
| **§7d** | `attach_plan.approvals[].scope_breakdown.reasons[].rule_id` | `public.service_rules` | **UNCHANGED** — genuine attach-plan service-rule ref |

### Why §7a is `room_booking_rules` (NOT service_rules)

`applied_rule_ids` is the matched ROOM rule id set. The room-rule
resolver (`RuleResolverService`) queries `room_booking_rules` ONLY:
`rule-resolver.service.ts:217` (`fetchCandidateRules`) and `:229`
(`fetchAllRules`) — both `.from('room_booking_rules')`. There is no code
path where the resolver returns a `service_rules` id.

### Why §7c / §7d stay `service_rules`

They are populated on the ATTACH-PLAN (service) side:
- §7c `setup_emit.rule_ids[]` — the catalog-item/service-rule ids that
  triggered an internal setup-WO emit (service-routing matrix).
- §7d `approvals[].scope_breakdown.reasons[].rule_id` — multi-room
  `attachPlan.approvals` are `ApprovalRoutingService` SERVICE-rule
  approvals (assembled from `service_rules`). They are distinct from the
  ROOM-rule approvals, which are wired TS-side as a post-RPC fan-out
  (see §2). Room-rule approvals never flow through
  `attach_plan.approvals[].reasons[].rule_id`, so §7d is not affected by
  the room-rule path.

### Verification — exhaustive, not just the 2 read paths

The brief's caution: §7a must not be "fixed for the 2 known readers"
while a third producer smuggles non-room-rule ids in. Every producer
that reaches `create_booking_with_attach_plan` with an
`applied_rule_ids` was grepped in this session:

- **`booking-flow.service.ts:948`** (single-room combined-RPC path):
  `applied_rule_ids: ruleOutcome.matchedRules.map((r) => r.id)` —
  RuleResolverService → `room_booking_rules`. Invoked at
  `booking-flow.service.ts:537`.
- **`multi-room-booking.service.ts:318`** (multi-room combined-RPC
  path): `applied_rule_ids: Array.from(matchedRuleIds)` where
  `matchedRuleIds` is filled exclusively from
  `ruleOutcome.matchedRules` (`multi-room-booking.service.ts:212`) —
  RuleResolverService → `room_booking_rules`.
- **`order.service.ts:1105`**: `applied_rule_ids: []` — a DIRECT
  `bookings` insert (NOT the combined RPC), always empty; §7a is a
  no-op for it.
- **`recurrence.service.ts`**: creates bookings only via
  `BookingFlowService.create` (no direct `applied_rule_ids`); inherits
  the room-rule resolver source.
- **`calendar-sync/*`**: never sets `applied_rule_ids`.
- The combined RPC has exactly **two** invocation sites
  (`booking-flow.service.ts:537`, `multi-room-booking.service.ts`); no
  other caller exists.

Conclusion: `applied_rule_ids` reaching `create_booking_with_attach_plan`
is ALWAYS room-rule-resolver-sourced or empty. §7a→`room_booking_rules`
is **exhaustively correct**, not narrowly correct for two readers.

A future producer that stuffs non-room-rule ids into `applied_rule_ids`
would itself be a contract violation (the field's meaning is "matched
ROOM rule ids" — it bakes into the immutable audit trail). §7a MUST NOT
be broadened to a `room_booking_rules UNION service_rules` membership
check: that would weaken the cross-tenant-snapshot-smuggle guard
(§7's whole purpose — a smuggled id that exists in *either* table would
pass). The narrow check is the security property; keep it narrow.

## 2. Option B (multi-room calls the combined RPC directly) vs audit §154

Audit §154 raised the option of routing multi-room through the
single-room `BookingFlowService` pipeline (one approval-wiring code
path). **Decision: Option B — multi-room invokes
`create_booking_with_attach_plan` directly and byte-mirrors
`createApprovalRows`; `booking-flow.service.ts` is left untouched.**

- **Accepted trade:** lower blast radius. Touching
  `BookingFlowService` to expose a shared approval-wiring helper would
  put the single-room create path (the highest-traffic booking route)
  in scope of a multi-room slice. Mirroring the small
  `createApprovalRows` body into `MultiRoomBookingService` keeps the
  single-room file out of the diff entirely.
- **KNOWN drift risk (explicit, not silent):** `createApprovalRows` is
  now duplicated in two files —
  `booking-flow.service.ts` (`private createApprovalRows`, the
  single-room source of truth) and
  `multi-room-booking.service.ts` (`private createApprovalRows`, the
  byte-mirror). Both carry a "keep in lockstep with single-room"
  comment. If the single-room approval-row shape changes (e.g. a new
  `approvals` column, a chain-id semantics change), the multi-room
  mirror MUST be updated in the same change.
- **Owner:** booking-audit workstream. **Revisit trigger:** any change
  to single-room approval-row wiring (`BookingFlowService.createApprovalRows`
  or the `:385-396` resolve→approval block) — at that point reconsider
  consolidating into a shared helper if the duplication has caused (or
  is about to cause) a real divergence.

## 3. FIX 2 — cross-room approval priority aggregation (correctness, not silent)

Single-room consumes ONE prioritized resolver outcome: the resolver
picks the winning `require_approval` rule by
most-specific-then-highest-priority
(`rule-resolver.service.ts:541-542`). Multi-room does N independent
resolves (one per room). The pre-FIX-2 code kept the FIRST
`require_approval` outcome in SPACE ORDER — arbitrary; it could wire a
low-priority rule's approvers when a higher-priority `require_approval`
rule matched a different room.

**FIX 2:** collect every matched `require_approval` rule across ALL
rooms, then select the booking-level winner with the resolver's
IDENTICAL comparator (lower `specificity` wins; tie-break by higher
`priority`). The winner's `approval_config` + `workflow_definition_id`
drive the booking-level fan-out — semantically equal to single-room's
single aggregated outcome. Covered by the spec
"uses the HIGHEST-priority require_approval rule across rooms, not the
first in space order (FIX 2)" (fails pre-fix, passes post-fix).

## 4. Accepted residuals (EXPLICIT — none silent)

| # | Residual | Owner | Risk |
|---|---|---|---|
| **R-a** | The `workflow_definition_id` branch (a room rule carrying `approval_workflow_definition_id` → `WorkflowService.start` instead of `createApprovalRows`) is a byte-mirror of single-room's wiring but is **UNPROBED for multi-room** in the live smoke (the smoke's matched off-hours rule has no workflow def → it exercises the `createApprovalRows` leg only). Covered by jest ("starts a workflow instead of legacy approval rows…"). | this workstream | **Low** — single-room precedent + jest coverage; the live gap is the workflow-start leg only, behind a feature-flagged column most tenants don't populate. |
| **R-b** | Idempotency replay under a mid-flight rule-effect flip (a matched rule's effect changes between the first attempt and the retry) → the rebuilt plan no longer hashes to the cached payload → `attach_operations.payload_mismatch` → 409 `booking.idempotency_payload_mismatch`. This is **IDENTICAL to single-room parity**, not a multi-room regression — the determinism guarantee is over a stable rule state, not over time. (JSDoc tightened in `multi-room-booking.service.ts` step 3.) | n/a (documented parity) | **Low** — same behavior as single-room; surfaces as a clean retryable 409. |
| **R-c** | 00410 is **forward-only on the shared remote** (it `create or replace`s `validate_attach_plan_internal_refs`; 00313 is NOT edited in place). Rollback = a follow-up migration restoring 00313's §7a — **undesirable**: it reinstates the D-4 bug (every matched room rule → 400). There is no clean revert; forward-fix only. | booking-audit workstream | **Bounded** — 00410 is verified correct by 3 independent diffs (only §7a `service_rules→room_booking_rules`; §6/§7c/§7d/signature/grants byte-identical to 00313). Reverting is a deliberate regression, never automatic. |

## 5. Smoke contract (smoke-create-multi-room.mjs)

Post-00410 the gate asserts the REAL behavior (no "broken"/"residual"/
"needs authorization" language anywhere — see `docs/smoke-gates.md`):

- (a) atomic 3-room create-with-services; 1 booking + 3 slots + orders +
  OLIs + asset_reservations; exactly 1 `attach_operations` row.
- (b) idempotency replay → same `group_id`, no duplicates.
- (c) partial-room conflict → 409 `multi_room_booking_failed`, whole tx
  rolls back (zero new rows).
- (d) cross-tenant space → 404 `space_not_found`, no partial create.
- (e) missing `X-Client-Request-Id` → 400.
- (f) require_approval room rule (off-hours 00133 tenant rule) → 200/201
  `pending_approval` + approval rows matching the matched rule's
  `required_approvers` (read from DB, no hardcode) + atomic N-slot/
  service commit; **NO §7a `attach_plan.internal_refs` 400** and
  `applied_rule_ids` persisted non-empty (the real 00410 signal — the
  prior "every id resolves in room_booking_rules" check was a tautology
  and was removed).
- (g) SINGLE-room create-with-services + matched room rule (same
  off-hours rule, one space, via POST /reservations → BookingFlowService
  → the same combined RPC) → 201, booking present, `applied_rule_ids`
  non-empty, NO §7a 400. This covers the LARGEST 00410 blast radius:
  single-room create-with-services where a room rule matched was a
  pre-existing, never-smoke-covered latent break.

Cleanup is run-scoped: only the exact idempotency keys this run minted
are deleted from `attach_operations` (never a tenant-wide
`like 'booking.create:%'` sweep — that would clobber sibling smokes'
ledger rows on the shared remote).
