# Slice 7 plan — P2-1 retire `BookingTransactionBoundary` (audit 03 :202)

Status: **CLOSED 2026-05-17 (Slice 7 shipped).** P2-1 closed (3 boundary/
compensation classes retired; `materialize()` `runWithCompensation` → try/catch
+ verbatim `deleteOrphanOccurrence` port; `delete_booking_with_guard` kept as the
direct compensation primitive; NO new RPC/migration — plan-review checkpoint 1
killed the infeasible clone-RPC pre-coding). Discovered pre-existing P1 **D-8**
fixed-in-slice (synthetic `system:*` actor → `uuid` create-RPC booker-bind 500;
shared `booked-by-user-id.util.ts` guard at all 3 binds). Discovered **D-9**
deferred-with-owner (observability-only; correctness unaffected). `pnpm
smoke:recurrence-clone` 14/0 exit 0; tsc 0; jest src/modules/reservations
262/262; errors 0/35. The original PLAN text + plan-review remediation + the
6-iteration honest fix-cycle below are kept verbatim as the dated record.

> **Prior status (point-in-time, superseded):** PLAN — pre-coding, pending
> 2-agent plan-review (checkpoint 1). Codex plan-gate skipped (0-byte hung;
> protocol-allowed). Direction fork (D1 below) decided by the orchestrator with
> rationale; codex unavailable → own judgment + review gate.

## Finding (audit 03 P2-1)

`BookingTransactionBoundary` + `InProcessBookingTransactionBoundary` +
`BookingCompensationService` are the legacy in-process compensation pattern. P1-1
(Slice 3) removed the multi-room caller; P1-3 (Slice 5) was expected to remove the
last one. **Stale assumption (corrected by investigation):** the audit said "if
P1-3 ships this caller becomes a single attach-RPC call too." It does NOT — the
remaining live caller is the **recurrence occurrence-clone**, which is not a plain
attach.

## Verified current state (investigation, cite-at-implementation — lines drift)

- **Only remaining caller:** `RecurrenceService.materialize()` (`recurrence.service.ts` ~:548-554), driven by the `@Cron(EVERY_DAY_AT_3AM)` `recurrenceRollover()` (~:718) and ad-hoc admin extend. It does: `bookingFlow.create()` (atomic, occurrence booking+slots, services=[]) THEN `txBoundary.runWithCompensation(occurrenceId, () => cloneBundleOrdersToOccurrence(args), (id) => comp.deleteBooking(id))`. `cloneBundleOrdersToOccurrence()` (~:668-712) reads the MASTER's orders (FK `orders.booking_id`), clones via `OrderService.cloneOrderForOccurrence()` orders + OLIs (filtered `repeats_with_series=true`) + asset_reservations + approvals, **time-shifting** service windows by the (occurrence.start − master.start) delta. Compensation = `delete_booking_with_guard(occurrenceId)` (delete the orphan empty occurrence if the clone fails).
- **`attach_services_to_existing_booking` (00412/00413) CANNOT be reused** as-is: it takes a pre-built attach_plan; it does NOT read master orders, filter `repeats_with_series`, or time-shift windows. (Investigation §2.)
- **3 classes to delete:** `booking-transaction-boundary.ts` (interface `BookingTransactionBoundary` + impl `InProcessBookingTransactionBoundary` + token `BOOKING_TX_BOUNDARY` + `InjectBookingTxBoundary` + `CompensationOutcome` type, ~159 lines) + `booking-compensation.service.ts` (`BookingCompensationService`, ~163 lines). Refs: `reservations.module.ts` (providers/exports/provide-useClass), `booking-flow.service.ts` (`@Optional()` injects + dead `void this.txBoundary` checks — already a no-op caller post-P1-1), `recurrence.service.ts` (`@Optional()` injects + the live call). Both injecting services use `@Optional()` ⇒ no forced DI break.
- **`delete_booking_with_guard` STAYS** (00292 + 00373). It is SQL-only (no TS class), called independently by `WorkflowEngineService.tryCancelChildBooking()` (~:595) + inside RPCs (edit_booking 00361, cancel_booking_with_cascade 00408). Deleting the boundary classes does NOT orphan it.
- **No existing smoke exercises the clone path** (`smoke:edit-booking-scope` INSERTs pre-materialized occurrences, never calls `materialize()`). Jest coverage only (`recurrence-materialize.service.spec.ts`, ~3 boundary-mocking describe blocks ~:230-850; + dedicated `booking-compensation.service.spec.ts`).

