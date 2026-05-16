# RLS / Security Audit — Continuation Handoff (2026-05-16)

You are the continuing lead agent for the RLS / tenant-isolation / least-privilege
remediation tracked in `docs/follow-ups/audits/04-rls-security.md`. Slices 1–10 and
Slice 11.1+11.2 are shipped and verified. Drive the rest to **best-in-class** and
**fully done**. Work autonomously; do not ask the user direction questions (ask
codex — see Execution Rules). The user has granted standing DB-push authority for
this workstream and explicitly wants the full-review→codex cycle on every big step.

## Mission / completion bar

Every admin/config controller mutation is gated by `@RequirePermission('<catalog
key>')` (the codebase-native, CI-enforced model) — NOT blanket `@UseGuards(
AdminGuard)`. `AdminGuard` is removed, OR every remaining caller is a genuinely
admin-only surface with a written rationale in the audit ledger. A non-admin role
granted a specific key actually works (proven by a live smoke probe). `/full-review`
+ codex both clean on the whole of Slice 11. The append-only audit ledger is current
and templated. The P4 (browser-direct PostgREST / Supabase Storage RLS) finding is
investigated and logged even if a fix is deferred.

## State (verified, committed) — branch `feature/booking-audit-remediation`

Run `git log --oneline -20` and confirm these are reachable (the branch changed
twice mid-session; history is linear, nothing lost — verify with
`git merge-base --is-ancestor <hash> HEAD`).

- Slices 1–8: cross-tenant `X-Tenant-Id` header-flip P0 closed (global AuthGuard
  `auth_uid→public.users` bridge, `status='active'`), Slice-2 AdminGuard on 10
  admin controllers, `smoke:cross-tenant` gate, `docs/visibility.md` §8 (RLS-as-
  perimeter posture), migration `00405` (tenants deny-by-default RLS) **on remote**,
  SECURITY DEFINER long-tail audited (no findings), Slice 4 (ticket_visibility_ids
  null-location) **deferred-contested** + Slice 8 (composite FK) **deferred to the
  data-model audit** — both with rationale in the ledger.
- Slice 9 `50b6dc72`: user-management same-tenant privilege-escalation P0 closed
  (was: any active user could `POST /role-assignments` to self-grant Admin) +
  AdminGuard validity hardened (now mirrors `user_has_permission` 00109:70-73 —
  `roles.active` + `starts_at`/`ends_at` time bounds).
- Slice 10 `552e2db2`: 9 more unguarded admin-mutation controllers AdminGuarded.
- `/full-review` follow-up `98821956`: I3 orphaned-role fail-closed spec; C1/P3/P4
  logged.
- Slice 11.1 `988d6452`: `@RequirePermission` primitive
  (`apps/api/src/common/require-permission.decorator.ts` + `.guard.spec.ts`, 5/5) +
  3 catalog domains (`business_hours`/`catalog_menus`/`delegations`) +
  `EXPLICITLY_NO_DEFAULT_ROLE` entries. CI catalog-coverage green.
- Slice 11.2 `b4577f20`: the 9 Slice-10 controllers re-gated
  `@UseGuards(AdminGuard)` → `@RequirePermission('<key>')`; 9 modules wired.
- Ledger update committed after each.

Last full verification (all green): `tsc` clean · `require-permission.guard` 5/5 ·
`admin.guard.spec` 9/9 · `permission-catalog` 13/13 · `smoke:cross-tenant` 22/22 ·
`smoke:work-orders` 109/109.

## Remaining work (in priority order)

### Slice 11.3 — re-gate Slice-2 + Slice-9 controllers (consistency completion)
The CRITICAL is "inconsistent coarse model". Leaving these on AdminGuard keeps the
split. Re-gate, same proven pattern as 11.2:

- Slice-2: `routing/routing.controller.ts`, `routing/policies.controller.ts`,
  `routing/space-groups.controller.ts`, `routing/domains.controller.ts`,
  `routing/location-teams.controller.ts`, `routing/domain-parents.controller.ts`,
  `workflow/workflow.controller.ts`, `sla/sla-policy.controller.ts`,
  `webhook/webhook-admin.controller.ts`, `config-engine/config-entity.controller.ts`.
- Slice-9: `user-management/user-management.controller.ts` — `UsersController`,
  `RolesController`, `RoleAssignmentsController`, `PersonsAdminController`
  (only the mutations that currently carry `@UseGuards(AdminGuard)`; the
  operational GETs stay open exactly as today — re-read the controller, do not
  widen scope).

