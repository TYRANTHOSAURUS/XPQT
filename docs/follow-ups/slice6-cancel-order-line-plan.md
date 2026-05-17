# Slice 6 plan — P1-4 `cancel_order_lines_with_cascade` RPC (audit 03 :179)

Status: **CLOSED 2026-05-17 (Slice 6 shipped).** P1-4 closed; `migration 00414`
on remote; `pnpm smoke:cancel-order-line` 55/0 exit 0; tsc/errors green; jest 408
pass (3 = pre-existing unrelated `visitors/admin.controller.spec.ts`); two-checkpoint
2-agent review done (codex 0-byte-hung→skipped per protocol) with all
plan-review + impl-review + own-smoke findings fixed in-slice. Accepted residual:
`recurrence_scope` audit-shape drift (inert). The original PLAN text + plan-review
remediation + fix-cycle sections below are kept verbatim as the dated record.

> **Prior status (point-in-time, superseded):** PLAN — pre-coding, pending 2-agent
> plan-review (checkpoint 1). Codex
plan-gate skipped (0-byte hung every attempt this session — protocol-allowed per
[[feedback_review_loop_protocol]]; the 2-agent self plan-review is the load-bearing
gate). Direction-class calls (D1–D5 below) made by the orchestrator with explicit
rationale rather than bounced to the user (per `feedback_ask_codex_not_user_for_direction`,
codex unavailable → own judgment + review gate).

## Finding (audit 03 P1-4, current text)

`BundleCascadeService.cancelLine` / `cancelBundle` are TS-orchestrated: single-line
cancel does UPDATE OLI status → maybe UPDATE asset_reservation → maybe UPDATE ticket →
maybe re-scope/close approvals → maybe close bundle — all separate writes, no
transaction. Partial failure ⇒ wrong total cost, orphan asset reservation, mismatched
daglijst. Plus a best-effort **in-process** `BundleEventBus` emit after the writes
(lossy on crash — the same data-loss class P0-1 eliminated for booking-cancel).

## Goal

