# Slice 5 — `attach_services_to_existing_booking` (audit 03 P1-3) — decision + HONEST partial-close

Status: **CLOSED 2026-05-17 (debt #15 drained)** — P1-3 (the non-atomic TS
`Cleanup`-queue data-loss class, as the finding is written) closed + live-smoke-proven;
full-review IMPORTANT I1 fixed in-slice; full-review CRITICAL C1 verified + reclassified
as discovered finding D-6, deferred-with-owner (bundled with debt #14/D-5 — same
producer-determinism root). The original PARTIAL disclosure below is left verbatim as
honest point-in-time history; the `## Update 2026-05-17` section immediately below
records the closure and corrects one factually-false claim it contained (I1).

> **Prior status (point-in-time, 2026-05-17, superseded — kept honest):** PARTIAL —
> code-complete + verified; live smoke gate + 2-agent full-review PENDING. This was
> the one booking-audit slice that shipped at commit time WITHOUT its live smoke gate
> — a tracked, risk-disclosed deferral, NOT a silent gap and NOT a
> faked/constructed-to-pass gate.

## Update 2026-05-17 — debt #15 CLOSED

The two PENDING items are now done; both blocked items from commit time were
re-attempted and completed:

- **Live smoke gate `apps/api/scripts/smoke-attach-services.mjs`** authored (44
  probes), registered (`package.json`×2, `docs/smoke-gates.md`, `CLAUDE.md`),
  honesty-audited line-by-line by the orchestrator, and run **44 pass / 0 fail / 0
  skip, exit 0** — TWICE (pre-I1 and after the 00413 push; identical). Probe 6 is a
  genuine atomicity bug-catcher (forces an RPC-internal `asset_reservations_no_overlap`
  23P01 *after* the catering order/OLI insert; asserts the catering OLI does NOT
  survive). Not constructed-to-pass.
- **2-agent full-review** (parallel, fresh-context) run. Code-reviewer: clean (no
  critical/important — independently re-confirmed tsc/jest 333/errors 0-of-35,
  migration==remote body, EN/NL parity, `Cleanup` fully removed, `@prequest/shared`
  dist not stale). Design-reviewer: **C1** (CRITICAL) + **I1** (IMPORTANT). Both were
  re-verified by the orchestrator against live code/DB *before* propagation (the D-5
  misdiagnosis lesson — reviewer claims are inputs to verify, not facts to relay):
  - **I1 — FIXED.** Verified on remote: `attach_services_to_existing_booking`
    `prosecdef=t` (SECURITY DEFINER) while its declared template
    `create_booking_with_attach_plan` is `prosecdef=f` (SECURITY INVOKER). The
    "security posture IDENTICAL to the live create RPC" claim in 00412's header AND
    in the §"What shipped" line of this doc was therefore **factually false**. No
    behavioral need for DEFINER (service_role-only grant; the SECURITY INVOKER create
    template emits to `outbox` fine under the same caller). Fixed via
    `supabase/migrations/00413_attach_services_invoker_align.sql` — a verbatim repro
    of the live 00412 body whose SOLE executable delta is line 4
    `SECURITY DEFINER`→`SECURITY INVOKER` (diff-proven; ACL re-asserted verbatim from
    00412:383-384; comment corrected). On remote; post-push `prosecdef=f` for both
    (aligned); smoke 44/0 unchanged (invoker behaviorally equivalent). **Correction:**
    everywhere this doc or the 00412 header said "SECURITY DEFINER" / "security posture
    IDENTICAL", the true posture is **SECURITY INVOKER, matching the create template**
    (per 00413).
  - **C1 → discovered finding D-6 — DEFERRED-with-owner (see §D-6).**

The §PENDING section below is therefore RESOLVED (both items delivered); it is left
in place as the record of what was owed and why it slipped, per the maintainer rule.

## What shipped (verified directly by the orchestrator, 2026-05-17)

