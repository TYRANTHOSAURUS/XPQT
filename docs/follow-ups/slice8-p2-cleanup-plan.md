# Slice 8 plan — P2-2 / P2-3 / P2-4 design-tightening (audit 03 :210/:218/:227)

Status: **CLOSED 2026-05-17 (Slice 8 shipped).** P2-2 + P2-4 closed (pure-type;
`tsc` 0, `jest src/modules/reservations` 262/262, `errors` 0/35; 2-agent
plan-review + impl-review clean, no CRITICAL/IMPORTANT). **P2-3 DEFERRED-with-
rationale** — checkpoint-1 plan-review caught (verified live) that routing the
no-services single-room path through `createWithAttachPlan`-empty-plan would
drop the `booking-flow.service.ts:~372-383` `pending_approval` workflow/
`createApprovalRows` fan-out (the no-services `buildAttachPlan` hard-codes
`approvals:[]`/`any_pending_approval:false`) → a P0 regression on every
approval-gated no-services create incl. recurrence occurrences; the audit P2-3
explicitly permits "OR document why it stays"; legacy `create_booking` is a
single ATOMIC Postgres fn (not the data-loss class the RPC mandate targets);
the consolidation is consistency-not-correctness. Owner: a future
create-path-consolidation slice that relocates the pending_approval fan-out into
a canonical no-services attach-plan path FIRST, then cuts over + (per
approach-review) `revoke … from public, anon, authenticated, service_role` (20-arg
sig) + a new confirmed/pending_approval no-services single-room smoke. The
original PLAN text + the plan-review remediation below are kept verbatim as the
dated record. (Citation fix: the type files are `edit-plan.types.ts` /
`assemble-edit-plan.service.ts` under `apps/api/src/modules/reservations/`, NOT
under `dto/`; the scope `recurrence_overridden` runtime backstop is
`reservation-edit-scope.spec.ts:110` + `assemble-edit-plan.idempotency.spec.ts:236`,
not a `assemble-edit-plan.service.spec.ts` range.)

> **Prior status (point-in-time, superseded):** PLAN — pre-coding, pending
> 2-agent plan-review (checkpoint 1). Codex
plan-gate skipped (0-byte hung every attempt this session — protocol-allowed per
[[feedback_review_loop_protocol]]; the 2-agent self plan-review is the
load-bearing gate). Scope/DROP-vs-deprecate decided by the orchestrator with
rationale (codex unavailable → own judgment + review gate).

## Findings (audit 03 P2 — "design tightening", NOT correctness/atomicity)

- **P2-2** — `'auto'` is still in the TS `ReservationSource` union though the live
  `bookings.source` CHECK (00295) = `portal|desk|api|calendar_sync|reception|recurrence`
  (NO `'auto'`). Callers map `'auto'`→`'recurrence'`/`'calendar_sync'` by actor prefix.
- **P2-3** — two `create_booking` generations coexist: legacy `create_booking`
  (00277:236, no validators, single atomic fn) used by exactly ONE live caller
  now — `BookingFlowService.create` no-services single-room path
  (`booking-flow.service.ts:~259`); multi-room already migrated to
  `create_booking_with_attach_plan` in Slice 3 (P1-1). The canonical
  `create_booking_with_attach_plan` (00309/00315, validators) accepts an empty
  services plan.
- **P2-4** — `EditPlanBookingPatch` (`edit-plan.types.ts:~60-85`) always carries
  optional `recurrence_overridden?`; scope-mode plans build `EditPlan` so it is
  TYPE-settable, though the scope RPC (00395:218-222) guard-rejects it at
  runtime. Audit wants a type-level narrow so scope-mode plans can't carry it.

(All current file:line to be re-confirmed at implementation — Slices 1-7 shifted them.)

## Direction decisions (rationale; pressure-test in plan-review)