ONE atomic idempotent PL/pgSQL RPC mirroring `cancel_booking_with_cascade` (00408)
replacing BOTH TS entry points; eliminate the lossy in-process emit by emitting a
durable outbox event in-tx and routing the visitor cascade through a durable handler
(mirroring Slice 2's `booking-cancelled-cascade.handler.ts`).

## Direction decisions (rationale; pressure-test these in plan-review)

- **D1 — one set-based RPC for BOTH cancelLine + cancelBundle.** `cancel_order_lines_with_cascade(p_booking_id, p_line_ids uuid[]|null, p_keep_line_ids uuid[]|null, p_tenant_id, p_actor_user_id, p_reason, p_idempotency_key)`. `p_line_ids` non-null → explicit lines (cancelLine = single-element). NULL → all cancellable under the booking, honouring `p_keep_line_ids` (cancelBundle). Collapses the two non-atomic TS paths into ONE canonical pattern — the audit's "one pattern per multi-write op" thesis — exactly as 00408 collapsed this/this_and_following/series into one RPC. The cancellable-set partition is computed INSIDE the RPC against FOR-UPDATE-locked rows (must not drift between preflight and write).
- **D2 — durable outbox event in-tx; retire the lossy in-process bus for this path.** The Slice-2 equivalence checklist froze "in-process bus stays for cancelLine/cancelBundle (P1-4)" — that was Slice-2 *scope control*, not a permanent architectural mandate. Slice 6 IS the P1-4 slice; the audit thesis + best-in-class (not lean) + "evaluate infra for end-game, don't silently defer" demand the durable path now. `bundle-cascade.adapter.ts:299` shows per-line cancel DOES drive a real visitor state transition (not a no-op), so the in-process emit is genuinely lossy. RPC emits `order_line.cancelled` (per cancelled line) + the bundle-level cascade event in-tx; the visitor cascade moves behind a durable handler reusing the adapter logic exactly as `booking-cancelled-cascade.handler.ts:166-179` does for booking-cancel. If the consumer-side handler is larger than mirroring Slice 2's, the RPC + durable in-tx event ship now and the durable consumer is a **bounded same-slice follow** — but the lossy in-process emit MUST be removed (it is the data-loss class the finding names; NOT a deferred residual).
- **D3 — rescope logic inlined in the RPC.** `rescopeApprovalsAfterLineCancel` is used only here; 00408 inlines all cascade logic. No helper RPC. Reproduce the exact scope_breakdown filter + auto-close-if-empty semantics.
- **D4 — add `RequireClientRequestIdGuard` to the two DELETE routes.** `DELETE /reservations/:id/services/:lineId` + `DELETE /reservations/:id/bundle` currently have NO guard and thread no clientRequestId; the RPC's command_operations gate needs `p_idempotency_key`. Mirror the cancel/edit/attach producer-route pattern.
- **D5 — SECURITY DEFINER (cancel-family posture).** Verified on remote: `cancel_booking_with_cascade`=`t`, `split_recurrence_series`=`t` (DEFINER); `create/attach`=`f` (INVOKER). The prompt names 00408 as the cancel-family template; mirroring it = DEFINER is *consistent* (NOT the I1 drift — there the attach RPC claimed to mirror the INVOKER create template but was DEFINER; here the named template IS definer). The create/attach-vs-cancel/split definer/invoker split is recorded as a P2/P3-cleanup observation, NOT silently changed in this slice.

## RPC shape (mirror 00408 — verify each clause vs 00408 + live, never assume)

1. arg null/shape guards; `p_line_ids` XOR semantics with `p_keep_line_ids`.
2. F-CRIT-1: `select users.id where auth_uid=p_actor_user_id and tenant_id=p_tenant_id` → raise `cancel_order_lines_with_cascade.actor_not_found` (cancel-family uses F-CRIT-1, per 00408).
3. advisory xact lock `hashtextextended(p_tenant_id||':oli-cancel:'||p_booking_id,0)`.
4. command_operations gate: deterministic md5 over `(p_booking_id, sorted(p_line_ids), sorted(p_keep_line_ids), p_tenant_id, v_actor_user_id, coalesce(p_reason,''))` — **arrays MUST be sorted before hashing** (D-5/D-6 nondeterminism-class avoidance — no Date.now/random/unsorted); cache-hit return, payload-mismatch 409, in_progress→success.
5. booking SELECT FOR UPDATE (tenant-scoped) → raise `booking_not_found`.
6. resolve cancellable OLI set: tenant-scoped; **fulfilled-protected set reproduced VERBATIM from the live `bundle-cascade.service.ts` partition with file:line citation** (digest enum was stale — live `fulfillment_status` CHECK = `ordered|confirmed|preparing|en_route|delivered|cancelled`; the RPC must use exactly the values the live TS treats as fulfilled/cancellable, not an invented set); exclude `p_keep_line_ids`; raise `line_not_found` / `line_not_in_bundle` / `line_already_fulfilled` mirroring current TS errors + statuses.
7. UPDATE asset_reservations→cancelled (linked_asset_reservation_id of cancelled lines, tenant, status='confirmed').
8. UPDATE work_orders→closed,closed_at (linked_order_line_item_id ∈ cancelled, status_category ∈ non-terminal whitelist — mirror 00408 7.b).
9. UPDATE order_line_items→fulfillment_status='cancelled', pending_setup_trigger_args=null; capture distinct order_ids.
10. UPDATE orders→cancelled WHERE id ∈ captured AND zero non-cancelled lines remain (I-3 collateral-flip guard, mirror 00408 7.d).
11. approval RESCOPE: per pending approval targeting the booking, drop cancelled {oli,ticket,asset_reservation} ids from scope_breakdown; empty→expired+responded_at+comments; else UPDATE scope_breakdown. Reproduce TS semantics exactly.
12. conditional booking/slot close: reproduce `cancelBundleImpl`'s live condition VERBATIM with citation (no fulfilled + no kept + not reservation-scoped). Do NOT strengthen/weaken — if the live condition looks buggy, log a discovered finding, don't silently fix in P1-4.
13. in-tx audit_events (order.line_cancelled / bundle.cancelled continuity) — NOT swallowed.
14. in-tx domain_events intent log if the 00408 pattern has one.
15. in-tx `outbox.emit('order_line.cancelled', …)` per cancelled line (+ bundle-level cascade event for the all-lines path), idempotency-keyed.
16. finalize command_operations success; return `{cancelled_line_ids, cascaded:{ticket_ids,asset_reservation_ids}, rescoped_approval_ids, closed_approval_ids, booking_cancelled, fulfilled_line_ids}`.
17. security definer; set search_path=public,outbox; revoke public + grant service_role.

## TS + wiring

- `cancelLine`/`cancelBundle` → thin RPC wrappers; delete the multi-write choreography + swallowed audit + in-process eventBus emit for this path.
- Controllers: `@UseGuards(RequireClientRequestIdGuard)` + thread clientRequestId → new `buildCancelOrderLinesIdempotencyKey` (packages/shared; rebuild @prequest/shared).
- New durable handler on `order_line.cancelled` (+ bundle variant) reusing the adapter's visitor-cascade logic (mirror `booking-cancelled-cascade.handler.ts`); retire the in-process BundleEventBus emit for cancel.
- Error codes: `cancel_order_lines_with_cascade.{actor_not_found:404, booking_not_found:404, line_not_found:404, line_not_in_bundle:422, line_already_fulfilled:422, invalid_args:422}` in map-rpc-error STATUS_BY_CODE + error-codes.ts union+registry + messages.en/nl (mirror cancel_booking_with_cascade.* rows exactly). Reuse the existing idempotency-payload-mismatch code.

## Smoke (NEW `smoke:cancel-order-line`, mirror smoke-cancel-booking.mjs harness)

Per-line cancel atomic deltas (asset_reservation cancelled + WO closed + OLI cancelled + approval rescoped, keyed to booking_id); idempotency replay no-dup; payload-mismatch 409; fulfilled-line protection (cancel a confirmed line → 422, zero writes); approval-rescope correctness (multi-entity approval: cancel one line ⇒ scope_breakdown shrinks, approval NOT closed while other entities remain; cancel last ⇒ expired); cancel-all (bundle) ⇒ booking/slots cancelled iff the live weak condition; atomic rollback (force in-tx failure ⇒ zero partial rows); cross-tenant reject; missing-CRID 400; durable `order_line.cancelled` outbox emitted in-tx (scoped to booking_id, never global). Register package.json×2 + smoke-gates.md + CLAUDE.md.

## Closure obligations

Append-only rows to audits 03 + 00 + 08; this decision doc finalised; smoke-gates.md +
CLAUDE.md matrix; memory `project_booking_audit_remediation`; TaskList. Migration
number claimed at write time (`ls supabase/migrations/ | tail` immediately before
authoring — 00413 currently highest; expect 00414, auto-rebase if a parallel
workstream claimed it).

## Plan-review remediation — 2026-05-17 (checkpoint 1; 2-agent self-review, codex skipped 0-byte-hung)

Two fresh-context reviewers (plan + approach) ran in parallel. They CONTRADICTED each
other on whether the per-line cancel drives a real visitor cascade. Per the
brutal-honesty rule + the D-5 lesson, the orchestrator verified against live code
before propagating either claim:

- **C1 (partition) — ACCEPTED, verified.** Live `FULFILLED_STATUSES =
  Set(['confirmed','preparing','delivered'])` (`bundle-cascade.service.ts:680`, used
  :98 + :271); 00408 hardcodes `array['confirmed','preparing','delivered']`
  (:375,:403). The RPC's protected set is **exactly that 3-element literal** (cite
  :680 + 00408:375). `ordered` and `en_route` ARE cancellable (en_route post-dates
  the Set, never added). Step 6 must state the literal, not "the fulfilled enum".
  Whether cancelling an `en_route` line is *semantically* right is a latent question
  → reproduce-don't-fix; log as discovered finding if it bites.
