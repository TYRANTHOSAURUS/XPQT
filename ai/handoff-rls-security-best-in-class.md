# RLS / Tenant-Isolation Audit — Continuation Handoff to "best-in-class" (2026-05-18)

You are the continuing agent for the tenant-isolation / RLS / least-privilege
posture of XPQT. The **actionable** RLS audit (`docs/follow-ups/audits/04-rls-security.md`)
is CLOSED and SHIPPED to `main`. This handoff is for pushing the *overall*
posture from "actionable findings closed" to genuinely best-in-class. Most
remaining items were deliberately accepted/deferred with written rationale —
do NOT relitigate them blindly; read the ledger first, then decide per-item
whether the priority now justifies the work.

## State (verified, on `main`)

- RLS audit Slices 1–8 merged 2026-05-14. Slices 9–11.6 merged via **PR #17**
  (merge commit `2c5e8220`), ledger-closure via **PR #19**, both on `origin/main`.
- Every admin/config controller mutation is `@RequirePermission('<catalog key>')`
  on the canonical `public.user_has_permission` path. **Zero `@UseGuards(
  AdminGuard)` decorators** in non-spec code, enforced by a CI census test
  (`apps/api/src/modules/auth/admin-guard-permission-parity.spec.ts` — fails
  the build on any reintroduction).
- Verified pre-merge on the isolated branch: shared build clean, tsc fully
  clean (exit 0), RLS unit suite 151/151 (7 suites), committed census zero.
  Codex merge-gate: `VERDICT: MERGE`, zero critical/important. Live smoke
  `smoke:cross-tenant` 31/31 + `smoke:work-orders` 109/109 green on the
  byte-identical RLS code pre-isolation.
- The append-only ledger in `docs/follow-ups/audits/04-rls-security.md` is the
  complete record of truth — every slice, every /full-review + codex verdict,
  the honest-status block, the accept-with-reason, the false-green correction,
  and the merge-closure block.

## Remaining for best-in-class (priority order; each: what / why-open / best-in-class target / decision-or-labor)

### 1. RLS is not a real second perimeter — `DbService` superuser (P1, Slice 5.b) — DECISION
- **Why open:** `DbService` connects as the Supabase `postgres` superuser, so
  RLS is a runtime no-op for the entire API path; tenant isolation is 100%
  app-layer (AuthGuard bridge / `@RequirePermission` / service `.eq('tenant_id')`).
  Documented honestly in `docs/visibility.md` §8; the non-superuser role
  (`prequest_app` with explicit grants) was deferred as multi-day work for
  marginal gain *while `SupabaseService.admin` (service-role) also bypasses RLS*.