- `supabase/migrations/00412_attach_services_to_existing_booking_rpc.sql` on remote
  (`pg_get_functiondef` confirmed). The RPC = the LIVE `create_booking_with_attach_plan`
  attach-half (INSERT orders / asset_reservations / order_line_items / approvals +
  `setup_work_order.create_required` outbox emit guarded by `NOT any_pending_approval`)
  WITHOUT the booking/booking_slots INSERTs (the booking already exists). Idempotent via
  the `attach_operations` table (attach-family, like create) + advisory lock; atomic
  (single PL/pgSQL tx); ~~`security definer`~~ **[CORRECTED 2026-05-17 per I1: shipped
  as SECURITY DEFINER at commit f1085072, which DIVERGED from the SECURITY INVOKER
  create template — the "IDENTICAL security posture" claim here was false. Realigned to
  SECURITY INVOKER via migration 00413; see the `## Update 2026-05-17` §I1 above.]**;
  revoke-public / grant-service_role.
- `bundle.service.ts` `attachServicesToBooking` → thin RPC wrapper (builds the plan via
  the existing pure `buildAttachPlan`, mints `buildAttachServicesIdempotencyKey`, calls
  the RPC, maps `attach_services_to_existing_booking.*` errors). The legacy non-atomic
  N-write path + the TS `Cleanup` undo-queue class are **deleted** (repo-verified no
  other caller; `StandaloneCleanup` in `order.service.ts` is a DIFFERENT, unrelated
  class — untouched). Dead post-cutover private helpers `createOrder` / `createLineItem`
  / `createAssetReservation` and the now-unused `setupTrigger` injection removed.
- `reservation.controller.ts` `@Post(':id/services')` threads `clientRequestId`
  (RequireClientRequestIdGuard already gated the route) into the attach idempotency key.
- `packages/shared/src/idempotency.ts` — `ATTACH_SERVICES_IDEMPOTENCY_KEY_PREFIX`
  (`booking:attach`) + `buildAttachServicesIdempotencyKey`. (`@prequest/shared` is a
  built package — `dist` is gitignored; CI/consumers run `pnpm --filter @prequest/shared
  build`, as for every prior shared change.)

## Validator-input correctness (the key correctness risk — VERIFIED, not assumed)

`validate_attach_plan_tenant_fks` (00303) dereferences from `p_booking_input`:
`requester_person_id` (required → persons), `host_person_id` (optional → persons),
`booked_by_user_id` (optional → users), `location_id` (required → spaces). It does NOT
check booking existence. `validate_attach_plan_internal_refs` (LIVE, post-00410)
dereferences `booking_id` (required; raises 22023 if null) + `applied_rule_ids[]`
(→ room_booking_rules — D-4 fix; absent on a post-create attach ⇒ §7a vacuous, correct).
00412 does NOT pass a bare `{booking_id}` stub: it SELECTs the existing booking row
(`where id = p_booking_id and tenant_id = p_tenant_id`) and builds a faithful
`booking_input` (booking_id + requester_person_id + host_person_id + booked_by_user_id
+ location_id) from it, so BOTH validators validate correctly for the existing-booking
case. Confirmed against 00303's body + the live internal-refs definition.

## Verified gates (what the orchestrator ran directly)

- `tsc --noEmit` (apps/api): clean.
- `jest src/modules/booking-bundles src/modules/reservations`: 32 suites / 333 passed
  / 5 todo (incl. the constructor-arity spec fix for the removed `setupTrigger`).
- `errors:check-app-errors`: clean (0 raw throws / 35 modules).
- 00412 on remote, `pg_get_functiondef` shape-confirmed.

## PENDING (deferred, tracked — owner: this workstream; task #15) — **RESOLVED 2026-05-17 (debt #15 drained — see `## Update 2026-05-17` above; both items below delivered)**

- **Live smoke gate `smoke:attach-services`** (atomic attach / idempotency-no-dup /
  payload-mismatch 409 / atomic-rollback-proves-Cleanup-removal-safe / cross-tenant /
  missing-CRID / require_approval setup-emit suppression). Not authored: two
  closure subagents were killed mid-run by API infrastructure failures (rate-limit;
  stream-idle-timeout) on 2026-05-17. **Risk:** no live-DB proof of the attach RPC
  end-to-end + the idempotency/rollback invariants; unit + tsc + migration-shape are
  necessary-but-not-sufficient (the exact lesson the smoke-gate mandate exists for).
  Mitigation until done: the RPC mirrors the already-smoke-gated, shipped
  `create_booking_with_attach_plan` attach-half; validator-input verified; jest green.
- **2-agent full-review** of the cutover + 00412 (every prior slice had one; it caught
  real defects each time incl. an orchestrator misdiagnosis). Same API-instability cause.