- **C2 vs approach-a.3 (CONTRADICTION) — RESOLVED against live code.**
  `handleLineCancelled` body opens with `if (event.line_kind !== 'visitor') return;`
  (`bundle-cascade.adapter.ts:235`); `lineKindForOli` ALWAYS returns `'other'` for
  OLI lines (`bundle-cascade.service.ts:653/655`, comment :652 "visitors aren't
  order_line_items in v1"). So the visitor transition at adapter :255-288 is
  **unreachable for `cancelLine`** — plan-reviewer C2 is CORRECT, approach-reviewer
  a.3 is WRONG (it missed the :235 guard). **Revised D2:** the per-line
  (`p_line_ids` non-null) in-process `bundle.line.cancelled` emit is a verified
  visitor no-op → DROP it, NO replacement handler (a new `order_line.cancelled`
  event + handler for a no-op = scope creep, C2's valid objection). The
  `cancelBundle` (`p_line_ids` NULL) path's `bundle.cancelled` → `handleBundleCancelled`
  (adapter :311-339, walks visitors by booking_id) IS a real, currently-lossy
  in-process cascade AND is NOT covered by Slice-2's `BookingCancelledCascadeHandler`
  (that fires on `booking.cancel_cascade_required` from 00408 — a *booking-cancel*,
  not a *services-removed-booking-stays* op). **Decision:** the RPC emits a NEW
  durable `bundle.services_cancelled` outbox event in-tx for the bundle path ONLY
  (payload carries booking_id + whether the booking was also cancelled); a NEW
  durable handler runs the EXISTING `BundleCascadeAdapter.handleBundleCancelled`
  cascade (verified small faithful mirror of Slice-2's handler — approach-reviewer
  (c); the adapter is the ONLY `BundleEventBus` subscriber, no other consumer
  breaks). Best-in-class (no lossy emit anywhere) + scoped (no infra for the no-op
  line path) + serves the audit end-game (per "evaluate infra for end-game, don't
  silently defer"). NOT the plan's original generic single `order_line.cancelled`.
- **I1 (approval branch) — ACCEPTED.** Single RPC must branch:
  `p_line_ids IS NOT NULL` → per-line rescope (reproduce
  `rescopeApprovalsAfterLineCancel` :527-590 — scope_breakdown shrink, expire-if-empty);
  `p_line_ids IS NULL` → expire ALL pending on the booking (reproduce
  `cancelPendingApprovalsForBundle` :592-609; matches 00408 7.g :496-508). Step 11
  must encode this branch, not conflate.
- **I2 (determinism) — ACCEPTED, refined.** Hash the INTENT, not the resolved set:
  `(p_booking_id, p_line_ids-as-given [sorted if non-null; a stable NULL sentinel if
  null], sorted(p_keep_line_ids), p_tenant_id, v_actor_user_id, coalesce(reason,''))`.
  The cancellable set is recomputed under FOR-UPDATE each attempt; a successful
  cache-hit short-circuits (correct idempotent "cancel the bundle" intent even if
  the live set shifted). No Date.now/random/unsorted (D-5/D-6 class avoided).
- **I3 (weak booking-close) — ACCEPTED.** Reproduce `cancelBundleImpl:335-336`
  verbatim; the `&& !args.reservation_id` conjunct is dead (always-true,
  reservation_id retired) → drop it as faithful reproduction with citation. If the
  condition is semantically buggy (fulfilled line keeps booking alive forever) →
  log discovered finding D-n, do NOT fix in P1-4 (not an atomicity bug).
- **I4 (F-CRIT-1/DEFINER) — ACCEPTED, verified.** 00408 `prosecdef=t`, F-CRIT-1
  :181-194; wrapper threads `actor.auth_uid` (NOT users.id); F-CRIT-1 still needed
  (RPC writes `audit_events.actor_user_id` = resolved users.id).
- **approach-a.1 (CRITICAL, citation) — ACCEPTED.** Message catalogs are
  `apps/api/src/common/errors/messages.{en,nl}.ts` (cancel rows ~:2045-2060), NOT
  `packages/shared/src/`. Union+registry = `packages/shared/src/error-codes.ts`
  (~:1012-1015 + registry ~:1732); STATUS_BY_CODE = `map-rpc-error.ts` (404s
  ~:176-178, 422s ~:293-295). Add codes to the **api** catalog only (web + shared
  message catalogs have no cancel rows — do not touch). Rebuild `@prequest/shared`
  after editing error-codes.ts.
- **approach-a.2 — ACCEPTED (append-only safe).** Audit finding text says singular
  `cancel_order_line_with_cascade` (03:185/:301); delivered name is plural
  `cancel_order_lines_with_cascade` (collapses both methods, D1). Do NOT rewrite the
  finding (append-only); the Closure Ledger Update documents the delivered name +
  why it differs (the finding's "Fix:" is a suggestion, not a contract).
- **approach-b (jest blast radius) — OWNED.** Implementer must handle: (1)
  `bundle-cascade.service.events.spec.ts` — full rewrite (asserts in-process bus
  emit; now asserts RPC call + durable emit); (2)
  `visitors/bundle-cascade-integration.spec.ts` — re-point at the durable-handler
  path; (3) `cross-tenant-fk-leak-writes.spec.ts:158,169` — TS-level tenant
  assertions on cancelLine writes become moot → replace with RPC/smoke-level (the
  tenant gate is now in-RPC + smoke-covered); (4)
  `visitors/bundle-cascade.adapter.spec.ts` — stays green IFF the new handler calls
  `adapter.handle()` the same way Slice-2's does. Also DELETE dead
  `cancelOrdersForReservation` (`bundle-cascade.service.ts:511-525`, zero live
  callers — N1).
- **approach-d — migration 00414 confirmed next-free** (claim at write time, don't
  bake into TS comments).

Net: D1 (one set-based RPC) SOUND; D2 REVISED (line-path emit = drop no-op, no
handler; bundle-path = new durable `bundle.services_cancelled` + small mirror
handler); partition = literal `{confirmed,preparing,delivered}`; approval step
branches on `p_line_ids IS NULL`; determinism = hash-intent + recompute-under-lock;
weak-close reproduce+flag; F-CRIT-1/DEFINER faithful. Plan-review caught real
direction errors cheaply — proceeding to implementation on the corrected plan.

## Explicitly out of scope (documented, not silent)

- Cancel/split-family DEFINER vs create/attach-family INVOKER posture harmonisation → P2/P3 cleanup observation.
- Any latent bug in `cancelBundleImpl`'s "weak" booking-close condition → if found, log a discovered finding (D-n), do NOT silently fix in P1-4.
- `BundleCascadeAdapter` deeper refactor beyond routing it behind a durable handler.

## Fix-cycle remediation — 2026-05-17 (checkpoint 2; orchestrator smoke + 2-agent code-review)

The orchestrator's live `pnpm smoke:cancel-order-line` run + 2-agent
code-review found defects in the implemented slice (RPC + smoke shipped, RPC
on remote). Fixes applied before commit:

- **Fix A (CRITICAL — non-functional atomicity gate).** Smoke probe 7
  ("atomic rollback") was a paper tiger: its poison set `approvals.scope_breakdown`
  to a JSON scalar (`'"not-an-object"'::jsonb`), so
  `scope_breakdown -> 'order_line_item_ids'` returned SQL NULL and
  `jsonb_array_elements_text(NULL)` yielded zero rows — NO in-tx RAISE, the
  cascade committed (HTTP 200, OLI/AR/WO cancelled, 1 command_operations
  success). The RPC IS atomic (one plpgsql tx); the PROOF was broken. Fix:
  seed the poison approval with `scope_breakdown =
  '{"order_line_item_ids":"POISON_NOT_AN_ARRAY"}'::jsonb` so the KEY's value
  is a JSON string scalar → `scope_breakdown -> 'order_line_item_ids'` =
  `'"POISON_NOT_AN_ARRAY"'::jsonb` (a scalar) →
  `jsonb_array_elements_text(<scalar>)` RAISES `22023 cannot extract
  elements from a scalar` mid-rescope (00414:469) → whole tx aborts. Probe
  uses the PER-LINE route (only that path runs the jsonb rescope loop at
  00414:459-481; the bundle path uses expire-all, no jsonb extract).
- **Fix B (IMPORTANT — dishonest gate description).** Probe 8 claimed
  "tenant-B header on a tenant-A booking ⇒ reject" but only did a ghost
  random-uuid → 404 (the JWT tenant claim can't be overridden by
  X-Tenant-Id). Strengthened: seed a REAL booking + cancellable line under
  `OTHER_TENANT_ID` and attempt the per-line cancel as the REAL tenant's
  Admin JWT → 404 + zero cross-tenant writes. Note: the controller's
  `findOne(id, authUid)` visibility gate (reservation.service.ts:182-194,
  `.eq('tenant_id', tenantId)` → `AppErrors.notFoundWithCode('booking_not_found')`)
  rejects the foreign-tenant booking with code `booking_not_found` (404)
  BEFORE the RPC's own `where id=p_booking_id and tenant_id=p_tenant_id`
  guard is reached. The probe asserts the load-bearing property — 404 +
  zero writes on the foreign line — and accepts either gate's code
  (defense-in-depth: visibility gate first, RPC tenant scope behind it).
  Header + probe-name + the `it.skip` comment in
  `test/concurrency/cross-tenant-fk-leak-writes.spec.ts` rewritten to
  describe exactly what it now proves.
- **Fix C (IMPORTANT — actor attribution).** The wrappers passed
  `p_actor_user_id = null` on a false premise ("actor not available"). The
  controller's `authUid` (req.user.id = JWT subject = auth_uid) IS in scope
  at both DELETE routes. Threaded it through `CancelLineArgs` /
  `CancelBundleArgs` → `actor_auth_uid` → `p_actor_user_id`, so F-CRIT-1
  (00414:192-205) resolves it to the real `users.id` for
  `audit_events.actor_user_id`. Cancel-family-consistent with
  `ReservationService.cancelOne` → `cancel_booking_with_cascade`
  (reservation.service.ts:505 passes `actor.auth_uid`). `null` retained for
  internal/system callers (F-CRIT-1 skips resolution on null).
- **Fix D (NIT — citation discipline).** Re-verified every cited
  `file:line` in `bundle-services-cancelled-cascade.handler.ts`
  (`bundle-cascade.adapter.ts:235`, `:311-339`, `:263-275`, `:313-314`,
  `:315-322`; `booking-cancelled-cascade.handler.ts:148-152`,
  `BookingCancelledCascadeHandler:178-183`). ALL are accurate against the
  current files — no `:255-288` citation exists in this handler. No code
  change; verification recorded per the citation-discipline rule.

## Residuals — accepted audit-shape drift (not fixed; documented)

- **`CancelBundleArgs.recurrence_scope` dropped from the new audit shape.**
  The controller still accepts `recurrence_scope` on `DELETE
  /reservations/:id/bundle`, but the legacy `cancelBundle` audit recorded
  `recurrence_scope: args.recurrence_scope ?? 'this'` whereas the new
  `bundle.cancelled` audit (00414:579-591) omits it. Functionally inert:
  recurrence-cancel routes through `cancelOne` → `cancel_booking_with_cascade`
  (00408) per-occurrence elsewhere; the field was advisory on this path.
  **Accepted as audit-shape drift, no code change.** Mirror into the
  closure ledger.