- **D1 — ONE slice, all three.** Digest confirms they're independent + mostly type-only. P2-2/P2-4 are pure-type (no migration, no runtime). P2-3's caller-cutover is bounded (~25 LOC, validators accept empty plan). Bundling is the audit's intent ("design tightening" group).
- **D2 — P2-2: remove `'auto'` from `ReservationSource`; callers resolve upfront.** `dto/types.ts` union loses `'auto'`. The producers (`recurrence.service.ts` system-recurrence → pass `'recurrence'` directly; `multi-room`/`booking-flow` system:* → resolve to `'recurrence'`/`'calendar_sync'` at input time instead of emitting `'auto'`; `reservation.controller.ts` legacy-compat cast dropped). NO `'auto'` reaches a writer. Type-only + ~3-4 caller edits; no migration; `ReservationSource` is reservations-local (no @prequest/shared rebuild). Calendar-sync `'calendar_sync'` writes are still deferred (P3-1) — the mapping target stays valid in the CHECK, just no live writer; that's correct + unchanged.
- **D3 — P2-3: cut the no-services caller over to `create_booking_with_attach_plan` with an empty attach-plan; then DEPRECATE-not-DROP the legacy `create_booking` RPC this slice (revoke grants + a `comment on function ... is 'DEPRECATED ...'` migration), and document.** Rationale: the cutover (one atomic-RPC win, the audit's "one pattern") is bounded and the validators accept an empty plan. But a `DROP FUNCTION` on the SHARED remote is higher-risk + irreversible-forward + could strand a parallel workstream / a stale dev-server still calling it; the audit explicitly allows "OR document why it stays." DEPRECATE (revoke execute from service_role + a DEPRECATED comment + remove the last TS caller) achieves the consolidation safely and reversibly; a later cleanup slice can DROP once no caller has existed for a release. This is the proportionate call — the legacy fn is itself atomic+correct (NOT the data-loss class the audit's RPCs target), so the benefit is consistency, not correctness; don't take shared-remote-DROP risk for a consistency win when deprecate gets ~all of it. Plan-review: challenge DROP-vs-deprecate.
- **D4 — P2-4: discriminated narrow.** A `ScopeEditPlanBookingPatch` (or a mode-discriminated `EditPlan` union) that OMITS `recurrence_overridden`; `AssembleScopeEditPlanResult.rpc_plans[].plan` typed to the scope variant. Pure type-level; the assembler already never sets it on scope; the RPC guard stays as defense-in-depth. No migration, no runtime change, no payload-contract change.

## Plan-review remediation — 2026-05-17 (checkpoint 1; 2-agent self-review, codex 0-byte-hung→skipped)

Two fresh-context reviewers caught a **CRITICAL P0-inducing direction error PRE-coding** (verified by the orchestrator against live code before propagation — the D-5 lesson):