- **Best-in-class:** provision `prequest_app`, move the pool off `postgres`,
  grant least-privilege per table, so RLS becomes a genuine second perimeter
  that catches an app-layer regression. Requires deciding whether the
  service-role bypass is also addressed (else RLS still isn't a hard perimeter).
- **This is the single biggest "defense-in-depth" gap.** Multi-day; needs a
  decision (is true RLS-as-perimeter worth it vs. the documented app-layer
  model). Route the A/B to codex; the provisioning itself is labor.

### 2. 11.6(B) directory-read scoped projection (P2 info-disclosure) — DECISION (already made: accept)
- **Why open:** `GET /users`, `/roles`, `/users/:id`, and `PersonController`
  `GET /persons|/persons/:id` expose the full same-tenant directory to any
  authenticated user. The product owner **explicitly chose accept-with-reason**
  (same-tenant, non-escalating, load-bearing for non-admin operator pickers;
  revisit trigger documented in the ledger).
- **Best-in-class:** a scoped picker projection (minimal `id`/display-name/
  `active`) under an agent-held read key, so the full roster isn't exposed.
- **Do NOT re-implement unless the revisit trigger fires** (a need-to-know
  requirement, a "confidential persons" sub-class, etc.). The decision stands;
  this entry exists so the gap is visible, not so it's reopened.

### 3. Delete the caller-free `AdminGuard` primitive — LABOR (hygiene)
- **Why open:** `AdminGuard` has zero callers but still exists (`auth/
  admin.guard.ts`, exported by `AuthModule`, plus `admin.guard.spec.ts` and
  the parity-pin). Kept per the original "don't delete unless truly
  unreferenced" rule; CI-banned against reintroduction meanwhile.
- **Best-in-class:** delete `admin.guard.ts` + the `AuthModule` provider/
  export + `admin.guard.spec.ts`; collapse `admin-guard-permission-parity.spec`
  to just the census (the ⇔ parity half becomes moot once the class is gone).
  Verify nothing imports it (`git grep "from '.*auth/admin.guard'"`), tsc,
  full unit + `smoke:cross-tenant`. Pure labor, low risk, ~30 min.

### 4. Slice 4 — `ticket_visibility_ids` null-location (P1) — EVIDENCE-CLOSE
- **Why open:** the audit's original claim was contested on static analysis
  ("contested-deferred"; the outer domain check at `00035:63` gates the
  null-location branch; the proposed fix would break the documented "empty
  domain_scope = all domains" semantic). Status: "reopen only with a concrete
  failing visibility test."
- **Best-in-class:** write the jest visibility spec under
  `apps/api/src/modules/ticket/` that either (a) proves a real unintended
  visibility scenario (then fix consistent with the "empty = all" semantic)
  or (b) proves the contested-as-safe analysis correct and closes it with
  evidence instead of prose. Either way it stops being "contested" and
  becomes "resolved-with-test."

### 5. P3 backlog — out of RLS-remediation scope, other owners
- **Avatar Storage cross-tenant READ:** `portal-assets` is a public bucket;
  `{tenant_id}/avatar/{person_id}.{ext}` URLs are guessable cross-tenant
  (read-only metadata; no write, no escalation). Best-in-class: signed/
  expiring URLs or per-tenant prefixes + Storage RLS. Owner: GDPR/storage
  backlog (`project_people_and_users_surface_shipped`).
- **No global `ValidationPipe`:** `apps/api/src/main.ts` has no
  `useGlobalPipes`; DTOs are plain interfaces. Not a security gate for the
  permission work (gates are decorator/RPC-driven). Best-in-class:
  class-validator migration + global pipe. Owner: API-hardening backlog.

### 6. Slice 8 — composite `(tenant_id, id)` FK hardening — owned by the data-model audit
- The cleanest structural fix for the missed-tenant-filter class (a join
  that omits `eq('tenant_id')` attaches cross-tenant with no constraint
  violation). Owned by `docs/follow-ups/audits/01-data-model.md` (Agent 1
  P0-2), patterns already adopted on `00386`/`00387`. Name it here so the
  tenant-isolation end-state isn't considered complete without it, but do
  NOT duplicate that work in the RLS audit.

### 7. Verification-completeness nit
- Live smoke was not re-run against the exact merged `main` commit (RLS code
  byte-identical via cherry-pick; codex accepted; needs a dedicated dev
  server on `main`). If you want airtight "verified-on-main": check out
  `main`, `pnpm install`, run `pnpm dev:api`, then `pnpm smoke:cross-tenant`
  + `pnpm smoke:work-orders`. Low value (code unchanged) but it closes the
  one documented verification gap.

## Execution rules (proven this workstream — non-negotiable)

1. **Ledger is APPEND-ONLY.** New `#### Update — YYYY-MM-DD` block before
   `## Agent Handoff Prompt` in `docs/follow-ups/audits/04-rls-security.md`.
   Never rewrite prior blocks; later blocks supersede earlier ones.
2. **Verify against the COMMITTED tree, never the working tree.** Use
   `git grep <pat> HEAD` / `git show HEAD:<file>` for any closure/security
   claim — especially for files deliberately not staged. A working-tree grep
   green-lit a false "zero AdminGuard" for two sessions this workstream. See
   memory `feedback_verify_committed_not_working_tree`.
3. **Before excluding any dirty file as "parallel-workstream", `git diff
   HEAD -- <file>` and read it.** In-scope work hides in unstaged shared
   files (that's how the notification re-gate sat uncommitted 2 sessions).
4. **Shared branch:** `feature/booking-audit-remediation` is co-owned by a
   parallel 03-booking workstream. Stage explicit file lists, never `git
   add -A`. To ship RLS work independently, cherry-pick the RLS commits onto
   a clean branch off current `origin/main` in a throwaway `git worktree`
   (so the parallel workstream's uncommitted work is never touched) → push →
   PR → codex merge-gate → merge. `origin/main` advances under you (concurrent
   sessions) — re-verify base before proof/merge (memory
   `feedback_verify_branch_base_shared_tree`).
5. **codex via stdin, background:** `codex exec -s read-only -C
   /Users/x/Desktop/XPQT < /tmp/codex-x.md` (NOT `--full-auto`, NOT ARGV).
   Run in background, act on the notification, don't poll. Use it for the
   merge-gate and for direction-class A/B decisions; ask the *user* only for
   authorizations / intent / product calls.
6. **Migrations:** `ls supabase/migrations/ | tail -5` immediately before
   authoring; claim next-free; parallel workstreams consume numbers. DB-push
   standing authority via the psql fallback (`SUPABASE_DB_PASS` in `.env`);
   confirm only destructive ops. Additive backfills onto seeded roles mirror
   `00393`'s idempotent `pg_temp.merge_role_permissions`.
7. **Module DI is runtime, not tsc.** A `@RequirePermission` controller needs
   `PermissionGuard` + `PermissionMetadataGuard` in its module providers.
   tsc won't catch a missing provider — `smoke:cross-tenant` (403-not-500)
   will. Verify providers after every re-gate.
8. **/full-review then codex per big step.** Two adversarial subagents
   (plan + code, parallel) → fix critical+important → codex independent.

## Read first

- `docs/follow-ups/audits/04-rls-security.md` (the whole ledger, esp. the
  2026-05-16/17 blocks: the @RequirePermission design rationale, the
  endpoint→key mapping table, the honest-status block, the accept-with-reason,
  the false-green correction, the merge-closure block)
- `docs/visibility.md` §8 (RLS-as-perimeter posture — the DbService decision)
- `apps/api/src/common/require-permission.decorator.ts` + `permission-guard.ts`
- `apps/api/src/modules/auth/admin.guard.ts` +
  `admin-guard-permission-parity.spec.ts` (the census ban + parity pin)
- `apps/api/src/common/require-permission-routes.spec.ts` (the route→key pin)
- `packages/shared/src/permissions.ts` + `role-defaults.ts`
- `apps/api/scripts/smoke-cross-tenant.mjs` (the live gate + 11.2b proof
  pattern + the seed/teardown fixture pattern)
- memories: `project_rls_security_audit_shipped`,
  `feedback_verify_committed_not_working_tree`,
  `feedback_verify_branch_base_shared_tree`,
  `feedback_ask_codex_not_user_for_direction`, `feedback_review_loop_protocol`,
  `supabase_remote_push`

## Verification suite (run before claiming any item done)

```
pnpm --filter @prequest/shared run build          # if permissions.ts/role-defaults changed
pnpm --filter @prequest/api run lint              # tsc — must be exit 0
pnpm --filter @prequest/api test -- "permission-catalog|require-permission|admin.guard.spec|admin-guard-permission-parity"
pnpm smoke:cross-tenant                            # runtime DI + deny-path + the non-admin-WITH-permission proofs
pnpm smoke:work-orders                             # regression
git grep "@UseGuards([^)]*AdminGuard" HEAD -- apps/api/src | grep -v spec   # MUST be comments-only (zero real decorators)
```

Orchestrator discipline: delegate inventory/investigation to Explore
subagents; auth changes serially in the main thread; keep main context lean
(digest, not raw output); commit per sub-slice; update the ledger in the same
change. Don't declare "done" — state the precise residual every time
(this workstream was corrected for overclaiming "done" four times).
