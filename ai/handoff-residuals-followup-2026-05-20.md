# Handoff — close the residuals-followup loop best-in-class (2026-05-20)

You are a fresh agent. Self-contained brief. Goal: take every listed follow-up to a
best-in-class fix OR an explicitly-justified deferral (owner + reason + risk + why
it can't be absorbed here). No half-fixes. No fake green. No bookkeeping
"improvements" that don't enforce anything.

## Ground truth — verify before acting

- `origin/main ≈ 7ba19d9c` (the 5-residual closeout merged via PR #36/#37/#38/#39/#40
  on 2026-05-20). Re-fetch and re-pin — concurrent sessions advance main under you.
- `pnpm smoke:prod-e2e` exists on main with `R1_LANDED=1` returning 4/4 green live
  against `https://xpqt-api-eu.onrender.com`. R5 of the prior handoff.
- `pnpm errors:check-app-errors` has TWO ratchets now (R2's fold of codex critical):
  - Nest-exception regex over 45 migrated modules — `0 raw throws`
  - Raw-rethrow regex (`throw error;`) over **10** swept modules — `0 raw rethrows`
- `apps/api/src/common/errors/wrap-pg-error.ts` exists — wraps Postgres errors while
  preserving the filter's existing PG-code normalization (PGRST116 → 404, 23505 →
  409 unique violation, 23503 → 409 FK violation). This is the canonical mapper for
  all new and pending raw-rethrow migrations.
- Audit-04 RLS work is on main. Renumbered identities: old `00415/00417/00420` →
  `00434/00435/00436`. **NEVER re-attempt a schema-wide `REVOKE EXECUTE`** — it
  breaks RLS-helper EXECUTE for the entire browser/Realtime read path.
- Living-contract docs: root `CLAUDE.md` `## Smoke gates`, `docs/smoke-gates.md`,
  `docs/visibility.md`, `docs/assignments-routing-fulfillment.md`,
  `docs/follow-ups/audits/04-rls-security.md`, and the new R2 triage doc
  `docs/follow-ups/r2-apperror-sweep-triage-2026-05-20.md`. Update in the same PR
  as any change that affects them.

Re-verify before acting: `git fetch origin main && git rev-parse origin/main`;
`gh pr list --state open` (scan for *owned* overlapping work — see Rule 1 below).

## Follow-ups to drive to best-in-class

### F1 (P1, real-bug-class) — R2 sweep: 27 modules / 235 raw `throw error;` sites in already-AppError-migrated modules

**Evidence:** R2 of the prior handoff migrated 7 modules (asset / business-hours /
catalog-menu / delegation / notification / team / vendor) + 3 already-clean
(floor-plan / inbox / notifications) into a new raw-rethrow ratchet. The remaining
**27 modules** that are in the Nest-exception ratchet (`scripts/check-app-errors.sh`'s
`MIGRATED_MODULES`) still contain raw `throw error;` Postgres rethrows that can
surface as `unknown.server_error` 500 if the PostgrestError lacks `code`/`severity`
(the exact 22P02 class that triggered R1's bug).

Triage table at `docs/follow-ups/r2-apperror-sweep-triage-2026-05-20.md` enumerates
all 27 with site counts. Top offenders:
- `config-engine` — 31 sites
- `room-booking-rules` — 20
- `user-management` — 19
- `ticket` — 13
- `orders` — 13
- `maintenance` — 13
- `person` — 12

**Do:** For each of the 27 modules, replace every `if (error) throw error;` (and
any other raw rethrow pattern surfaced via `grep -nE 'throw\s+error\s*;|throw\s+e\s*;'
apps/api/src/modules/<module>/*.ts`) with a call to `wrapPgError(error, fallbackCode,
{ detail, notFoundCode? })` from `apps/api/src/common/errors/wrap-pg-error.ts`. The
helper already maps PGRST116 → 404 / 23505 → 409 / 23503 → 409 / else → 500. Add
new error codes per module following the R2 convention (`<module>.<op>_failed` for
500 fallback; `<module>.not_found` for 404 lookup-miss). Register codes in
`packages/shared/src/error-codes.ts` + EN+NL parity in
`apps/api/src/common/errors/messages.{en,nl}.ts`.

For each module:
1. Read it cold. Identify EVERY raw rethrow in the request path (exclude test files,
   fixtures, setup code).
2. Choose the appropriate `wrapPgError` invocation per site (some sites already
   pre-check existence and would benefit from a domain-specific `notFoundCode`).
3. Add the module to the raw-rethrow ratchet's `RAW_RETHROW_SWEPT_MODULES` list in
   `scripts/check-app-errors.sh`.
4. Confirm the gate stays green (`0 raw rethrows across <new total> swept modules`).
5. Confirm the parity spec stays green (`pnpm -C apps/api test -- messages.spec`).
6. Bring up the API on alt port 3017 and run the relevant `pnpm smoke:*` gate ≥2×
   green for any smoke-trigger-listed surface (e.g., `smoke:tickets` for `ticket`,
   `smoke:cross-tenant` for any auth-touching path).

**Sequencing — bound the scope.** 27 modules in one PR is too sprawling for a
clean review loop. Split into **logical sub-PRs** by risk-tier:
- Sub-PR A: the 7 highest-traffic modules (`config-engine`, `room-booking-rules`,
  `user-management`, `ticket`, `orders`, `maintenance`, `person`) — these are the
  most user-reachable. ~130 sites.
- Sub-PR B: the remaining 20. ~105 sites.

Each sub-PR gets its own review loop (Rule 5). Each lands separately, no rebase
hell.

**Update the triage doc in the same PR** — move migrated modules from "Deferred"
to "Done" with the closing PR number, and update the count headers. Don't leave a
phantom deferral.

### F2 (P2, security-adjacent) — `smoke:cross-tenant` non-R4 probe parallel-safety

**Evidence:** TEST 2 of the R4 post-merge empirical verification (2026-05-20) ran
two parallel `pnpm smoke:cross-tenant` processes against the same dev API. The R4
advisory lock correctly serialized R4 (one process skipped with
`realtime-skipped-concurrent-run`). But **4 OTHER probes failed** under concurrent
execution because their fixture-seeding model races:

- `POST /spaces` (non-admin config mutation)
- `POST /spaces` (non-admin role holds `spaces.create` → guard PASSES)
- `GET /config-entities/:id` (non-admin holds `request_types.use` → guard PASSES,
  was AdminGuard-403 pre-11.3)
- `POST /admin/visitors/types` (non-admin holds `visitors.configure` → guard
  PASSES, was AdminGuard-403 pre-11.5)

These probes seed fixtures (a space, a config-entity, a visitor-type) and tear
them down in `finally`. When two runs interleave, one's setup races the other's
teardown → 4 probes red. The R4 advisory-lock pattern is the proven antidote, but
applied only to R4 today.

**Do:** Identify EVERY probe in `apps/api/scripts/smoke-cross-tenant.mjs` that
mutates shared state (creates a space, role assignment, config entity, visitor
type, person, etc.). For each:
- Option A: rewrite to use per-run unique UUIDs (most probes already do this for
  tenant_id; extend to all child fixtures).
- Option B: extend the R4 advisory lock to wrap the whole gate (`pg_try_advisory_lock`
  on a single `smoke-cross-tenant` key at script start; second concurrent run
  skips with `cross-tenant-skipped-concurrent-run`).
- Option C: hybrid — use per-run UUIDs where cheap (most cases) + advisory lock
  around the unavoidable shared-state probes (a/b/c above).

Recommend C — keeps the gate fast for the common single-run case, prevents
collision in the rare concurrent case. Document the chosen approach in
`docs/smoke-gates.md` under the `smoke:cross-tenant` section.

**Verify** by re-running the TEST 2 scenario after the fix: two parallel processes,
both should exit 0 (either both green, or one skips the contested probes cleanly).

### F3 (P2, prevention) — pre-existing red Jest specs

**Evidence:** Across 3 separate sessions (R1, R2, R4 fix-up subagents), the
following test files were verified red on pristine `origin/main`:

- `apps/api/src/modules/visitors/admin.controller.spec.ts` — 3-7 failing assertions
  (count varies between sessions; possibly flake)
- `apps/api/src/modules/reservations/reservation-edit-scope.spec.ts` — 2-4 failing
  assertions

NOT caused by the R1-R5 work. Verified by `git stash` round-trips. The CI's
"Design check + typecheck" only runs `tsc --noEmit`, so these test failures don't
gate deploy. If they're covering real regressions, those regressions are invisible.

**Do:**
1. Reproduce both failure sets on a clean checkout of `origin/main`. Capture exact
   failure output.
2. Bisect: when did each test start failing? Use `git log --oneline -- <test file>`
   + `git bisect` if the recent history is ambiguous.
3. For each failing test, decide:
   - **Real regression in app code** → fix the app code. Confirm the test passes.
   - **Stale test against intentional code change** → update or delete the test.
     Document the rationale in the test file's header comment.
   - **Cannot reproduce** (flake) → mark as `.skip` with a `// FLAKE-2026-05-20:` tag
     and a follow-up file under `docs/follow-ups/`. Don't leave it red.
4. Wire `pnpm -C apps/api test` (or at minimum these two test files) into the CI
   workflow so future regressions are caught at PR time, not by manual cleanup.

If you discover that one of these is a real cross-tenant or visibility bug, treat
it as a P0 — escalate to the user.

### F4 (P3, prevention) — `smoke:prod-e2e` CI wire-up

**Evidence:** R5 of the prior handoff added `pnpm smoke:prod-e2e` but skipped the
CI step in `.github/workflows/deploy.yml` because GH Actions doesn't have
Supabase secrets (`SUPABASE_URL` / `SUPABASE_SECRET_KEY` / `SUPABASE_PUBLISHABLE_KEY`).
Until the gate runs in CI, prod regressions only surface on manual `pnpm smoke:prod-e2e`
invocation.

**Do:**
1. Identify the canonical Supabase secret values from `.env` (the user's local
   `.env` file). Surface these to the USER (not to a third-party / not in commit
   message / not in PR body) — only the names of the secrets, never the values.
2. Document the secret names + their role in `docs/smoke-gates.md` under the
   `smoke:prod-e2e` section.
3. Draft the `.github/workflows/deploy.yml` post-deploy step that runs
   `pnpm smoke:prod-e2e` AFTER the Render `live` confirmation step. Use
   `continue-on-error: false` so a red probe fails the workflow.
4. Open a PR with the workflow change but **DO NOT MERGE** until the user
   confirms the secrets have been added to GH Actions. Without the secrets, the
   step would red every deploy.

The user-action part (adding secrets) is the only thing not in your hands. Surface
the exact secret names + a one-line command (`gh secret set SUPABASE_URL`,
`gh secret set SUPABASE_SECRET_KEY`, `gh secret set SUPABASE_PUBLISHABLE_KEY`) the
user can run to add them.

## Execution rules — these bit prior agents; follow them

1. **Owned-PR check BEFORE opening any PR or briefing a subagent that opens one.**
   `gh pr list --state open` + `git branch -a` + grep for keywords in branch subjects.
   If overlapping owned work exists, your job becomes "stack on top" or route to
   that owner — never a competing duplicate PR.
2. **Cross-session shared tree.** Operate in isolated worktrees off CURRENT
   `origin/main`. Re-verify `git rev-parse origin/main` before every merge —
   concurrent sessions move it. File-scoped explicit-pathspec commits ONLY
   (`git add <paths>`; never bare `git add -A` / `git commit`).
3. **DB pushes are deploy-class — confirm with the user every time.** F1 does NOT
   require a migration (only TS changes + error-codes additions). F2 / F3 / F4
   also don't require migrations.
4. **Verify every claim against committed HEAD + live remote** — never the working
   tree alone, never a reviewer's prose. Re-run gates yourself; don't trust a
   subagent's "it passes."
5. **Review loop on substantive slices:** `/full-review` (2 adversarial Agent
   subagents) → fold REAL findings (verify every CRITICAL against actual code) →
   codex tertiary (`codex exec --full-auto -C /Users/x/Desktop/XPQT`,
   prompt-to-file + short ARGV; close stdin with `</dev/null`) → push → smoke
   ≥2× → commit. F1 sub-PRs are large enough to warrant the full loop each. F2
   is security-gate-adjacent — codex tertiary is warranted. F3 + F4 can use
   `/full-review` only if the change is non-trivial.
6. **Runnable-guards mandate.** Every guard / CI check / verification snippet you
   write must be runnable against current main and verified passing before the PR
   ships. No paper tigers; no hypothetical regex; no invented paths.
7. **Brutal honesty.** State what's proven by RUNNING vs by inspection vs by
   deterministic logic. No "merged & verified" without re-verifying after every
   concurrent merge. No claiming "best-in-class" until the live gate is green on
   the CURRENT post-merge `origin/main`.
8. **Living-contract docs in the SAME PR** as the code change that affects them.

## Do NOT touch — documented owned by other sessions

- **PR #27** (`feature/booking-audit-remediation`). Codex-verified 2026-05-19 to
  carry un-landed audit02/03-booking work; left OPEN. Owners must extract before
  close. Don't close it; don't merge it. The uncommitted changes in the main
  repo working tree are this PR's owner — leave them alone.
- **`scripts/check-migration-prefixes.sh` exit-0 bug** + the broader
  migration-prefix collision epidemic. Owned by `fix/ci-migration-prefixes` branch.
- **The broad browser RPC-EXECUTE surface and SECURITY INVOKER reads.** Documented
  as tracked-P2/P3 posture; **NEVER re-attempt a schema-wide `REVOKE EXECUTE`** —
  it breaks RLS (the May-19 outage's exact cause). Lock individual proven
  `SECURITY DEFINER` leaks per-function only.
- **`.env`-side Render credentials.** `RENDER_API_KEY` lives ONLY in GH Actions
  secrets, never `.env`.

## Definition of done

- **F1**: every one of the 27 deferred modules either has its raw-rethrow sites
  migrated to `wrapPgError` AND is in `RAW_RETHROW_SWEPT_MODULES` AND has passing
  gate output, OR is explicitly re-deferred to a sub-followup PR with a named
  owner + sub-PR slot. The triage doc reflects the final state. Both sub-PRs
  merged green on origin/main AFTER your merges (re-verify).
- **F2**: two parallel `pnpm smoke:cross-tenant` runs both exit 0 (with the
  contested probes either using per-run UUIDs OR cleanly skipping under the
  extended lock). Documented in `docs/smoke-gates.md`. PR merged.
- **F3**: every previously-red test file is either green (root cause fixed +
  test passes) OR explicitly `.skip`'d with a follow-up doc + rationale. `pnpm
  -C apps/api test` is wired into CI. PR merged.
- **F4**: the deploy.yml post-deploy step is drafted; secret names documented;
  PR open for user-confirmation merge once secrets land. Don't merge until the
  user signals secrets are in.
- All PRs: green on `origin/main` AFTER your merges (re-verify), no carve-outs
  without explicit evidence, no fake green, living-contract docs in sync. No
  AI/Claude attribution in commits or PR bodies (repo rule).
- Final response: closed items with PR links + commit SHAs; explicit deferrals
  with owner + risk for anything not absorbed; honest proven-vs-assumed split.
