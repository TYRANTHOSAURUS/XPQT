# B.0 — Domain outbox cutover (shipped)

> Closing retrospective for the B.0 slice of the durable domain
> outbox project. Created 2026-05-04 as the final commit of B.0.F.
> Spec: [`docs/superpowers/specs/2026-05-04-domain-outbox-design.md`](../superpowers/specs/2026-05-04-domain-outbox-design.md).

## What shipped

The booking-create + approval-grant + setup-work-order paths are now
atomic at the Postgres layer. The legacy split-write pattern (TS
sequences `await supabase.from(X).insert()` calls across multiple
tables, with in-process `BookingTransactionBoundary` compensation) is
retired on these paths in favour of:

- One `client_request_id` per producer mutation attempt, threaded
  through the API route → middleware → RPC.
- One PL/pgSQL function per write surface, each acquiring an advisory
  lock at the head and emitting `outbox.events` rows in the same
  transaction as the domain mutation.
- One outbox handler driving asynchronous setup-WO creation through a
  fourth RPC that inserts the work order + dedup row + audit row
  atomically.

What this is NOT: full Phase 6 cutover. Booking cancellation,
standalone-order creation, multi-room flow, dispatch, and visitor-pass
assignment all still use the legacy TS-orchestrated pattern. Those are
the Phase 6 hardening backlog (spec §10X) — explicitly out of B.0
scope, owned by a follow-up sprint.

## By the numbers

- **Commits:** 28 `B.0.x` commits across A → B → C → D → E → F stages
  (orchestrated as 5 implementation slices + 1 closing slice).
- **Migrations:** 11 (00299–00312) covering the foundation + 4 RPCs +
  3 dedup tables + 4 validation helpers.
- **Tests:** baseline 1299 → final 1396 (+97 specs across the new
  helpers, plan-builders, RPC contracts, and middleware).
- **Stages:**
  - **B.0.A** — SQL helpers + tables (00302–00308).
  - **B.0.B** — 4 RPCs live (00309–00312).
  - **B.0.C** — TS plan-builder (`AttachPlan`, `planUuid`, `planSort`,
    `assemblePlan`, `buildAttachPlan`, `SetupWorkOrderRowBuilder`).
  - **B.0.D** — TS call-site cutover (`BookingFlowService`,
    `ApprovalService`, `BundleService`) + `clientRequestId`
    middleware.
  - **B.0.E** — `SetupWorkOrderHandler` → RPC; apiFetch contract;
    producer hooks thread `X-Client-Request-Id`; producer-route guard.
  - **B.0.F** — round-trip smoke probe + cutover follow-up docs +
    legacy `@deprecated` tagging + this retrospective.

## Spec evolution

8 design rounds + 1 mechanical patch before B.0.A started:

| Version | Outcome | Driver |
|---|---|---|
| v1 (`f5b96c5`) | Initial Plan B.1: durable outbox spec. | Original design. |
| v2 (`b38db4a`) | Postgres-side atomicity. | Codex review of v1. |
| v3 (`83f3ba0`) | Watchdog + lease compensation + worker state machine. | Codex v2 review. |
| v4 (`2c564f4`) | A-prime atomic attach + locked delete re-check. | Codex v3 review. |
| v5 (`48048f6`) | Combined RPC, no watchdog. v4-C{1..4} all resolved by removing the lease window entirely. | Codex v4 review (4 critical). |
| v6 (`fd561fd`) | Folded codex v5 findings (4 criticals + 3 importants + 1 nit). Deterministic uuidv5 + advisory-lock + setup_work_order_emissions table. | Codex v5 review. |
| v7 (`e96bec5`) | Folded codex v6 findings (3 criticals + 4 importants + 2 nits). Atomic approval grant; setup-WO atomic create RPC. | Codex v6 review. |
| v8 (`490c359`) | Folded codex v7 findings (1 critical + 6 importants + 1 nit). Identity-from-chain; reordered lock+validate; canonical sort uses `client_line_id` only; ON DELETE SET NULL on dedup FK. | Codex v7 review. |
| v8.1 (`b3cfe49`) | Folded codex v8 mechanical findings (C1 + I1 + Nit). FINAL design round before B.0 implementation. | Codex v8 review. |

Each spec round was independently reviewed by codex (per `.claude/CLAUDE.md` "Codex usage in this project"). After v8.1 closed,
B.0 implementation started immediately.

## Architectural pattern that emerged

The most general lesson — codified into [CLAUDE.md "Architecture"
§Multi-step writes are PL/pgSQL RPCs, not TS pipelines](../../CLAUDE.md):

> If a feature has to write to ≥2 tables and any partial-write state
> is corrupting (cross-table invariants, FK chains, audit-trail
> integrity, outbox emit + domain mutation), the writes go inside one
> PL/pgSQL function called from TypeScript — NOT a sequence of
> supabase-js HTTP calls in TS.