Keys (verify each against `packages/shared/src/permissions.ts` — extract domains
with the awk in the session, or read the file): `routing.*` (create/update/delete/
publish/rollback/simulate), `workflows.*`, `sla.*` (sla-policy → `sla.create/update`),
`users.*` (`users.create/update`), `roles.*` (`roles.create/update`,
`roles.assign` for RoleAssignmentsController, `roles.delete` for delete),
`people.*` for PersonsAdmin (`people.create/update`), `routing.*` for
config-entity (it's the routing policy store) — **verify the right domain per
controller by reading what it mutates; do not guess**. `webhook-admin` has **no
`webhooks` catalog domain** — add one (`webhooks.read/create/update/delete/
rotate_key`) the same way 11.1 added the 3 domains (+ `EXPLICITLY_NO_DEFAULT_ROLE`
entries with reasons; `pnpm --filter @prequest/shared run build` after).

After 11.3: `grep -rn "AdminGuard" apps/api/src --include=*.ts | grep -v spec`.
Remaining callers (branding, portal-announcements, portal-appearance,
visitors/admin, floor-plan-admin) were NOT in the original audit scope. Decide
per-controller: re-gate to `@RequirePermission` for full consistency (preferred,
best-in-class) OR keep AdminGuard with a written "genuinely admin-only because X"
rationale in the ledger. If zero non-justified callers remain, AdminGuard can stay
as a primitive (it's still used) — do not delete it unless truly unreferenced.

### Slice 11.2b — proof probe + mapping table (codex risk #2)
In `apps/api/scripts/smoke-cross-tenant.mjs`: seed (via the existing psql-seed
pattern) a non-admin role holding exactly one key (e.g. `spaces.create`) + a
TENANT_A user with that role and an `auth_uid`; `mintTokenFor(authUid)` (already
generalized); assert `POST /spaces` is **NOT 403** (2xx, or 400-on-body — either
proves the permission guard passed where AdminGuard would have 403'd). This is the
proof the re-gate delivers what AdminGuard structurally could not. Clean up the
seeded role/user in a `finally`/defensive psql delete (mirror the existing
team_members / role-assignment cleanups). Add an endpoint→permission-key mapping
table to the audit ledger (or a doc) + a jest test asserting each
`@RequirePermission` route resolves the expected key (codex: "unit tests that
assert every decorated mutation calls the expected permission key").

### Then: `/full-review` + codex on the whole of Slice 11
Two adversarial subagents (plan + code) scoped to the Slice-11 commits
(`988d6452..HEAD` minus unrelated parallel workstream commits). Fix findings.
Then codex (stdin invocation below). Iterate until clean.

### Open, lower priority (log in ledger; investigate, fix-or-defer with rationale)
- **P4 (highest unaudited surface):** does the web app hold a Supabase client with
  an anon/auth key that can directly `from('team_members').insert()` /
  `from('user_role_assignments').insert()`? RLS on those tables is tenant-scoped
  NOT permission-scoped (`docs/visibility.md` §8) — if reachable, that's the same
  escalation Slice 9/10/11 closed at HTTP, still open at the data layer. Plus the
  known avatar/Storage cross-tenant gap. Investigate (read `apps/web` Supabase
  client usage + RLS policies on the escalation-class tables) and log a finding.
- Global `ValidationPipe` gap: `apps/api/src/main.ts` has no `useGlobalPipes`;
  DTOs are plain interfaces. Separate API-hardening backlog item — log it, don't
  necessarily fix in this workstream.
- GET info-disclosure (full user/role/team/vendor/space roster readable by any
  active same-tenant user): sequence behind 11.3; produce scoped read keys
  (e.g. `teams.read` picker projection) or a ledger-documented accept-with-reason.

## Execution rules (non-negotiable)

1. **Audit doc is APPEND-ONLY.** Never rewrite original findings or existing
   ledger rows / Update blocks. Append a `#### Update — YYYY-MM-DD` block
   (template: `Original finding` + `Location: file:line` + `Status:` closed/
   partial/blocked/deferred/contested + `Changed:` + `Verified:` (command→pass/
   fail or "Not run — reason") + `Remaining:`) immediately before
   `## Agent Handoff Prompt` in `docs/follow-ups/audits/04-rls-security.md`. Chat
   summaries are NOT closure — the audit file is the record of truth. Update the
   ledger after every slice in the same change.
2. **Autonomous.** Don't ask the user direction questions. For complex direction
   (A-vs-B, scope-shape) ask **codex**, attach your reasoning, let it decide.
   Only ask the user for genuine authorizations beyond the standing DB-push grant
   or destructive ops.
3. **codex invocation (the new CLI reads PROMPT from STDIN):**
   `codex exec -s read-only -C /Users/x/Desktop/XPQT < /tmp/codex-<slug>.md`
   — pipe via stdin, NOT as an ARGV arg (ARGV hangs: "Reading additional input
   from stdin..."). Do NOT use `--full-auto` (deprecated; was the prior hang).
   Run in background (`run_in_background`), do not poll, act on the notification.
4. **full-review→codex per big step.** Each big slice: spawn the two adversarial
   subagents (plan + code, parallel), fix critical+important findings (autonomous —
   don't ask, just fix and re-verify), then codex as the independent second
   reviewer. Iterate until clean.
5. **DB push:** standing authority for THIS workstream. `pnpm db:push` is broken;
   use `PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" psql
   "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres"
   -v ON_ERROR_STOP=1 -f supabase/migrations/<file>.sql` then verify with a
   query. Confirm only destructive ops.
6. **Migration numbers:** `ls supabase/migrations/ | tail -5` immediately before
   authoring; auto-rebase to next free. A PARALLEL workstream
   (`docs/follow-ups/audits/03-booking-reservation.md`) is consuming numbers
   (00406/00407 taken). Stay in 04-rls scope; do not touch 03-booking files;
   coordinate only on migration-number collisions.
7. **Smoke gates:** dev server runs at `http://localhost:3001` (prefix `/api`),
   auto-recompiles. Exit 1 = real probe regression; **exit 2 = thrown/
   connectivity** (the recurring dev-server recompile race after large multi-file
   edits — re-run after ~6–12s settle, NOT a regression). `smoke:edit-booking` /
   `smoke:edit-booking-scope` were pre-existing broken EARLIER but the parallel
   03-booking workstream is fixing the `actor_not_found` D-1 cause — do NOT treat
   their state as your regression; only `smoke:cross-tenant` + `smoke:work-orders`
   are your gates.
8. **Module DI is runtime, not tsc.** A controller using `@RequirePermission`
   needs `PermissionGuard` + `PermissionMetadataGuard` in its module `providers`
   (or a module that exports them). `tsc` will NOT catch a missing provider —
   NestJS 500s at request time. After every re-gate: verify module providers,
   then run `smoke:cross-tenant` (a 500 where the probe expects 403 catches it).
   A linter/user reverted one module mid-session — re-grep module state after
   edits (`grep -c PermissionMetadataGuard <module>`).

## The proven pattern (per controller / module)

Controller: replace each `@UseGuards(AdminGuard)` with
`@RequirePermission('domain.action')`; swap import
`{ AdminGuard } from '../auth/admin.guard'` → `{ RequirePermission } from
'../../common/require-permission.decorator'`; drop `UseGuards` from the
`@nestjs/common` import IF now unused (keep `UseInterceptors` etc.). Leave
operational GETs and self-service/read-shaped POSTs (e.g. notification
`:id/read`, `catalog-menus/resolve`) untouched — re-read the controller, do not
widen scope. Module: if AdminGuard is now fully unused there, drop
`imports:[AuthModule]`; add `PermissionGuard, PermissionMetadataGuard` to
`providers`. If the module still hosts an AdminGuard'd controller, KEEP AuthModule
AND add the two providers (see `config-engine.module.ts` for the mixed case).
Perl one-liners worked well for the decorator swaps (positional, anchored on the
method name following `@UseGuards(AdminGuard)`).

## Read first

- `docs/follow-ups/audits/04-rls-security.md` (esp. "Closure Updates" + "NEW
  FINDINGS" + the 2026-05-16 blocks — the full design rationale + codex decision)
- `apps/api/src/common/require-permission.decorator.ts` (the primitive) +
  `apps/api/src/common/permission-guard.ts` (canonical path it delegates to)
- `apps/api/src/modules/config-engine/criteria-set.controller.ts` (sibling
  in-body pattern reference) + `config-engine.module.ts` (mixed-module DI example)
- `packages/shared/src/permissions.ts` (`PERMISSION_CATALOG`) +
  `packages/shared/src/role-defaults.ts` (`EXPLICITLY_NO_DEFAULT_ROLE` contract)
- `apps/api/scripts/smoke-cross-tenant.mjs` (fixtures + the mintTokenFor pattern)
- `apps/api/src/common/permission-catalog*.spec.ts` (the CI coverage gate)
- AGENTS.md / CLAUDE.md; auto-memory entries: `feedback_db_push_rls_audit`,
  `feedback_codex_long_argv_hang`, `feedback_ask_codex_not_user_for_direction`,
  `feedback_review_loop_protocol`, `feedback_migration_number_collision`,
  `feedback_orchestrator_pattern_for_big_tasks`, `project_rls_security_audit_shipped`.

## Verification suite (run before claiming any slice done)

```
pnpm --filter @prequest/shared run build          # if permissions.ts/role-defaults changed
pnpm --filter @prequest/api run lint              # tsc
pnpm --filter @prequest/api test -- "require-permission.guard|admin.guard.spec|permission-catalog"
pnpm smoke:cross-tenant                            # runtime DI + deny-path + cross-tenant
pnpm smoke:work-orders                             # regression (space/team/vendor/asset feed WO)
```

Orchestrator discipline: this is a 40+ commit multi-session workstream — delegate
inventory/investigation to Explore subagents; do auth changes serially in the main
thread (NEVER parallel agents for overlapping auth changes); keep main context lean
(digest, not raw output). Commit per sub-slice with the
`feat/fix/docs(rls-security-slice-NN): …` convention; no Co-Authored-By.