## Plan-review remediation — 2026-05-17 (checkpoint 1; 2-agent self-review, codex 0-byte-hung→skipped)

The plan-reviewer caught a **CRITICAL direction error PRE-coding** (verified by the orchestrator against live code before propagation, per the D-5 lesson):

- **C1 — Option A (new clone RPC) is INFEASIBLE → DROPPED.** Verified: `OrderService.cloneOrderForOccurrence` (order.service.ts:129) → `reEvalRulesForOccurrence` (:340) → `this.resolver.resolveBulk` (:514, `ServiceRuleResolverService` — a **JSONLogic engine**, `engine.evaluate(rule.applies_when)` at service-rule-resolver.service.ts:135) + `this.approvalRouter.assemble` (:639, the 476-line `ApprovalRoutingService`). A PL/pgSQL clone RPC would have to reimplement a JSONLogic interpreter + the service-rule resolver + approval routing in SQL — a multi-thousand-line reimplementation with permanent divergence risk. My own Option-C rejection rationale ("would reproduce the rule/approval path") applies with full force to Option A; I missed it. **Audit P2-1 (:208) only mandates retiring the 3 classes + keeping `delete_booking_with_guard` — it does NOT mandate moving clone logic into an RPC.** The recurrence-clone is the ONE booking path that legitimately needs TS choreography (rule eval is intrinsically TS). **NO new RPC, NO new migration.**
- **I1 — direct-delete must preserve the compensation audit + rolling-window signal.** `BookingCompensationService.deleteBooking` does more than delete: it emits `audit_events` (`booking.compensation_failed` / `booking.compensation_partial_failure`) AND returns a structured outcome the materializer keys on (`code === 'booking.partial_failure'` / `'booking.compensation_failed'` → `sawUnexpectedFailure` → does NOT advance `recurrence_series.materialized_through`, the rolling-window correctness invariant). A bare `delete_booking_with_guard` call would silently drop both. The replacement MUST inspect the guard RPC's structured return (`{kind:'rolled_back'|'partial_failure', blocked_by}`), emit the two audit rows on failure/partial, and map `partial_failure` → the same don't-advance path. (Implementer reads `booking-compensation.service.ts` + the materializer keying in full and reproduces it VERBATIM with citation.)
- **I2 — precedent cite fix.** The "direct guarded-delete" precedent is `WorkflowEngineService.tryCancelBookingForCascade` (workflow-engine.service.ts:586), NOT `tryCancelChildBooking`. It is a precedent for *calling delete_booking_with_guard directly*, NOT for the compensation-audit semantics (it emits a workflow event, not audit_events). Don't lean on it for the audit behaviour — reproduce `BookingCompensationService`'s audit emission explicitly.
- **I3 — smoke drives the REAL entrypoint.** Verified: `materialize()` IS reachable — `BookingFlowService.create` (:457/:462, :642/:647) `void this.startSeries(...)` → `:1073 this.recurrence.materialize(...)`. The "cron-only / RPC-direct is honest" escape hatch was FALSE — DELETED from this plan. The honest gate POSTs a recurring booking WITH services and asserts the resulting cloned occurrence rows. NOTE: `startSeries` is `void`-fired and `materialize` is `.catch()`-swallowed (:463/:648) → failures do NOT surface in the HTTP response; the smoke MUST assert on the cloned occurrence DB rows, never on HTTP status.
- **N1/N2 — clean:** both boundary injects are `@Optional()` (recurrence.service.ts:135/136) ⇒ safe DI removal. `cloneOrderForOccurrence` has no non-recurrence prod caller (it STAYS in TS under the corrected design anyway).

