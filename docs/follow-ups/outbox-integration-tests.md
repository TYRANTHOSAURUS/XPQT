# Outbox — integration test wiring (deferred)

> Created 2026-05-04 alongside the Plan B.1 outbox foundation
> (`5cc4ca1`, `2e7f689`, the test commit). The v3 spec §11.2 calls
> for end-to-end integration tests against a real Supabase. Those are
> intentionally NOT shipped in the foundation slice — they need
> infrastructure work that doesn't exist yet in `apps/api/`.

## Why deferred

`apps/api/jest.config.cjs` runs unit tests only:

```js
preset: 'ts-jest',
testEnvironment: 'node',
testRegex: '.*\\.spec\\.ts$',
```

There is no `pnpm test:integration` script, no separate test config that
spins up the local Supabase stack, and no fixture/seed harness to give
each test a clean DB. Adding all of that is a bigger refactor than the
outbox foundation itself, and the v3 spec acknowledges this gap
explicitly (§11.2: "If test-DB wiring slips, handler unit tests + the
smoke-test gate carry the reliability load").

The 30 unit tests shipped in the foundation slice cover:

- service: emit fire-and-forget swallowing + correct RPC arg shape, plus
  markConsumed throwing on RPC error.
- registry: DiscoveryService walk, version-mismatch null, conflict
  detection, missing-instance / missing-handle defensive skips, stable
  startup log line for §10.1 deploy verification.
- worker: claim CTE shape, all four §4.2 transitions (success, retry,
  dead-letter via max_attempts and DeadLetterError, no_handler and
  tenant_not_found), stale-claim sweep, purge cron, tenant-cache reuse.

What unit tests CAN'T cover (and integration tests would):

1. The on-disk `outbox.events` schema — that the SQL we generate from
   TS round-trips a real PostgREST insert without coercion errors.
2. The §I3 `payload_hash` ON-CONFLICT verifier — same-key/different-
   payload actually raising 23505 from the real `outbox.emit()` SQL.
3. The drain index actually being chosen (`EXPLAIN` plan check).
4. End-to-end watchdog: emit a 1s-lease event, sleep, verify the worker
   claims it after available_at expires.
5. Stress: 1000 events through one `drainOnce()` with single-pass exact-
   ly-once + zero dead-letter under contention (SKIP LOCKED races).

The SQL helpers themselves were exercised manually in psql against the
remote DB at foundation merge time — see the smoke-test block at the
end of `5cc4ca1` (the migration commit). That established that the
schema + helpers are sound; what's deferred is *automating* that gate.

## What needs to ship for the integration tier

Roughly in order:

1. **`pnpm test:integration` script** — separate jest config, separate
   `testRegex` (e.g. `.*\.int\.spec\.ts$`), runs after `pnpm db:start`.
2. **`TestDbModule`** — a NestJS testing module that connects to the
   local Supabase via `DbService` + `SupabaseService` with the local
   service-role key. Provides a `truncateAll()` helper for between-test
   cleanup (or a savepoint-rollback wrapper if we want speed).
3. **Local-Supabase boot fixture** — global setup that runs
   `pnpm db:start` if not already up; teardown leaves it alone (don't
   want to thrash CI).
4. **First integration test** — `outbox-emit.int.spec.ts`: emit, read
   back the row, assert payload_hash, re-emit same payload (no-op),
   re-emit different payload (23505).
5. **Worker integration test** — `outbox-worker.int.spec.ts`: register
   a real handler, insert a row directly, run `drainOnce()`, assert
   processed_at + handler called once.
6. **Watchdog probe** — `outbox-watchdog.int.spec.ts`: emit with 1s
   lease, sleep 2s, drain, assert handler ran.
7. **Stress probe** — `outbox-stress.int.spec.ts`: 1000 events, single
   pass, exactly-once delivery + dead-letter floor at zero.

The CI pipeline change (a separate job that runs `pnpm test:integration`
against a fresh local Supabase) is its own slice — don't bundle it in.

## What stays out of the integration tier

- The §5.2 cutover gate query — that's a deploy-pipeline check, not a
  test. Lives in the cutover playbook, runs against staging DB.
- The §10.1 per-pod startup log assertion — operational, not unit-
  testable. Lives in the deploy runbook.

## When to revisit

When ANY of:

- The compensation cutover lands (Phase B activate-handler) — at that
  point the watchdog has real production responsibility and we should
  not be guessing whether the SQL round-trips correctly.
- A second producer adopts `outbox.emit` (sla_timer.create_required is
  next per spec §6 / §13.2). The N=1 unit-test coverage starts to feel
  thin once we have multiple consumers.
- Anyone proposes a non-trivial change to `outbox.emit` or the worker
  drain query — at that point integration tests prevent silent
  regression.

Until then: `pnpm smoke:work-orders` (per CLAUDE.md "Smoke gate") is
extended in the cutover slice with a forced-compensation probe and a
feature-flag-gated process-exit between attach-fail and compensation-
call (§15 #7). That covers the production-risk path even without
in-jest integration coverage.
