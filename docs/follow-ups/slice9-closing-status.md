# Slice 9 — booking-reservation audit (03) CLOSING STATUS

Status: **CLOSED 2026-05-17.** Doc-only closing slice — records the final
disposition of every P3 + every deferred discovered finding so the audit file
alone is the complete record (the audit completion bar: "P3 documented/deferred;
debts resolved or explicitly owned"). NO code change in this slice. The
authoritative detail is the audit 03 Closure Ledger `#### Update — 2026-05-17
(Slice 9 …)` + `#### Closing status` blocks; this doc is the narrative summary.

## What this workstream delivered (Slices 1–8 + debt #15)

Every actionable P0/P1/P2 in `docs/follow-ups/audits/03-booking-reservation.md`
is CLOSED + gated, OR explicitly deferred-with-owner+risk:

| Finding | Disposition | Gate / commit |
|---|---|---|
| P0-1 cancelOne non-atomic + lost outbox | CLOSED | `00408`, smoke:cancel-booking — Slice 2 `0c0a24c1` |
| P0-2 empty linked-row patches | CLOSED | `00407`, smoke:edit-booking — Slice 1 `a7570f14` |
| P0-3 dishonest smoke fixtures | CLOSED | Fixture D — Slice 1 |
| P1-1 multi-room on tx-boundary | CLOSED | →`create_booking_with_attach_plan` + `00410`, smoke:create-multi-room — Slice 3 `f3f36312` |
| P1-2 splitSeries non-atomic | CLOSED | `00411`, smoke:edit-booking-scope — Slice 4 `f88fe0af` |
| P1-3 attachServices TS N-write + Cleanup | CLOSED | `00412`+`00413`(I1), smoke:attach-services 44/0 — Slice 5 `f1085072` + debt #15 `8ed56917` |
| P1-4 cancelLine/cancelBundle TS choreography | CLOSED | `00414`, smoke:cancel-order-line 55/0 — Slice 6 `1a365f0f` |
| P1-5 booking.cancelled single producer | CLOSED | folded into P0-1/`00408` — Slice 2 |
| P2-1 BookingTransactionBoundary family | CLOSED (retired) | smoke:recurrence-clone 14/0 — Slice 7 `038ed506` |
| P2-2 source='auto' shim | CLOSED | tsc type-only — Slice 8 `e23ca198` |
| P2-4 recurrence_overridden two-places | CLOSED | tsc type-only — Slice 8 `e23ca198` |
| P2-3 two create_booking generations | **DEFERRED-with-rationale+owner** | Slice 8 plan-review C1 |
| P3-1 calendar inbound write-deferred | deferred-with-owner | Phase-C / MS-Graph |
| P3-2 bundle.service.ts size | deferred-with-owner (2339→1989) | future decomposition |
| P3-3 Reservation naming residue | deferred-with-owner | global Phase-8 naming sweep |
| P3-4 source='auto' mismatch | **CLOSED by P2-2** | sweep empty |

Discovered findings (surfaced by doing the work honestly): D-1/D-2/D-4 closed
(Slices 1/3); D-8 closed-in-slice (Slice 7 — a pre-existing P1: recurring
bookings materialised ZERO occurrences via HTTP since 2026-04-25, fixed);
D-5/D-6 explicitly-owned (producer-determinism, bundled, fix-design recorded);
D-9 deferred-with-owner (observability-only, correctness unaffected).

## Explicitly-owned deferred work (NOT a correctness gap in any shipped path)

1. **Producer-determinism slice** (debt #14/D-5 + D-6): a same-intent retry that
   straddles a rule/lead-time boundary spuriously 409s on `edit_booking_scope`
   / `attach_services_to_existing_booking` (shared with create — pre-existing,
   latent). Fix design: stable per-idempotency-key resolution basis persisted
   in `command_operations`/`attach_operations` on first attempt + reused on
   retry. Out of the atomicity mandate's scope (the RPCs ARE atomic); LOW
   practical exposure (no prod tenants; needs a wall-clock-referencing rule).
2. **Create-path-consolidation slice** (P2-3): retire legacy `create_booking`
   — but ONLY after relocating the `booking-flow.service.ts:372-383`
   `pending_approval` workflow/`createApprovalRows` fan-out into a canonical
   no-services attach-plan path (else a P0 on every approval-gated no-services
   create incl. recurrence occurrences — caught by Slice-8 checkpoint-1
   plan-review). Legacy fn is atomic+correct; this is consistency-not-correctness.
3. **Observability cleanup** (D-9): `materialize()` `e.response?.code` dead
   branches → read `(err as AppError).code`. Correctness unaffected.
4. **P3 cosmetic / Phase-C** (P3-1/2/3): MS-Graph inbound; bundle.service
   decomposition; global naming sweep. Zero correctness impact.

## Process notes (the working method that made this best-in-class)

- Pure orchestrator: investigation/implementation/review delegated to
  fresh-context subagents; main context held decision state + verification.
- TWO-checkpoint review every non-trivial slice (plan-review BEFORE coding
  caught direction errors cheaply — killed an infeasible clone-RPC in Slice 7
  and a P0-inducing create cutover in Slice 8 PRE-coding; impl-review after).
  Codex 0-byte-hung the entire session → skipped per `feedback_review_loop_protocol`;
  the 2-agent self-review was the load-bearing gate and caught a real defect
  EVERY slice.
- Runnable-guards-mandate + brutal-honesty: every smoke gate was RUN by the
  orchestrator (not trusted from a subagent). Slice 7's gate failed 6× before
  green — each failure empirically root-caused, NONE papered over (one of them
  surfaced the pre-existing P1 D-8). Slice 5/6 own-smoke runs caught
  non-functional/overstated probes a static review had called "honest".
- Every slice-redirecting reviewer/subagent claim was re-verified against live
  code/DB before propagation (the D-5 misdiagnosis lesson) — multiple plausible
  claims were falsified this way before anything false shipped.
- Surgical commits on the shared branch (explicit booking-scoped paths only;
  pre-existing parallel-workstream files never staged).

## Remaining best-in-class gaps (honest)

None in any SHIPPED path. The booking subsystem's every multi-write lifecycle
op is now one atomic idempotent PL/pgSQL RPC with live smoke coverage. The
explicitly-owned deferred items (1–4 above) are real follow-up work but each is
either out-of-mandate-scope, prerequisite-gated, observability-only, or
cosmetic — none is a correctness defect in a path that ships today.