## Residuals (explicit, not silent)

- Deprecated `attachServicesToReservation` shim retained (intentional caller-stability;
  already forwards `client_request_id`).
- 00412 forward-only on shared remote (no clean DB-only rollback; the old TS path is
  deleted — revert = git-revert + drop function, re-exposing the non-atomic bug).
- P2-1 boundary respected: the recurrence-clone `cloneOrderForOccurrence` path is
  orthogonal and untouched (P2-1 retires `BookingTransactionBoundary` in a later slice).

## D-6 (discovered, full-review C1) — attach producer-determinism — DEFERRED-with-owner

**Finding (verified against live code 2026-05-17).** `attach_services_to_existing_booking`
hashes `md5(coalesce(p_attach_plan::text,''))` (00412:39 / 00413). The TS producer
`BundleService.hydrateLines` captures `const now = Date.now()` (bundle.service.ts:1477)
and derives `leadRemaining = (Date.parse(startAt) - now)/3_600_000` (:1532), emitted on
the hydrated line as `lead_time_remaining_hours` (:1566). `buildAttachPlan` puts that
into the rule-evaluation context (bundle.service.ts:724) and the resolver
(`resolveBulk`, :696) evaluates tenant `service_rules.applies_when` predicates against
it. The predicate engine's `resolveRef` (predicate-engine.service.ts:277-287) has **no
allowlist** — a tenant predicate can reference `$.line.lead_time_remaining_hours`
directly (a spec, `service-rule-from-template.spec.ts:146-157`, literally does). The
resolver outcome drives `anyPendingApproval` / `order.initial_status` / `planApprovals`
/ per-OLI `setup_emit` vs `pending_setup_trigger_args` (:763-820) — all serialized
into the hashed `p_attach_plan`. So two same-intent retries seconds-to-minutes apart
that straddle a lead-time-rule boundary hash differently → `attach_operations.payload
_mismatch` (00412:48-51) → HTTP 409 on a legitimate retry, and the attach is
permanently lost (the idempotency gate blocks a third attempt). This is the D-2/D-5
nondeterminism class. `lead_time_remaining_hours` is the **sole** nondeterministic
field (all plan UUIDs are `planUuid(idempotency_key)`-derived; arrays canonically
sorted via plan-sort.ts; no strip helper unlike 00407).

**Why deferred, not folded in.** (1) It is genuinely out of P1-3's *atomicity* scope —
exactly as D-5 was out of P1-2's split scope. The finding P1-3 as written is the
non-atomic TS `Cleanup`-queue data-loss class; that is closed + smoke-proven. (2) It is
**not a bounded one-liner**: a strip helper (the 00407 approach) does NOT work here —
the nondeterminism is in the rule *outcome* (a rule fired vs didn't), not a raw
`_`-prefixed field. The fix needs a stable per-idempotency-key time/resolution basis
persisted in the `*_operations` row on first attempt and reused on retry — a
producer-determinism design. (3) It is **the same root class as D-5 / debt #14** (the
edit_booking_scope producer emits a non-`_` field varying across re-assembly) and is
**shared with the already-shipped create path** (`booking-flow.service.ts:965-988`
calls the same `buildAttachPlan` → so this is a pre-existing latent defect Slice 5's
RPC *inherits*, not one it introduces; create's idempotency window is one call so its
exposure is lower). The honest, non-duplicative move is to fix both producers ONCE in
the producer-determinism slice.

**Owner / tracking.** Producer-determinism slice (tracked task #5), bundled with debt
#14 (D-5). Recorded in `docs/follow-ups/audits/03-booking-reservation.md` Closure
Ledger (D-6 row + the debt-#15 Update) and `00-integrator-verdict.md`. The smoke header
(`smoke-attach-services.mjs`) and `docs/smoke-gates.md` state the gap explicitly:
probes 2/3 cover the deterministic-case idempotency; the lead-time-rule retry case is a
documented, owned gap — NOT a hidden one and NOT a constructed-to-pass probe asserting
the bug as expected (the dishonest-fixture anti-pattern this audit kills).

**Practical exposure today:** low — no production tenants, and it requires a tenant to
have authored an active `service_rules` rule whose predicate references a wall-clock
field. The defect is nonetheless real and verified; it is owned, not dismissed.