This was the root cause behind v3-C{1..4}, v4-C{1..4}, v5-C{1..4}, v6-C
{1..3}, v7-C{1..3}: each round of review found new ways the TS-level
"split write + boundary compensation" pattern could leak partial state
under crash, retry, or contention. Five rounds of trying to patch the
TS layer; v5 onward stopped trying and put the writes in PG instead.

## Lessons learned

1. **TS is for plans, PG is for writes.** Once a feature crosses the
   "≥2 tables and consistency matters" threshold, the TS layer's job
   shrinks to: validate inputs, compute deterministic UUIDs, sort
   canonical input arrays, build the jsonb plan. The actual writes
   are one RPC call. This is a structural defense, not a stylistic
   preference — it's the difference between "tested" and "actually
   atomic."

2. **Codex reviews between slices are the difference.** Eight
   independent reviews caught issues that the spec author (this
   model) had missed even after re-reading. Specifically: codex v4
   found that the lease-watchdog v3/v4 design had four critical
   issues that all dissolved when the lease was removed. The spec
   only got there because of an external reviewer with a fresh
   read.

3. **Mocked tests are necessary but not sufficient.** Spec §15.3
   (smoke gate extension) and §15.5-bis (real-DB concurrency
   harness) explicitly carve out test scenarios that mocks can't
   cover. The smoke probe (B.0.F.1) is shipped; the concurrency
   harness is deferred (B.0.F.2). Mocks caught contract drift in
   B.0.B, but only the live smoke against the remote DB will catch
   the next 42501.

4. **Idempotency keys are the user's escape hatch.** The
   `X-Client-Request-Id` thread (middleware → producer routes →
   RPCs) means a React Query retry of a failed booking-create gets
   the same idempotency key as the original attempt. The combined
   RPC's advisory lock + cached_result branch turns "click submit
   twice while the network is slow" from a duplicate-bookings P0
   into a no-op silent success. v7's auto-stamp at `apiFetch` scope
   was a regression (lost stability across retries); v8.1 moved
   id generation to mutation-attempt scope inside producer hooks.

5. **Don't pretend a watchdog is durable.** v3/v4's lease + watchdog
   pattern read as "durable" on paper but had four crashes-during-
   compensation failure modes that v5 deleted by collapsing the
   write into one tx. If you can do one tx, do one tx. The watchdog
   was a five-month patch on a one-month problem.

## Remaining "Not in B.0" deferrals

Spec §10X enumerates the split-writes that B.0 did NOT address. Each
is bounded (admin tooling can recover) but should be migrated to the
v5-onward pattern in the Phase 6 hardening sprint:

1. **Booking cancellation cascade**
   (`apps/api/src/modules/booking-bundles/bundle-cascade.service.ts:115`)
   — needs `cancel_booking_atomic` RPC.
2. **Standalone-order creation**
   (`apps/api/src/modules/orders/order.service.ts:752`) — needs
   `create_standalone_order_with_attach_plan` RPC.
3. **Multi-room booking + service attach**
   (`apps/api/src/modules/reservations/multi-room-booking.service.ts:300-329`)
   — needs combined RPC mirroring `create_booking_with_attach_plan`
   for N rooms.
4. **`TicketService.dispatch`,
   `VisitorPassService.assignFromPool`, recurrence-clone paths** —
   same pattern, smaller scope.
5. **Real-DB concurrency harness** — see
   [`b0-real-db-concurrency-harness.md`](./b0-real-db-concurrency-harness.md).
   Cutover gate before Phase B of §5.1 flips the
   SetupWorkOrderHandler from shadow to active.
6. **§16.1 cleanup commit** — see
   [`b0-legacy-cleanup.md`](./b0-legacy-cleanup.md). Tag now,
   delete after stabilisation.

## What's next

1. **Smoke run against staging** (manual, before flipping the
   handler from shadow to active per §5.1 Phase B). Run
   `pnpm smoke:outbox` with the dev server up. Verify all assertions
   pass + no leftover fixtures in the seed tables.
2. **Real-DB concurrency harness** (~1 day) — unblocks the cutover.
3. **Burn-in window** — 7 days, ≥50 samples, zero
   `outbox_shadow_results.matched=false`. Spec §16.2 #21.
4. **Phase B flip** — switch the handler from shadow → active. The
   pre-existing in-process trigger path (`SetupWorkOrderTriggerService`)
   keeps running for non-outbox callers (multi-room, standalone-order)
   until those cut over too.
5. **§16.1 cleanup commit** — delete legacy code after the burn-in,
   per the timeline in [`b0-legacy-cleanup.md`](./b0-legacy-cleanup.md).

After B.0, Phase 6 of the original architecture brief
(`docs/superpowers/specs/2026-05-04-domain-outbox-design.md` §0) is
complete.
