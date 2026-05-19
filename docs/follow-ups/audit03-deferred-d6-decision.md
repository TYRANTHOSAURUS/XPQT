# audit-03 D-6 — attach/create producer-determinism — DECISION + CLOSURE

**Status:** CLOSED (audit-03 deferred-closeout). Supersedes the
deferred-with-owner disposition in `slice5-attach-services-decision.md`
§D-6 and the 2026-05-17 D-6 row in
`docs/follow-ups/audits/03-booking-reservation.md`. This doc is the
authoritative record of (a) the falsified standing claims, (b) the three
nondeterminism vectors, (c) the corrected request-canonical-basis design,
(d) the FE-pin deferred-with-owner residual, (e) the completeness proof.

Append-only: the prior D-6 records (slice5 decision §D-6 + the 2026-05-17
ledger row) are left verbatim; this supersedes them via new content, it
does NOT rewrite them.

---

## 1. The falsified standing claims (proven FALSE)

The slice5 decision §D-6 + the 2026-05-17 ledger row asserted three things
that are now PROVEN false against the live code + the v6 contract:

1. **FALSE: "`lead_time_remaining_hours` is the SOLE nondeterministic
   field."** There are THREE orthogonal vectors (§2). One is entirely
   TIME-INDEPENDENT (unsorted rule fetch → unsorted matched-id arrays),
   so even a zero-elapsed-time retry could 409.

2. **FALSE: "create `p_booking_input` is deterministic + collections are
   pre-sorted."** The create path bakes the SAME wall-clock-derived
   `lead_time_minutes` (room resolver) + `lead_time_remaining_hours`
   (service producer) into `policy_snapshot` / `applied_rule_ids` /
   `bookingInput.status` / the hashed `p_attach_plan`. The completeness
   guard's NO-FIX create arm reproduces a 13-key-path diff.

3. **FALSE: "fix = persist the basis in the `*_operations` row on first
   attempt and reuse on retry."** ARCHITECTURALLY DEAD: the 00302/00316
   v6 `command_operations` / `attach_operations` contract ROLLS BACK the
   `in_progress` row on exactly the failure classes that trigger a retry
   (deny / FK miss / GiST conflict / mismatch). Nothing server-persisted
   survives to be "reused on retry". The basis MUST be request-canonical,
   not attempt-wall-clock-then-persisted.

## 2. The three orthogonal nondeterminism vectors

All feed the idempotency-hashed payloads — attach
(`md5(p_attach_plan::text)`, 00412/00413) and create
(`md5(p_booking_input || '|' || p_attach_plan)`, live 00372 body).

- **V1 (attach + create).** `bundle.service.ts hydrateLines`
  `const now = Date.now()` → `leadRemaining` →
  `lead_time_remaining_hours` on the hydrated line → the service-rule
  resolver context → the service-rule OUTCOME → serialized into the plan
  (`pending_setup_trigger_args` / `setup_emit` / approvals).

- **V2 (create).** `room-booking-rules/rule-resolver.service.ts`
  `assembleContext` `Math.round((startMs - Date.now())/60_000)` →
  `EvaluationContext.booking.lead_time_minutes` → room-rule outcome →
  `booking-flow.service.ts` `bookingInput.status`, `applied_rule_ids`,
  `policy_snapshot.matched_rule_ids` / `effects_seen` /
  `rule_evaluations` → hashed `p_booking_input`.

- **V3 (attach + create).**
  - **V3-time:** `predicate-engine.service.ts` `lead_minutes_lt` /
    `lead_minutes_gt` operators called `Date.now()` directly (used by
    `min_lead_time` / `max_lead_time` rule templates) — both the service
    and room engines share this code.
  - **V3-order (TIME-INDEPENDENT):** `service-rule-resolver.service.ts
    fetchAllRules` + `room-booking-rules/rule-resolver.service.ts`
    `fetchAllRules` AND `fetchCandidateRules` had NO `ORDER BY`. Within a
    (specificity, priority) tie, `Array.prototype.sort` is stable, so the
    tie followed arbitrary DB row order → unsorted `matched_rule_ids` /
    `applied_rule_ids` / `policy_snapshot.*` /
    `scope_breakdown.reasons` / `setup_emit.rule_ids` /
    `pending_setup_trigger_args.ruleIds` in the hashed payload — a
    spurious mismatch with ZERO wall-clock movement.