Net: Slice 7 is a **pure TS refactor** — retire the 3 classes, keep the TS clone + `delete_booking_with_guard`, replace the boundary with a focused direct-delete helper that preserves I1's audit + don't-advance semantics, drive the smoke through `POST /reservations`. The superseded Option-A/B/C analysis below is kept verbatim as the dated record; the **corrected design is in `## Corrected design (post-plan-review)`**.

## Corrected design (post-plan-review) — pure TS retirement, no RPC, no migration

1. `recurrence.service.ts` `materialize()`: replace `txBoundary.runWithCompensation(occId, () => cloneBundleOrdersToOccurrence(args), (id) => comp.deleteBooking(id))` with a plain `try { await this.cloneBundleOrdersToOccurrence(args) } catch (e) { <compensate> }` where `<compensate>` is a NEW focused private method `RecurrenceService.deleteOrphanOccurrence(occId, tenantId)` that: calls `this.supabase.admin.rpc('delete_booking_with_guard', …)` directly, inspects the structured return, and **reproduces `BookingCompensationService.deleteBooking` VERBATIM** — emits the `booking.compensation_failed`/`booking.compensation_partial_failure` `audit_events` rows + returns/sets the outcome the existing materialize loop keys on so the `materialized_through`-don't-advance behaviour is byte-identical (cite `booking-compensation.service.ts` line:col + the materializer keying line:col). `cloneBundleOrdersToOccurrence` + `OrderService.cloneOrderForOccurrence` stay UNCHANGED in TS (they legitimately need the JSONLogic resolver).
2. DELETE `apps/api/src/modules/reservations/booking-transaction-boundary.ts` (interface + `InProcessBookingTransactionBoundary` + `BOOKING_TX_BOUNDARY` token + `InjectBookingTxBoundary` + `CompensationOutcome`) and `apps/api/src/modules/reservations/booking-compensation.service.ts` (after porting the still-needed audit-emit + outcome-map into the focused helper above — port, don't re-abstract).
3. `reservations.module.ts`: remove the `{ provide: BOOKING_TX_BOUNDARY, useClass: InProcessBookingTransactionBoundary }`, the `BookingCompensationService` provider, and both `exports` entries.
4. `booking-flow.service.ts`: delete the dead `@Optional()` txBoundary/compensation injects + the `void this.txBoundary; void this.compensation;` lines (a no-op caller since P1-1).
5. Specs: DELETE `booking-compensation.service.spec.ts`; rewrite the ~3 boundary-mocking describe blocks in `recurrence-materialize.service.spec.ts` to assert (a) clone runs, (b) on clone failure the direct `delete_booking_with_guard` fires, (c) the `compensation_failed`/`partial_failure` audit rows are emitted, (d) `materialized_through` is NOT advanced on unexpected failure. Grep `booking-flow-atomicity.spec.ts` / `multi-room-booking.service.spec.ts` for stale boundary refs → clean.
6. Smoke: NEW `smoke:recurrence-clone` (or extend an existing recurrence smoke if one already drives create-with-recurrence — check first). Mirror the smoke-cancel-booking harness. Drive `POST /api/reservations` with `recurrence_rule` + a master booking carrying services (orders/OLIs mixed `repeats_with_series` true/false, an asset_reservation, an approval). Because `startSeries`/`materialize` are void+catch-swallowed, POLL the occurrence bookings' rows (the smoke seeds a tight horizon so ≥1 occurrence materialises) and assert: cloned orders/OLIs only for `repeats_with_series=true`, windows time-shifted by (occurrence.start − master.start), AR + approvals cloned, tenant-scoped. A second fixture forces a clone failure (e.g. a pre-seeded conflicting confirmed asset_reservation on the occurrence window) and asserts the orphan occurrence booking is DELETED + a `booking.compensation_*` audit row exists + `materialized_through` not advanced. Per-occurrence-booking-scoped assertions (no global counts). Register package.json×2 + smoke-gates.md + CLAUDE.md. If after investigation `materialize()` cannot be made to deterministically produce an occurrence within a live smoke's time budget, that is a real blocker → surface it honestly (rewritten jest covers the wiring; smoke status `blocked` with the reason), do NOT fake an entrypoint or assert HTTP-200-only.
7. NO error codes, NO migration, NO `@prequest/shared` change.

---

## (SUPERSEDED by plan-review C1) D1 — direction decision: **new `clone_services_to_occurrence_booking` RPC + direct `delete_booking_with_guard` orphan-cleanup**

Options weighed:
- **(A, CHOSEN) New clone RPC.** A PL/pgSQL `clone_services_to_occurrence_booking(p_master_booking_id, p_occurrence_booking_id, p_window_delta?, p_tenant_id, p_actor_user_id, p_idempotency_key)` that, in ONE tx, reads the master's `repeats_with_series=true` orders/OLIs/asset_reservations/approvals and inserts the time-shifted clones onto the pre-created occurrence booking. `materialize()` then: `bookingFlow.create()` (existing atomic occurrence create) → call the clone RPC → **on clone-RPC failure, the materializer calls `delete_booking_with_guard(occurrenceId)` DIRECTLY** (the audit explicitly keeps `delete_booking_with_guard` as the compensation primitive; a direct guarded-RPC call is exactly what `WorkflowEngineService.tryCancelChildBooking` already does — it is NOT the `BookingTransactionBoundary` abstraction). The 3 boundary classes delete. Net: the clone is atomic (one RPC, audit "one pattern" thesis); the orphan-occurrence-on-clone-failure behaviour is preserved faithfully (still deleted); zero new abstraction.
- (B, rejected) TS pre-builds a plan + reuse `attach_services_to_existing_booking`. Rejected: the master-read + `repeats_with_series` filter + time-shift is non-trivial clone logic; doing it in TS recreates the choreography the audit wants gone, and an attach-RPC failure STILL orphans the occurrence ⇒ still needs compensation. No real simplification.
- (C, rejected) Fold occurrence-create + clone into one `create_booking_with_attach_plan` call. Rejected: `materialize()` deliberately uses `bookingFlow.create()` (occurrence inherits series rules; the clone copies the master's approvals rather than re-routing). Hand-building the create input would have to reproduce `bookingFlow.create()`'s rule/conflict/approval path for occurrences — large blast radius, higher risk than a focused clone RPC.

(A) is the minimal faithful change that satisfies the audit thesis. It mirrors the established family (00408/00414) RPC shape.

## RPC shape (mirror 00408/00414 family — verify each clause vs the live template)

1. arg null/shape guards (master/occurrence/tenant/idempotency required).
2. F-CRIT-1 actor resolve **null-tolerant** (the cron has no actor — pass null; F-CRIT-1 skips resolution on null exactly like Slice-6 00414; an ad-hoc admin extend can thread a real authUid later — out of scope here, document).
3. advisory xact lock `hashtextextended(tenant||':occ-clone:'||occurrence_booking_id,0)`.
4. command_operations idempotency gate, deterministic md5 over `(p_master_booking_id, p_occurrence_booking_id, p_tenant_id, v_actor_users_id)` — naturally idempotent on `occurrence_booking_id` (one clone per occurrence); cron retries collapse. NO Date.now/random/unsorted (D-5/D-6-class).
5. lock master + occurrence bookings FOR UPDATE, tenant-scoped → raise `*_not_found` (master/occurrence distinctly).
6. read master orders/OLIs (`repeats_with_series=true`) /asset_reservations/approvals; reproduce `OrderService.cloneOrderForOccurrence()`'s clone+time-shift semantics VERBATIM (cite the live method line:col; the window delta = occurrence.start − master.start; menu/price snapshot copy; asset re-link rules; approval clone vs re-route — reproduce exactly, do not "improve").
7. INSERT the cloned orders/OLIs/asset_reservations/approvals onto the occurrence (tenant-scoped every write — #0 rule).
8. in-tx audit_events (clone continuity) — NOT swallowed. domain_events if the family pattern has one. NO outbox emit unless a real consumer needs it (the occurrence-clone has no visitor cascade — verify; if none, no emit, documented).
9. finalize command_operations success; return `{cloned_order_ids, cloned_oli_ids, cloned_asset_reservation_ids, cloned_approval_ids}`.
10. security definer; set search_path=public,outbox; revoke public + grant service_role (clone is a cron/system op — cancel/clone-family DEFINER posture, consistent with 00408/00414; documented).

## TS + wiring

- `recurrence.service.ts`: `materialize()` → `bookingFlow.create()` (unchanged) then `this.supabase.admin.rpc('clone_services_to_occurrence_booking', …)`; on RPC error, call `delete_booking_with_guard(occurrenceId)` directly (a small private helper or inline) + rethrow/log per current behaviour. Delete the `@Optional() txBoundary`/`compensation` injects + the `runWithCompensation` call + (now-dead) `cloneBundleOrdersToOccurrence` TS body (its logic moves into the RPC) — confirm no other caller of `cloneBundleOrdersToOccurrence`/`cloneOrderForOccurrence` first (if `cloneOrderForOccurrence` is reused elsewhere, leave it; only retire the boundary-wrapped path).
- `booking-flow.service.ts`: delete the dead `@Optional()` txBoundary/compensation injects + `void this.txBoundary; void this.compensation;` lines (already a no-op since P1-1).
- `reservations.module.ts`: remove the `BOOKING_TX_BOUNDARY` provide/useClass + `BookingCompensationService` provider + both exports.
- DELETE `booking-transaction-boundary.ts` + `booking-compensation.service.ts`.
- Error codes: register `clone_services_to_occurrence_booking.{master_not_found, occurrence_not_found, actor_not_found, invalid_args}` in error-codes.ts union+registry + map-rpc-error STATUS_BY_CODE + messages.en/nl (mirror the cancel-family rows). Rebuild @prequest/shared.

## Specs

- DELETE `booking-compensation.service.spec.ts` (the class is gone).
- Rewrite the ~3 boundary-mocking describe blocks in `recurrence-materialize.service.spec.ts` to assert the clone RPC is called + the direct `delete_booking_with_guard` on failure (not the boundary mock).
- Grep `booking-flow-atomicity.spec.ts` / `multi-room-booking.service.spec.ts` for stale boundary refs → clean.
- Constructor-arity: both injects are `@Optional()` → safe; still re-run jest to catch any DI surprise.

## Smoke

NEW `smoke:recurrence-clone` (mirror smoke-cancel-booking harness): seed a recurrence_series + a master booking WITH services (orders/OLIs/AR/approvals, mixed `repeats_with_series` true/false) + a pre-created occurrence booking; call the clone RPC (or trigger `materialize()` if cheaply reachable from the API — else call the RPC directly via a thin test route is NOT acceptable; prefer driving `materialize()` through whatever entrypoint exists, or document why RPC-direct is the honest gate). Assert: cloned orders/OLIs (only `repeats_with_series=true`) with correctly time-shifted windows; asset_reservations + approvals cloned; idempotency replay (same occurrence → no dup); atomic rollback (force an in-tx failure → ZERO partial clones + the orphan-cleanup path deletes the occurrence); cross-tenant reject; per-booking-scoped assertions. Register package.json×2 + smoke-gates.md + CLAUDE.md. If `materialize()` is genuinely not drivable from a live API entrypoint (cron-only), the honest gate is the RPC-direct smoke + the rewritten jest for the materialize wiring — state this explicitly, do NOT fake an entrypoint.

## Migration

NEW `clone_services_to_occurrence_booking` RPC migration — claim next-free number at write time (`ls supabase/migrations/ | tail`; 00414 currently highest → expect 00415; auto-rebase on collision). No schema/data/RLS change.

## Out of scope (documented, not silent)

- ad-hoc admin-extend actor threading into the clone RPC (cron is null-actor; an admin entrypoint could thread authUid later) — note as a follow-up, not Slice-7.
- cancel/clone-family DEFINER vs create/attach-family INVOKER posture harmonisation — still the P2/P3-cleanup observation from Slice 6.
