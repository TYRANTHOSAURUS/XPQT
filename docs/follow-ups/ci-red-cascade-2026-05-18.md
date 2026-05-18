# CI red cascade — root-cause record + owed follow-ups (2026-05-18)

## Summary

`main` CI had been red on **every** run for a long time; PRs inherited red and
the project kept merging through it. Investigation found this was **not** one
or two bugs but a **5-deep cascade of independent pre-existing failures**, each
hidden behind the previous by fail-fast ordering:

| # | Failure | Job / step it killed | Why it was masked |
|---|---------|----------------------|-------------------|
| RC1 | 13 duplicate migration filename prefixes → `schema_migrations` PK collision | `migration-smoke` + `B.0 concurrency` (abort during `supabase start`'s internal migration apply) | first failure in those jobs |
| RC2 | `ripgrep` not installed on the GitHub `ubuntu-latest` runner; `check-b2-config-reads.sh` / `check-naming-allowlist.sh` use `set -uo pipefail` **without** `set -e`, so a missing `rg` silently produced an empty snapshot → spurious "entire allowlist removed" diff | `check` job @ "B.2 config-reads check" | first failing step in `check` |
| RC3 | web naming-allowlist drift — 6 pre-existing legacy-name refs (`bookings.tsx` historical comment; 2 `scheduler-floor-view.tsx` locals; 3 `idempotency.ts` JSDoc/URL refs from PR #20) | `check` @ "Phase 8 naming" `[web]` | behind RC2 (fail-fast) |
| RC4 | web eslint 4 errors pre-existing on main — `inbox/queries.ts` (`@tanstack/query` exhaustive-deps + infinite-query-property-order) and `test-setup.ts` (`eslint-disable` naming a rule the flat config never registers) | `check` @ "Typecheck web" | behind RC3 |
| RC5 | api naming-allowlist drift — 24 pre-existing legacy-name refs in `apps/api/src` (booking-bundles / outbox cascade handlers / reservations / visitors) introduced by **PR #20 (booking-audit)**, which merged through red CI without updating `apps/api/src/.naming-allowlist.txt` | `check` @ "Phase 8 naming" `[api]` | behind RC4 |
| RC6 ✅ RESOLVED | **B.0 concurrency harness** — ~39 pre-existing test failures across 4 suites (`reclassify_ticket`, `create_ticket_with_automation`, `grant_ticket_approval`, `grant_booking_approval`). Root cause: the harness's `seedRequestType` INSERT into `workflow_definitions` violates `workflow_definitions_entity_type_check` (test-fixture seed vs current schema drift) — **not** concurrency logic, **not** caused by the RC1 renumber (verified: schema-only-equivalent renames; `migration-smoke` + schema-integrity asserts pass; the ticket-domain suites that fail were untouched by the renumber) | `B.0 concurrency` @ "Run concurrency harness" | doubly masked: B.0's `dorny/paths-filter` rarely triggered on recent main pushes (vacuous "success"), and when it did it died earlier at RC1's `supabase start` collision — so `pnpm test:concurrency` had not actually executed on recent main at all |

## What the fix PR (`fix/ci-migration-prefixes`) did

- **RC1** — renumbered the 13 colliding files to a contiguous free block
  `00415–00427` (true max prefix was `00414`), ascending-old→ascending-new so
  relative order is preserved. Floor-plan track moved at the 10 floor-vs-other
  collisions; at the 3 collisions where **both** files are non-floor
  (`00406` routing-vs-roombooking, `00407`/`00410` booking-vs-booking from
  PR #20) the safe mover was chosen (plpgsql / last-in-version-chain), keeping
  the file with create-time dependents in place. Codex + two adversarial
  reviews + a clean `pnpm db:reset` (all 425 migrations, exit 0) verified
  forward-dependency and versioned-chain "last-wins" safety. In-moved-file
  self/cross-reference comments were corrected. **Remote DB is unaffected**:
  it was populated via the raw `psql -f` push fallback, which does not write
  Supabase's `schema_migrations` ledger, so renaming local files cannot
  desync remote — no remote re-apply was done or needed.
- **RC2** — `ci.yml` installs `ripgrep` before the first `rg`-dependent step;
  **both** guard scripts now hard-fail loudly (`exit 2`) if `rg` is absent, so
  this silent-cascade class can never recur (a missing `rg` is now an
  unambiguous error, not a misleading allowlist diff).
- **RC3 / RC4** — fixed properly: the 2 scheduler locals were **renamed**
  (not allowlisted); the genuine doc/URL refs were classified into the web
  allowlist; the inbox query keys were corrected to key on the resolved
  `limit` (a cache-correctness improvement); the dead `eslint-disable` was
  removed.
- **RC5** — the 24 PR #20 api refs were classified into
  `apps/api/src/.naming-allowlist.txt` mirroring the file's existing
  `KEEP_*` precedent. **Allowlist-only — no booking-domain code was renamed.**
- **RC6** — **Deferred by PR #21 (owner decision 2026-05-18); RESOLVED by
  a separate follow-up PR same day** — see "Owed follow-ups" item 0 below
  for the actual root cause + fix. PR #21 fixed RC1-RC5 (CI-verified: the
  `check` and `migration-smoke` jobs go red→green) and intentionally left
  B.0 *visibly* red rather than masked. The follow-up PR makes B.0 honestly
  green without touching any production RPC, migration, or schema constraint.

## Owed follow-ups (NOT this PR's debt)

0. **RC6 — B.0 concurrency-harness fixture drift. ✅ RESOLVED 2026-05-18**
   (follow-up PR, branch `worktree-ci-rc6-concurrency-seed`, base
   origin/main `c96b5376`). Pre-existing; surfaced (not caused) by PR #21
   unmasking the harness. **Test-fixture-only fix — zero production RPC /
   migration / schema-constraint changes.** The original "single shared
   seed fix" hypothesis was right for the bulk but incomplete: there were
   **two independent drifts**, both stale-harness-vs-post-migration:

   - **Drift A — seed/schema (3 suites: `reclassify_ticket`,
     `create_ticket_with_automation`, `grant_ticket_approval`; 7 INSERT
     literals).** Root cause: migration
     `00369_workflow_polymorphism_booking.sql:192-196` replaced
     `workflow_definitions_entity_type_check` with
     `CHECK (entity_type IN ('case','work_order','booking'))`, dropping
     the legacy `'ticket'`. The harness seeded `entity_type='ticket'`.
     **Fix:** `'ticket'` → `'case'`. This is the canonical mapping, not
     mere constraint-appeasement: `00368` backfilled exactly
     `set entity_type='case' where entity_type='ticket'` ("ticket-domain
     workflows are all case workflows"); `00369:207` set the column
     DEFAULT to `'case'`; production `workflow.service.ts:52` routes
     `entityKind==='case'` → `startForTicket`. Tickets *are* the `case`
     polymorphic kind post-`00369`.

   - **Drift B — lock topology (1 suite: `grant_booking_approval`,
     second test only).** Root cause: the BLOCKER-2 closure in
     `00403_grant_booking_approval_v2.sql` /
     `00426_grant_booking_approval_v3_outbox_emit_signature_fix.sql`
     (body ~174-201) *deliberately* replaced the pre-`00310` per-booking
     **advisory** lock with a `bookings … FOR UPDATE` **row** lock. The
     harness's second test still asserted on a per-booking advisory lock
     via the advisory-only helpers (`helpers.ts:85` `pgLocksFor`, `:111`
     `waitForBlocker`) → deterministically 0 holders → fail. **Not a real
     ordering bug and not flaky** — it reproduced byte-identically across
     independent runs, and the *first* test (per-approval advisory key,
     which matches v3's real lock) always passed. **Fix:** migrate the
     second test to the harness's already-shipped, purpose-built
     `waitForRowLockBlocker` (`helpers.ts:139-174`) + `pg_blocking_pids`
     — i.e. complete an incomplete migration (the helper existed and the
     first test was migrated; the second was missed). RPC untouched.

   **Verification:** `pnpm test:concurrency` 16/16 suites, 154/154 tests
   green across 5 full runs + 2 determinism repeats on a real local
   Postgres; the now-green `check` and `migration-smoke` jobs
   re-verified non-regressed (zero migration changes). Reviewed by
   `/full-review` (0 critical/0 important) + codex (0 critical/0
   important); one codex nit applied (raised the row-lock-wait ceiling
   5s→15s for loaded-CI tolerance — state-polled, cannot mask a real
   failure). The B.0 `dorny/paths-filter` includes
   `apps/api/test/concurrency/**`, so this PR's run executes B.0 for real.
1. **RC5 + RC3-idempotency refs are PR #20 (booking-audit) debt.** This
   CI-hygiene PR *absorbed* them only to get CI green; it did not introduce
   them. The booking-audit / Phase 8 workstream owns the eventual canonical
   rename (`reservations/` → `bookings/`, dropping the `bundle_id` /
   `booking_bundle` compat aliases). The allowlist entries are tagged with a
   dated `# === CI-hygiene 2026-05-18 — PR#20 booking-audit refs ===` header so
   they are not mistaken for this PR's own design.
2. **Process: stop merging through red CI.** The cascade existed only because
   multiple PRs (incl. #20) merged while `main` CI was red, so each new
   pre-existing failure was invisible behind the prior. Recommend a branch
   protection / required-check policy once this PR makes `main` green.
3. **`deploy` workflow is separately red** — out of scope here (no migration /
   db:reset / naming steps; push-to-main only). Needs its own investigation;
   likely environment/secrets, unrelated to this cascade.
4. **Migration-number collisions are structural.** Parallel workstreams keep
   numbering into the same slots. A pre-commit / CI guard that rejects a PR
   introducing a duplicate `supabase/migrations/NNNNN_` prefix would prevent
   RC1-class recurrence cheaply.
