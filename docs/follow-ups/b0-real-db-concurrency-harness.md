# B.0 follow-up: real-DB concurrency harness for advisory-lock tests

> Tracked from v8.1 spec §15.5-bis. Required before claiming the
> advisory-lock behavior is verified end-to-end; deferred from B.0.F to
> keep the cutover shippable. Created 2026-05-04 alongside the B.0.F
> closing slice.
>
> Spec ref: `docs/superpowers/specs/2026-05-04-domain-outbox-design.md`
> §15.5-bis (harness contract), §15.5 (concurrent handler dispatch),
> §15.6 (concurrent grants), §11 open question 11, §16.2 #20a (cutover
> gate).

## What's needed

The cutover-blocking concurrency tests in §15.5 / §15.6 / §15.2 cannot
be validated by the mocked-jest specs that ship in B.0. Mocks can't
simulate Postgres advisory-lock acquisition order, commit timing, or
the behaviour of `for update` row locks across two real connections.

Two acceptable harness shapes per spec §15.5-bis:

1. **pgTAP via `pg_prove`** against a real Postgres instance —
   `lives_ok` / `throws_ok` + `pg_locks` introspection.
2. **Node test runner with `pg.Pool` direct connections** — spawn two
   connections from a single pool; one BEGINs + acquires the advisory
   lock + holds; the second BEGINs + tries to acquire; assert via
   `pg_locks` that the second is blocked (`granted=false`); release
   the first; assert the second proceeds. Run with `--runInBand`.

Either approach needs:
- A way to point the harness at the local Supabase (`db:start`) or a
  dedicated test DB, NOT the remote project.
- A `truncateAll()` helper or savepoint-rollback wrapper between
  scenarios.
- A jest config (or pgTAP runner script) separate from the unit
  tests so a slow/flaky harness doesn't block fast feedback on TS
  changes.

## Tests to add (port from §15.5 / §15.6 / §15.2)

All four B.0.B RPCs use `pg_advisory_xact_lock` at the head:

1. **`create_booking_with_attach_plan`** (§15.2)
   - Concurrent retries with the same `idempotency_key` serialize via
     the lock. The second connection blocks until the first commits,
     then reads the committed `attach_operations` row and returns
     `cached_result` — NOT a 23505 unique-violation.
2. **`grant_booking_approval`** (§15.6)
   - Concurrent grants on the same `approval_id`: first wins with
     `kind='resolved'`; second blocks then returns `kind='already_responded'`.
   - Concurrent grants on different `approval_id` values within the
     same parallel-group on the same booking: the booking-level lock
     serialises them; the second's `v_unresolved_count` reads
     post-commit so the resolution decision is correct.
3. **`approve_booking_setup_trigger`** (§15.5 / §15.6)
   - Concurrent grants serialise OLI processing; no double-emit, no
     skipped emit.
4. **`create_setup_work_order_from_event`** (§15.5)
   - Two workers somehow claim the same event (forced via
     stale-claim recovery). Both miss read-side dedup; both call the
     RPC; one acquires the per-OLI advisory lock, inserts WO + dedup
     atomically; second blocks then re-reads committed dedup and
     returns `kind='already_created'`. Exactly one WO created.

## Why deferred

- B.0 ships with mocked-jest specs covering happy paths + error
  mapping for all four RPCs. Mocks don't catch Postgres-level race
  conditions, but they do catch contract violations (wrong field
  names, wrong error codes, wrong return shapes).
- The advisory-lock implementation in PL/pgSQL was tested manually by
  psql during B.0.B implementation. Not automated, but exercised.
- Building the harness is meaningful infrastructure (separate jest
  config, local-DB fixture, `pg_locks` introspection helpers, CI
  pipeline change). 1+ day of work that doesn't materially change B.0
  shippability.

**Risk of not doing this:** a concurrent-retry race in production
produces an unexpected error class or duplicates work. The advisory
lock should prevent this, but is unverified by automated tests in
this repo.

## Estimated effort

1 working day:
- 2h: jest-int config + `pg.Pool` two-connection helper
- 4h: port the four scenarios above
- 2h: CI integration (separate workflow job vs. extend `pnpm test`)

## When to ship

Per spec §16.2 #20a: **before Phase B of §5.1 flips the
SetupWorkOrderHandler from shadow to active.** B.0 foundation is
already complete (all 4 RPCs live, all TS call sites cut over) — the
harness is the cutover-gate, not the foundation gate. If a noisy-
neighbour incident or a Phase B deploy shows cracks before then,
prioritise sooner.

## Related

- `docs/follow-ups/outbox-integration-tests.md` — broader outbox
  integration-test scaffolding deferred from the foundation slice.
  This harness is a subset (only the concurrency probes) and may share
  the `TestDbModule` infra when both land.
- `docs/follow-ups/phase-7-error-codes.md` — separate Phase 7 work,
  unrelated except for being tracked here.