## 3. The corrected design (request-canonical basis, not attempt-clock)

Per-vector, attach vs create are ASYMMETRIC by necessity:

- **STEP 1 — attach: server-only basis, ZERO FE coupling.**
  `hydrateLines` uses `Date.parse(booking.created_at)` (the booking
  already exists for attach; `created_at` is server-assigned + immutable;
  the codebase already anchors hash-determinism on `created_at` at
  00372:~385-392 — this mirrors that established pattern). Attach is now
  FULLY deterministic across retries with NO client cooperation.

- **STEP 2 — create: ONE request-canonical instant, defaulted once.**
  `ActorContext.resolution_basis_at` (ISO). Defaulted ONCE at the single
  controller chokepoint `reservation.controller.ts actorFromRequest` to
  `new Date().toISOString()`, OR a valid `X-Request-Time` header if
  present (the FE-pin seam, §4). Threaded:
  ActorContext → `BookingFlowService.buildAttachPlan` → (a) the
  service producer (`bundle.buildAttachPlan` via `args.booking.created_at`
  on the create path → `hydrateLines`), (b) the room-rule resolver
  (`BookingScenario.resolution_basis_ms` → `assembleContext`),
  (c) the predicate engine (`BaseEvaluationContext.resolution_basis_ms`
  → `lead_minutes_*`). Multi-room create (`MultiRoomBookingService`)
  inherits the identical producer + room resolver and is anchored on the
  SAME basis.

- **STEP 3 — V3-order: deterministic tie-break (MANDATORY, in-scope,
  NON-deferrable, time-independent).** `.order('id', { ascending: true })`
  added to `service_rules` `fetchAllRules`, `room_booking_rules`
  `fetchAllRules` AND `fetchCandidateRules`. The (specificity, priority)
  comparator is UNCHANGED — only the tie-break among equal-(specificity,
  priority) rules becomes deterministic: previously DB-arbitrary, now
  lowest-id wins. Additionally, every matched-id collection is
  canonically sorted before serialization (belt-and-suspenders):
  `policy_snapshot.matched_rule_ids` / `effects_seen` /
  `rule_evaluations` / `applied_rule_ids` (booking-flow + multi-room
  re-derive from ONE sorted matched-rule array so the positional
  alignment of effects/evaluations is preserved),
  `pending_setup_trigger_args.ruleIds` / `setup_emit.rule_ids`
  (bundle.service.ts), `scope_breakdown.reasons` (approval-routing
  `assemblePlan`, sorted by `(rule_id, denial_message)`).

  **Routing-doc sync (CLAUDE.md mandate):**
  `docs/assignments-routing-fulfillment.md` updated IN THE SAME COMMIT to
  document the now-deterministic tie-break (a STABILIZATION — equal
  specificity+priority rules now resolve lowest-id-first instead of
  DB-arbitrary — NOT a semantic redefinition; deny>approval>warn>allow
  precedence and the specificity/priority ordering are unchanged). The
  rule-resolver / routing jest specs were run: no existing routing
  expectation relied on the arbitrary order (zero new failures).

## 4. FE-pin — DEFERRED-WITH-OWNER (discovered residual, bounded)

The `X-Request-Time` header is honored at the controller chokepoint, but
the web client does NOT yet mint + resend a stable `requested_at` paired
with `clientRequestId` on a same-crid retry. So a same-crid create retry
that straddles a lead-time boundary AND does NOT resend the original
instant would recompute a fresh server-default basis (attach is immune —
it uses the server `created_at`).

