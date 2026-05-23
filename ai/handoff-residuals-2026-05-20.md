# Handoff — best-in-class the residuals from clean-main closeout (2026-05-20)

You are a fresh agent. Self-contained brief. Goal: take every listed residual from the
clean-main closeout to a real best-in-class fix OR an explicitly-justified deferral
(owner + risk + why it can't be absorbed here). No half-fixes. No fake green.

## Ground truth — verify, don't trust

- `origin/main` ≈ `a3a6efe5` (PR #34 merge). Re-fetch and re-pin — concurrent sessions
  advance main under you.
- Audit-04 RLS work is on main. Renumbered identities: old `00415/00417/00420` →
  **`00434/00435/00436`** (cross-ref the renumber table in
  `docs/follow-ups/audits/04-rls-security.md` near its tail).
- `pnpm smoke:cross-tenant` is green on main and hardened (PR #34, commit `5d50dd55`):
  RLS-helper EXECUTE probe + a browser-path RLS read probe over
  `{inbox_notifications, bookings, tickets}`, with regression fire on
  `status !== 200 OR body has 'permission denied for function' OR JSON code === '42501'`.
  Healthy baseline is `200 []` (browser JWT carries no `tenant_id` claim →
  `current_tenant_id()` = NULL → 0 rows; this is documented + correct).
- Prod API (`https://xpqt-api-eu.onrender.com`, NestJS global prefix `/api`) deploys
  green now via GH Actions (`RENDER_API_KEY` secret rotated 2026-05-20). Verified e2e:
  `/api/health` 200, `/api/me/inbox` 200 (real items), `/api/me/inbox/count` 200.
- The CLAUDE.md (root) + `docs/smoke-gates.md` + `docs/visibility.md` + `docs/assignments-routing-fulfillment.md` are the living-contract docs — keep them in sync in the same PR
  as any change that affects them.

Re-verify before acting: `git fetch origin main && git rev-parse origin/main`,
`gh pr list --state open` (scan for *owned* overlapping work — see Rule 1 below).

## Residuals to drive to best-in-class

### R1 (P1, real bug) — `/api/persons/me` returns HTTP 500 `unknown.server_error`

**Evidence:** With a real authenticated browser JWT (minted via the
`apps/api/scripts/smoke-cross-tenant.mjs` `mintTokenFor` pattern; admin user
`93d41232-35b5-424c-b215-bb5d55a2dfd9`), `GET https://xpqt-api-eu.onrender.com/api/persons/me`
→ `HTTP 500 {"code":"unknown.server_error","title":"Something went wrong on our end","status":500,"traceId":"req_ca149710ef2e4234ac8105ddb83a919f"}`.
The SAME token reaches `/api/me/inbox*` cleanly through the full auth+RLS stack (200 with
real items), so it is NOT an auth/RLS/deploy problem — it is an **unwrapped throw inside
the persons-me controller path** (per the AppError spec, `unknown.server_error` means a
non-`AppError` was thrown, hence the generic catch-all envelope).

**Do:** Locate the controller (`apps/api/src/modules/persons/**`,
`apps/api/src/modules/me/**`, or wherever `GET /persons/me` is defined). Reproduce
locally with a minted browser token against `API_BASE=http://localhost:3001` (build +
run the API on an alt port 3015-3025; NEVER 3001/3010 — other sessions). Capture the
raw exception. Fix per the error-handling spec
([`docs/superpowers/specs/2026-05-02-error-handling-system-design.md`](../docs/superpowers/specs/2026-05-02-error-handling-system-design.md)):
throw an `AppError` factory with a registered code in
`packages/shared/src/error-codes.ts` + English message in `messages.en.ts`; never
`throw new Error(...)`. Add a regression test (Jest in `apps/api`) covering the failure
mode. Add an assertion to `apps/api/scripts/smoke-cross-tenant.mjs` (or the appropriate
gate) that `/api/persons/me` returns 200 with a JSON body for an authenticated browser
session — so this can't silently return. Run `pnpm -C apps/api lint` +
`pnpm errors:check-app-errors` + the smoke gate ≥2× green.

### R2 (P2, real bug-class sweep) — other prod endpoints throwing raw Error

**Evidence:** R1 is one instance of `unknown.server_error`. The error spec says only
*migrated* modules are gated by `pnpm errors:check-app-errors` (currently 35 modules,
0 raw throws). Modules outside that list can still throw raw — the catch-all in the
global filter masks them as `unknown.server_error`.

**Do:** Enumerate every controller route reachable under `/api/*` (Nest's
`@nestjs/core` provides a Router introspection; or `grep -nE '@(Get|Post|Put|Patch|Delete)\\(' apps/api/src/**/*.controller.ts`).
For each, classify whether its module is in the migrated set (`grep -l 'AppError' apps/api/src/modules/<m>`).
For non-migrated modules with any `throw new Error(...)`, `throw <string>`, or
`throw <unknown>` inside the request path: either migrate the module to AppError (add
codes, messages, factories) OR explicitly document why a particular site is left raw
and add a follow-up. Don't trust the gate's "35 modules clean" as evidence the WHOLE
API is clean. Update the spec + the gate's covered-module list as you go (same PR).

### R3 (P2, gate hardening) — codex nit on PR #34 smoke probe message precision

**Evidence:** codex MERGE-with-nit verdict on `5d50dd55`: in the browser-path RLS read
probe, the regression check labels ANY non-200 as an "RLS-helper EXECUTE regression"
even if the body is an unrelated auth/network/PostgREST failure (e.g., expired token,
504 from cold start, PostgREST 4xx unrelated to function permissions). Fail-closed is
fine; message accuracy is not. The same PR's incident ledger explicitly *acknowledges*
this as accepted — but best-in-class is to distinguish.

**Do:** In `apps/api/scripts/smoke-cross-tenant.mjs`'s new probe loop (around the
`for (const tbl of [...])` block; the `regression` boolean computation): split the
failure-attribution into three named classes — (a) 42501 / RLS-helper EXECUTE regression
(the substring + `code:'42501'` checks), (b) PostgREST 4xx unrelated to RLS-helpers
(parse body for `.code` not equal to `42501`, surface that code), (c) transport / 5xx /
non-JSON — print a precise reason per class. Keep the fail-closed binary outcome; just
label correctly. Update the docstring + the `docs/smoke-gates.md` description.

### R4 (P2, gate coverage) — Realtime channel path not exercised end-to-end

**Evidence:** The May-19 outage hit "every browser/**Realtime** RLS read." The
current probe covers the REST (PostgREST) path only — `pnpm smoke:cross-tenant`'s
browser-path probe + the static helper-EXECUTE grant probe + `tickets_distinct_tags`
foreign-tenant leak probe. Documented as a known acceptable limitation in the ledger
(Scope-of-this-probe bullet). Realtime exercises a different execution context
(`realtime.list_changes` / per-subscriber RLS policy eval).

**Do:** Add a Realtime channel probe to `apps/api/scripts/smoke-cross-tenant.mjs`:
under the same minted browser token, open a Supabase Realtime channel for a
publication-included table (`inbox_notifications` is published per
`supabase/migrations/...notifications_realtime_publication...`), subscribe, INSERT a
fixture row via the service-role client to trigger a CDC event, await the event
arrival (with a bounded timeout, e.g. 8s), and assert receipt. Failure surfaces
as a Realtime-leg regression (separate failure label from the REST-leg probe). Wire
into the standard `pnpm smoke:cross-tenant` run. Use per-run isolated fixture rows
(unique UUIDs) + `finally` teardown — this hits the shared remote DB. Update the
ledger's "Scope of this probe" bullet to reflect that Realtime is now covered.

### R5 (P3, polish) — prod e2e verification script in the repo

**Evidence:** Verifying the May-20 deploy required writing a transient
`_prod-e2e-verify.mjs` outside the smoke-gate set (was deleted after one-shot use).
A reusable prod e2e gate would catch regressions in prod (cold-start failures, auth
breakage, deploy that built but broke runtime) faster than waiting for user reports.

**Do:** Add `apps/api/scripts/smoke-prod-e2e.mjs` + a `pnpm smoke:prod-e2e` script.
Default `PROD_BASE=https://xpqt-api-eu.onrender.com`. Probes: `/api/health` (no auth,
200 + `{status:"ok"}`); minted browser token + `/api/me/inbox` 200 with JSON body;
`/api/me/inbox/count` 200; `/api/persons/me` 200 (after R1 ships). Document in
`docs/smoke-gates.md` + the `## Smoke gates` section in root CLAUDE.md. Optionally
add to `.github/workflows/deploy.yml` as a post-deploy smoke step that runs after
the Render `live` confirmation and fails the workflow if any probe fails — that
closes the gap that let a 500-on-persons/me sit invisible.

## Execution rules — these bit prior agents; follow them

1. **Owned-PR check BEFORE opening any PR or briefing a subagent that opens one.**
   `gh pr list --state open` + `git branch -a` + grep for keywords in branch subjects.
   If overlapping owned work exists, your job becomes "stack on top" or route to that
   owner — never a competing duplicate PR. (PR #33 on 2026-05-19 duplicated owned #32
   on the same files; wasted work + cross-session collision risk.)
2. **Cross-session shared tree.** Operate in isolated worktrees off CURRENT
   `origin/main`. Re-verify `git rev-parse origin/main` before every merge — concurrent
   sessions move it. File-scoped explicit-pathspec commits ONLY
   (`git add <paths>`; never bare `git add -A` / `git commit`).
3. **DB pushes are deploy-class — confirm with the user every time.** `pnpm db:push`
   may be broken; psql fallback is in CLAUDE.md. Don't push migrations without
   authorization for the specific scope. None of R1–R5 requires a migration.
4. **Verify every security/behavioral claim against committed HEAD + live remote** —
   never the working tree alone, never a reviewer's prose. Re-run gates yourself; don't
   trust a subagent's "it passes."
5. **Review loop on substantive slices:** `/full-review` (2 adversarial Agent
   subagents) → fold REAL findings (verify every CRITICAL against actual code; loud
   reviewers are wrong sometimes) → codex tertiary (`codex exec --full-auto -C
   /Users/x/Desktop/XPQT`, prompt-to-file + short ARGV) → push → smoke ≥2× → ledger →
   commit. R1, R3, R4, R5 are security-gate-adjacent — codex tertiary is warranted.
6. **Runnable-guards mandate.** Every guard / CI check / verification snippet you
   write must be runnable against current main and verified passing before the PR
   ships. No paper tigers; no hypothetical regex; no invented paths. The May-19
   outage shipped because a probe asserted the catastrophic state — don't repeat it.
7. **Brutal honesty.** State what's proven by RUNNING vs by inspection vs by
   deterministic logic. No "merged & verified" without re-verifying after every
   concurrent merge. No claiming "best-in-class" until the live gate is green on the
   CURRENT post-merge `origin/main`.
8. **Living-contract docs in the SAME PR** as the code change that affects them
   (root `CLAUDE.md` `## Smoke gates`, `docs/smoke-gates.md`, `docs/visibility.md`,
   `docs/assignments-routing-fulfillment.md`, the audit-04 ledger).

## Do NOT touch — documented owned by other sessions

- **`scripts/check-migration-prefixes.sh` exit-0 bug** (detects dup migration prefixes
  but exits 0 → CI doesn't block). Owned by `fix/ci-migration-prefixes` branch (another
  session). Flag in your final report; do not absorb unilaterally.
- **The broader migration-prefix collision epidemic** beyond the audit-04 trio
  (00400/00406/00407/00410, 00367-00376 etc.). Same owner; same rule.
- **PR #27** (`feature/booking-audit-remediation`). Codex-verified 2026-05-19 to carry
  un-landed audit02/03 work; left OPEN with a recommendation comment. Owners must
  extract before close. Don't close it; don't merge it.
- **The broad browser RPC-EXECUTE surface and SECURITY INVOKER reads.** Documented as
  tracked-P2/P3 posture; **NEVER re-attempt a schema-wide `REVOKE EXECUTE`** — it
  breaks RLS (the May-19 outage's exact cause). Lock individual proven SECURITY
  DEFINER leaks per-function only.
- **`.env`-side Render credentials.** RENDER_API_KEY lives ONLY in GH Actions secrets,
  never `.env`. (See memory `project_render_deploy_blocked`.)

## Definition of done

- R1: `/api/persons/me` returns 200 with the expected JSON body for an authenticated
  browser session; an `AppError` factory + code + message replaces the unwrapped
  throw; a regression test in `apps/api` + a probe in `smoke-cross-tenant.mjs` (or
  the new prod-e2e gate from R5) hard-asserts it; PR merged; live verified on prod
  AFTER your merge deploys.
- R2: every reachable `/api/*` controller either is in the AppError-migrated set or
  has its raw-throw sites either migrated or explicitly documented as deferred (with
  owner + reason). The gate's covered-module list updated. PR merged.
- R3: smoke-probe failure messages distinguish the three classes; ledger + docs
  reflect the precision; gate ≥2× green; codex tertiary clean. PR merged.
- R4: Realtime-path probe added + green ≥2× under the standard
  `pnpm smoke:cross-tenant` run; per-run fixtures + teardown; ledger Scope-of-probe
  bullet updated; codex tertiary clean. PR merged.
- R5: `pnpm smoke:prod-e2e` gate exists + green; documented in CLAUDE.md +
  `docs/smoke-gates.md`; optionally wired into deploy.yml as a post-deploy step. PR
  merged.
- All five PRs: green on `origin/main` AFTER your merges (re-verify), no carve-outs
  without explicit evidence, no fake green, living-contract docs in sync.
- Final response: closed items with PR links + commit SHAs; explicit deferrals with
  owner + risk for anything not absorbed; honest proven-vs-assumed split. No
  AI/Claude attribution in commits or PR bodies (repo rule).