- **C1 (CRITICAL) — P2-3 cutover is NOT byte-equivalent → P2-3 DEFERRED-with-rationale, REMOVED from this slice.** VERIFIED live: `create()` branches at `booking-flow.service.ts:142` (`input.services?.length>0` → `createWithAttachPlan`; else legacy `.rpc('create_booking')` :259 → the `:372-383` `pending_approval` fan-out `workflowService.start` / `createApprovalRows`). `buildAttachPlan`'s no-services branch hard-codes `any_pending_approval:false` (:979/:993) + `approvals:[]` (:985); a code comment (~:560s) states "the plan-builder already discarded `approvalConfig`". So routing the no-services single-room path through `createWithAttachPlan`-empty-plan would persist an approval-gated booking as `pending_approval` with ZERO approval rows + NO workflow instance → permanently un-approvable — a **P0 regression on every approval-gated no-services create, INCLUDING recurrence-materialised occurrences** under a `require_approval` room rule. The plan's "~25 LOC mechanical cutover / validators accept an empty plan" premise is false (it never accounted for the :372-383 fan-out). **Decision (the audit P2-3 explicitly permits "OR document why it stays"):** legacy `create_booking` STAYS for the no-services single-room path. Rationale: (1) it is a SINGLE ATOMIC Postgres function — NOT the non-atomic-TS-choreography data-loss class the audit's RPC-canonicalisation mandate targets; it is correct + atomic. (2) A safe cutover requires FIRST relocating the `:372-383` pending_approval workflow/approval fan-out into a canonical no-services attach-plan path — real design work + regression risk on a hot path, for a CONSISTENCY (not correctness) gain. (3) The multi-room half of P2-3 was already consolidated in Slice 3 (P1-1). Deferred-with-owner + full rationale in the Closure Ledger (the mandated honest path — reasoned, not silently dropped, not papered over). Owner: a future create-path-consolidation slice that relocates the workflow fan-out first.
- **C2 (CRITICAL) — the cited P2-3 runtime gate does not exist** (smoke:recurrence-clone master is created WITH services → createWithAttachPlan; no smoke exercises the no-services single-room HTTP create). Moot now P2-3 is deferred; recorded so a future P2-3 slice knows it must AUTHOR a new gate (confirmed + pending_approval no-services single-room create).
- **(approach, CRITICAL) — legacy `create_booking` is 20 args not 21; `revoke … from service_role` is a functional no-op** (proacl: PUBLIC `=X` + anon/authenticated/service_role all hold EXECUTE). Moot now (no P2-3 migration this slice); recorded for the future P2-3 slice (full lockout needs `revoke … from public, anon, authenticated, service_role`).
- **I1 (IMPORTANT) — P2-2 has TWO `'auto'` coercion blocks** in booking-flow (`:232-236` AND `:879-883`), plus `recurrence.service.ts:504` EMITS `source:'auto'`, `multi-room-booking.service.ts:317-323` synthesises+coerces, `reservation.controller.ts:177` compat cast. The resolution logic must be HOISTED to producers (recurrence → pass `'recurrence'` directly; multi-room resolve inline), NOT just deleted (deleting breaks recurrence provenance, 00295's purpose). tsc exhaustiveness DOES catch a missed producer (every site is a literal union member — no `string` widening). Specs `booking-flow-build-attach-plan.spec.ts:303,316` assert the old `'auto'` coercion → rewrite to assert resolved values (not hollow). Unrelated `'auto'` in webhook/request-type/resolver/daily-list unions — DO NOT TOUCH (scope strictly to `ReservationSource`).
- **I2 (IMPORTANT) — P2-4 is NOT a one-line union edit.** Scope plans flow `assembleScopeEditPlan` → the SHARED `buildSingleSlotPlan` (:551) returning a full `EditPlan` (:881); `recurrence_overridden` is only set under `auto_set_recurrence_overridden` (scope passes `false`, :576). The narrow must be a typed `Omit<EditPlanBookingPatch,'recurrence_overridden'>` projection at the scope boundary (~:588) onto `AssembleScopeEditPlanResult.rpc_plans[].plan` (:196/:198) — approach (b). Zero-runtime, achievable, downstream is supabase-js rpc serialization (no `as EditPlan`/`JSON.parse` re-cast defeats it — grep-confirmed). The 00395:218-222 guard (rejects the KEY's presence) stays as defense-in-depth.
- **(approach, IMPORTANT) — `reservation-edit-scope.spec.ts` is do-NOT-stage AND already-modified-on-branch AND P2-4-relevant AND tsc compiles it.** Mitigation: P2-4's `Omit<>` result-type narrow is non-breaking IF the spec's `assembleScopeEditPlan` mock is loosely typed (`unknown` — approach-reviewer says likely benign). Implementer MUST: run tsc/jest; if a failure is ONLY from the pre-existing unstaged `reservation-edit-scope.spec.ts` diff, isolate via `git stash` of that spec + re-run, surface to orchestrator, and DO NOT stage/commit that spec to make a gate pass (branch-hygiene + it's a Slice-4 residue not owned here).
- **Sequencing:** SPLIT confirmed — Slice 8 = P2-2 + P2-4 (pure-type, tsc-gated, no migration, no runtime change). P2-3 deferred (own future slice). No `@prequest/shared` rebuild (`ReservationSource`/`EditPlan` are reservations-local — verified). No migration this slice. No live smoke (type-only — tsc exhaustiveness IS the runnable guard; jest is the behavioural backstop incl. `assemble-edit-plan.service.spec.ts:1799-1852` which already asserts scope plans never emit `recurrence_overridden`).

Net revised scope below supersedes the original "Work"/"Verify" sections for P2-3 (P2-3 is now a deferred residual, NOT implemented).

## Work

1. **P2-2:** `dto/types.ts` drop `'auto'` from `ReservationSource`. Edit the ≤4 producer/consumer sites the digest named (re-grep `'auto'` in `apps/api/src/modules/reservations` + `booking-flow` + `multi-room` + `recurrence` + `calendar-sync` + `reservation.controller.ts`) so the resolved value (`'recurrence'`/`'calendar_sync'`/explicit) is passed; delete the `'auto'`→X coercion + the controller compat cast. Confirm NOTHING writes `'auto'` at runtime after (grep + tsc exhaustiveness).
2. **P2-3:** in `booking-flow.service.ts` no-services path, replace the `.rpc('create_booking', …)` call with `create_booking_with_attach_plan` (booking_input + empty attach plan {orders:[],order_line_items:[],asset_reservations:[],approvals:[]} or whatever the canonical empty shape is — read 00309/00315 + the validators to get the exact empty-plan contract; reuse the existing buildAttachPlan empty path if one exists). Idempotency key: the no-services create path's existing key (or mirror the create-family key). Then a small migration: `revoke execute on function public.create_booking(...) from service_role; comment on function ... is 'DEPRECATED <date> Slice 8 P2-3 — superseded by create_booking_with_attach_plan; no live caller; retained un-dropped for shared-remote safety, drop in a later cleanup once no caller for a release.';` (verbatim signature from 00277). Do NOT DROP.
3. **P2-4:** add the scope-narrowed type in `edit-plan.types.ts` (+ wherever `AssembleScopeEditPlanResult` is typed); ensure `assembleScopeEditPlan` returns the narrowed type; tsc proves scope plans can't carry `recurrence_overridden`. RPC guard untouched.

## Verify

- `tsc --noEmit` clean (the P2-2 union removal + P2-4 narrow are exhaustiveness-checked by tsc — a missed `'auto'` producer or a scope plan setting `recurrence_overridden` becomes a compile error: that IS the gate for the type-only parts).
- `jest src/modules/reservations` green (spec blast radius per digest: `booking-flow-build-attach-plan.spec.ts` source='auto' test, `multi-room-booking.service.spec.ts` source coercion, `recurrence.service.spec.ts` source, `booking-flow-atomicity.spec.ts` no-services path, `assemble-edit-plan.service.spec.ts`/`reservation-edit-scope.spec.ts`/`reservation-edit-slot.spec.ts` recurrence_overridden — update specs that asserted the old `'auto'`/legacy-create behaviour to assert the new resolved-value/canonical-RPC behaviour; do NOT hollow them).
- `errors:check-app-errors` clean.
- **Live smoke for P2-3 (the only runtime change):** the no-services single-room create path is now `create_booking_with_attach_plan`. Check if an existing smoke already exercises a no-services single-room `POST /api/reservations` confirmed create (smoke-create-multi-room probe (g) is single-room WITH services + a room rule; smoke-recurrence-clone's master is single-room no-services confirmed create via the SAME path — it asserts the master booking persists `confirmed`). If `smoke:recurrence-clone` (master create) OR another existing gate already covers a no-services single-room confirmed create through the cutover path, that is the P2-3 runtime gate (re-run it, cite it). If NOT, add a minimal probe/smoke. P2-2/P2-4 are type-only ⇒ tsc + jest are their gates (no live smoke — state this explicitly; type-exhaustiveness is the runnable guard).
- Migration validate (the deprecate migration): claim next free number at write time (`ls supabase/migrations/ | tail`); apply to remote (revoke+comment only — low-risk, reversible); verify via `pg_get_functiondef`/`\df+` that the comment + revoked grant landed and the fn still EXISTS (not dropped).

## Out of scope (documented, not silent)

- Actually DROPping legacy `create_booking` — deferred to a later cleanup slice (deprecated + no-caller now; drop once no caller for a release). Ledgered as a deferred residual with owner.
- Calendar-sync inbound writes (`'calendar_sync'` source) — still P3-1 deferred; P2-2 only removes the `'auto'` shim, the `'calendar_sync'` enum value + (future) writer are untouched.
- D-9 (Slice-7 observability nit) — separate; not Slice-8.

## Closure obligations

Append-only rows audits 03 + 00 (+ 08 only if a smoke is added/changed); finalise this decision doc; `docs/smoke-gates.md` + `CLAUDE.md` only if a smoke becomes mandatory; memory `project_booking_audit_remediation`; TaskList.