- **Owner:** a future producer-determinism / FE-pin follow-up.
- **Risk:** same-crid create auto-retry across a lead-time boundary
  recomputes the basis (only the create path; attach unaffected).
- **Mitigant (verified):** `apps/web/src/lib/query-client.ts:~29-31` sets
  mutations `retry: false` app-wide, and the create/attach mutation hooks
  add no per-hook retry. So a same-`clientRequestId` AUTO-retry is
  currently RARE (it would take a manual user re-submit reusing the same
  crid — which the crid scheme is specifically designed to make a NEW
  crid for a new click). D-6 is real-but-low-frequency; the bounded
  residual is explicitly OWNED, not silent. NO FE change shipped in this
  slice (the controller seam is in place for the follow-up to use).

## 5. Completeness proof (the misdiagnosis-#N tripwire)

New jest guard `bundle-attach-plan.determinism.spec.ts` drives the REAL
producers (`BundleService.buildAttachPlan` + `BookingFlowService`
`buildAttachPlan`, real `ServiceRuleResolverService` +
`RuleResolverService` + `PredicateEngineService`) TWICE, seeding ALL
THREE vectors at once: a `lead_minutes_gt` service rule + a
`lead_minutes_lt` room rule (V3-time/V1), a `$.booking.lead_time_minutes`
band room rule (V2), and ≥2 rules tied on (specificity, priority) fed in
DESCENDING-id order (V3-order).

- **WITHOUT the fix** (basis = the per-run advancing wall-clock — the
  pre-fix `Date.now()` behaviour): attach `equal=false` (diff at
  `order_line_items[0].pending_setup_trigger_args` +
  `approvals[0].scope_breakdown.reasons[2]`); create `equal=false`
  (13-key-path diff across `bi.status`, `policy_snapshot.*`,
  `applied_rule_ids`, `ap.*`). The vectors are REAL, not vacuous.
- **WITH the fix** (basis = ONE request-canonical instant): attach
  `equal=true deepDiff=[]`; create `equal=true deepDiff=[]` for BOTH
  `p_booking_input` AND `p_attach_plan`. The OUTCOME is byte-stable, not
  just one field. The completeness assertion `expect(diff).toEqual([])`
  HARD-FAILS on any 4th vector — it PASSED, so **no 4th vector**.

**Explicitly-considered-and-EXCLUDED:** `booking-flow.service.ts:~1015`
`startSeries`'s `new Date(Date.now()+90d)` horizon is a POST-COMMIT
fire-and-forget recurrence call (`void this.startSeries(...)` AFTER the
RPC returns) — NOT part of `buildAttachPlan`'s returned
`{ bookingInput, attachPlan }`, therefore NOT in the hashed payload. The
guard exercises `buildAttachPlan` ONLY (never invokes the RPC /
startSeries), so it cannot leak into the diff by construction. Out of
D-6 scope by design — documented so the guard does not false-flag it.

## 6. No migration, no FE change

The RPCs hash whatever plan they receive (`md5(p_attach_plan::text)` /
`md5(p_booking_input || '|' || p_attach_plan)`). The fix is 100% TS
producer/resolver/predicate-engine determinism — NO migration. NO FE
change (FE-pin deferred-with-owner; the `X-Request-Time` controller seam
is in place for the follow-up).

## 7. Smoke

`apps/api/scripts/smoke-attach-services.mjs` probe (8) is a real
fail-closed determinism gate: seed a tenant lead-time-boundary
`service_rules` rule, attach with a crid, replay the SAME crid after the
wall-clock crosses the boundary → assert 2xx CACHED (not 409), exactly
one `attach_operations` row `outcome=success`, zero dup rows. The
genuine payload_mismatch probe (3) is kept (it asserts mismatch on a
genuinely-different payload — still correct). The create-path analog is
covered by the jest completeness guard + owned (the smoke server cannot
trivially advance its own wall-clock between two HTTP calls; the guard
drives the real producer with a controlled clock, which is the stronger
proof). `docs/smoke-gates.md` updated.
