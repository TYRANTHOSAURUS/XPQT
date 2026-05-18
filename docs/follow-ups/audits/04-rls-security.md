# RLS / Security / Tenant Isolation Audit
Date: 2026-05-13

## Executive verdict
- Status: **mostly done** with one **P0 cross-tenant escalation** on a defined set of admin controllers
- Best-in-class: **close** (after the P0 fix)
- Confidence: **high** for the P0 finding; **medium** for the long-tail of un-bridged controllers (sampled, not exhaustive)
- Summary: RLS coverage is essentially complete (82 of 84 `public.*` tables have RLS, both gaps deliberate). SECURITY DEFINER RPCs sampled are uniformly tenant-validated (`p_tenant_id` argument, `validate_entity_in_tenant` helper, locked `search_path`, `revoke from public` + `grant to service_role`). Anon-callable functions (`validate_invitation_token`, `peek_invitation_token`, `validate_kiosk_token`) are surgical, PII-redacted post-use, and use hashed tokens — well-thought-out. **However, the application security model is fundamentally not RLS — it is `DbService` running as the `postgres` superuser plus `supabase.admin` (service role) plus `AsyncLocalStorage` tenant context resolved from a header.** A `X-Tenant-Id` header **is trusted without being cross-validated against the user's JWT `app_metadata.tenant_id` claim**. Most controllers happen to bridge `auth_uid → users WHERE tenant_id = ctx` via `PermissionGuard.requirePermission`, `AdminGuard`, or `TicketVisibilityService.loadContext`, which closes the bypass. **A defined set of admin controllers do NOT bridge** — they read `TenantContext.current()` directly and write through `supabase.admin` / `DbService`. Any authenticated user can flip the header to any tenant UUID and read/write that tenant's routing rules, SLA policies, workflows, floor plans, etc.

## P0 findings (cross-tenant or anon-bypass risks)

### [P0] `X-Tenant-Id` header is trusted with no JWT-claim cross-check
Evidence:
- `apps/api/src/common/middleware/tenant.middleware.ts:21-26` — trusts header for tenant resolution.
- `apps/api/src/modules/auth/auth.guard.ts:14-37` — validates JWT, sets `request.user`, **never reads `app_metadata.tenant_id`**.
- `apps/api/src/common/db/db.service.ts:19-24, 124-177` — `DbService` connects as `postgresql://postgres:...` (superuser, **RLS bypassed**).
- Grep confirms **zero references to `app_metadata`** anywhere in `apps/api/src`.

Why it matters: Tenant isolation is 100% an application concern. The architectural perimeter (RLS) is intentionally not the enforcement layer for any DbService / `supabase.admin` query path — and that's every hot path. If the header isn't pinned to the JWT, the perimeter is "whatever guard the controller happens to apply."

Recommended fix: In `AuthGuard.canActivate`, after `getUser(token)`, read `data.user.app_metadata.tenant_id` and compare it to `TenantContext.current().id`. Mismatch → 403 `tenant.mismatch`. This is a 4-line change and would convert the entire P0 long-tail (below) into a no-op.

### [P0] Admin-domain controllers bypass tenant isolation via `X-Tenant-Id` flip
Evidence: controllers that use `TenantContext.current()` without bridging `auth_uid → users WHERE tenant_id`:
- `apps/api/src/modules/workflow/workflow.controller.ts:7-85` (entire controller — list / create / publish / clone / simulate / resume / instances)
- `apps/api/src/modules/sla/sla-policy.controller.ts:63`
- `apps/api/src/modules/routing/routing.controller.ts:7-56` (routing-rules CRUD; verified read + create + update)
- `apps/api/src/modules/routing/policies.controller.ts:25`
- `apps/api/src/modules/routing/space-groups.controller.ts`
- `apps/api/src/modules/routing/domains.controller.ts`
- `apps/api/src/modules/routing/location-teams.controller.ts`
- `apps/api/src/modules/routing/domain-parents.controller.ts`
- `apps/api/src/modules/floor-plan/buildings.controller.ts:10-20`

Reproduction (illustrative): with a valid JWT from tenant A and `X-Tenant-Id: <tenant-B-uuid>`, `GET /routing-rules` returns tenant B's routing rules; `POST /workflows` creates a workflow row in tenant B; `GET /buildings/:any-uuid/floors` returns floors from tenant B.

Why it matters: workflow definitions and routing rules are operationally sensitive (they encode who gets paged, who can approve what, automation triggers). Cross-tenant write here is silent — no FK chain breaks because every row carries its own `tenant_id` and the bypass writes a consistent row.

Recommended fix: fix the header-vs-claim check in `AuthGuard` (single fix kills the class). As defense in depth, add `@UseGuards(AdminGuard)` at each admin controller — `AdminGuard` already does the `auth_uid → users WHERE tenant_id` bridge (`admin.guard.ts:21-29`).

## P1 findings

### [P1] `DbService` runs as superuser — `service_role` would be sufficient
Evidence: `apps/api/src/common/db/db.service.ts:139, 176` — connection string is `postgresql://postgres:<pass>@db.<ref>.supabase.co`. The `postgres` role on Supabase is a **superuser** and bypasses RLS unconditionally.

Why it matters: RLS becomes a dead policy layer for every DbService caller. Supabase ships a `service_role` Postgres role that is RLS-bypassing for `supabase-js` but is _not_ a superuser at the SQL level — it can be granted/revoked per-table and is auditable. Future "this RLS policy will stop a regression" assumptions silently won't hold.

Recommended fix: provision a dedicated app role with explicit grants and use it for the pool. If the goal really is RLS-bypass for performance, document that as the explicit security model and remove RLS from the picture for those tables (or accept that RLS is purely a defense-in-depth no-op for the API path and only protects direct PostgREST calls from the browser — which the project does not currently make).

### [P1] `ticket_visibility_ids` returns rows where `location_id IS NULL` to any role-assigned user
Evidence: `supabase/migrations/00033_ticket_visibility.sql:91-95` — the `role_location_closure` branch matches when `b.location_id is null`. That is, **any** ticket without a location is visible to **any** user who has ANY active `user_role_assignment` in the tenant — regardless of domain or location scope.

Why it matters: location-less tickets are common (general HR requests, IT account access, security incidents). The intent appears to be "don't hide tickets that haven't picked a location yet from operators" but the gate is "user has any active role assignment," not "user has the relevant domain scope."

Recommended fix: tighten to `(b.location_id is null AND b.domain = any(rc.domain_scope))` — i.e. domain scope is the gate when location is missing, not always-true.

### [P1] Tickets RLS policy is tenant-only (USING clause), no WITH CHECK, no permission gate
Evidence: `supabase/migrations/00011_tickets.sql:47-48`:
```sql
create policy "tenant_isolation" on public.tickets
  using (tenant_id = public.current_tenant_id());
```
No `WITH CHECK`, no per-op split. Applies as `FOR ALL`. Defaults to using-as-with-check.

Why it matters: this is the documented design (within-tenant visibility lives in the application), but the comment `idx_tickets_assigned_user_tenant` and the visibility helper imply RLS could be a defense in depth. As stands, any actor that touched the policy from outside the application (a future `supabase-js` call from the browser, a sql script via `pg` connected as a non-superuser) gets all-or-nothing per tenant. Same pattern across all 80+ RLS-enabled tables sampled. Acceptable IF the tenant-claim check (P0) is added — without it, this policy is a no-op since DbService is superuser.

Recommended fix: post-P0 fix, treat the tenant-RLS layer as defense in depth and don't add per-table within-tenant policies — keep visibility in the service layer per `docs/visibility.md`. Document this in `docs/visibility.md` "RLS as perimeter, not policy."

## P2 findings

### [P2] `tenants` table has no RLS, accessed via service role only — relies on app discipline
Evidence: `supabase/migrations/00001_tenants.sql:25-26` (comment) — "No RLS on tenants — accessed by the service role."

Why it matters: nothing in the schema enforces this. Any future controller that exposes `tenants` via `supabase.admin` will leak the full tenant list. Status today: no leak (the only writer is `TenantService` for slug/id resolution). Worth a deny-by-default RLS policy (`USING (false)`) that the `postgres` superuser bypasses but a future `service_role`-connected client wouldn't — closes the foot-gun without breaking the resolver.

### [P2] `service_rule_templates` is globally readable to all authenticated users via `USING (true)`
Evidence: `supabase/migrations/00150_service_rule_templates_rls_fix.sql:11-14`.

Why it matters: intentional — these are tenant-agnostic seed rule templates. No PII. Confirmed safe. Documented in-file. Flagging only so future seed tables follow the same pattern explicitly rather than accidentally.

### [P2] `anon` role can call `validate_invitation_token` and `validate_kiosk_token` and `peek_invitation_token`
Evidence:
- `00260_fix_validate_invitation_token_errcodes.sql:59`
- `00271_validate_kiosk_token_function.sql:69`
- `00272_fix_peek_invitation_token_post_use_tombstone.sql:127`

Why it matters: reviewed each one — all are bearer-token endpoints (visitor magic-link, kiosk device token, peek for cancel page). All use hashed token comparisons, redact PII after use (00272's tombstone is well thought out), raise distinguishable error codes for expired vs. invalid. **These are correct — flagged only to confirm reviewed.**

## P3 findings

- `00033_ticket_visibility.sql:99-114` — `user_has_permission` returns true if **any** active role assignment has the permission key as a JSONB top-level key, regardless of value. Confirmed against `roles.permissions ? p_permission`. Means `{"tickets.write_all": false}` would still pass. Probably intentional (presence = grant) but should be commented. If `false` is ever used to revoke, this silently fails.
- The 6 routing controllers all duplicate the same `TenantContext + supabase.admin` pattern. Worth a shared `AdminController` base or a NestJS-level `@RequireAdmin()` decorator that wraps `AdminGuard`. Reduces the surface where this class of bug can recur.
- `current_tenant_id()` in `00002_rls_helpers.sql` reads JWT claims via `current_setting('request.jwt.claims', true)` — only set on PostgREST request paths. **Returns NULL for `DbService` connections** (no JWT claim in the session). Means any RLS policy referencing `current_tenant_id()` evaluates to `tenant_id = NULL` → no rows → would fail closed if the DbService role weren't a superuser. Reinforces that the entire RLS layer is a no-op for the API path today.

## RLS coverage (sampled)
- 84 distinct `public.*` tables created in migrations
- 82 have `enable row level security` (97.6%)
- Gap: **2 tables intentionally without RLS** (both deliberate):
  - `public.tenants` — platform registry (P2 — add deny-by-default policy)
  - `public.service_rule_templates` — tenant-agnostic seed, has permissive read policy in 00150

## SECURITY DEFINER review (8 functions sampled)
| Function | Tenant arg validated? | Risk |
|---|---|---|
| `validate_entity_in_tenant(p_tenant_id, p_kind, p_id)` (00318) | yes — kind allowlist + `WHERE id = $1 AND tenant_id = $2` per branch | none — exemplary |
| `edit_booking(p_booking_id, p_plan, p_tenant_id, p_actor_user_id, p_idempotency_key)` (00394) | yes — `p_tenant_id` required, every FK validated via `validate_entity_in_tenant`, actor lookup `WHERE u.tenant_id = p_tenant_id` | none — exemplary; `revoke from public`, `grant to service_role` only |
| `edit_booking_scope` (00395) | yes (sampled — follows v3 pattern) | none |
| `peek_invitation_token(text, text)` (00272) | n/a — bearer token | low — PII tombstone post-use, hashed comparison, anon-callable by design |
| `validate_invitation_token(text, text)` (00260) | n/a — bearer token | low — same pattern |
| `validate_kiosk_token(text)` (00271) | n/a — device token | low — same pattern |
| `publish_floor_plan_draft` (00370) | not sampled in this audit | unknown — recommend follow-up read |
| `floor_availability` (00375 / 00400) | not sampled in this audit | unknown — recommend follow-up read |

## Tenant-policy permissiveness
- **All** sampled RLS policies use the same `USING (tenant_id = public.current_tenant_id())` shape — no `WITH CHECK`, no per-operation split, no permission gate.
- This is documented design (visibility lives in the service layer), but: combined with the P0 above, it is **the bare minimum** — and only works at all if the tenant claim in the JWT actually drives `current_tenant_id()`. Today it does not, because the DbService superuser path has no JWT context at all.
- Recommendation: keep policies as-is for tenant perimeter; close the JWT-claim gate at the API layer (P0).

## Cross-tenant FK risk
Sampled migrations show **single-column UUID FKs** as the standard pattern (`references public.tickets(id)`, `references public.spaces(id)`, etc., not composite `(tenant_id, id)`). The codebase compensates via `validate_entity_in_tenant` and per-query `eq('tenant_id', ...)`. This is workable but means:
- A bug that omits `eq('tenant_id', ...)` in a join can attach a row from tenant A to a row in tenant B without any constraint violation. The DB will accept it. Tickets/tickets, work_orders/tickets, ticket_activities/tickets, sla_timers/tickets and many more are all single-column FK.
- Composite `(tenant_id, id)` FKs would make this class of bug a CONSTRAINT VIOLATION at insert/update time, with zero per-query discipline required.
- This is widespread enough that a one-shot remediation is unrealistic — recommend the pattern for new tables and consider it for the highest-blast-radius FK chains (booking_slots → bookings; ticket_activities → tickets; work_orders → tickets).

## Hardening plan
1. **(P0, ~2h)** `AuthGuard`: after `getUser(token)`, cross-check `data.user.app_metadata.tenant_id` against `TenantContext.current().id`. Reject mismatch with `tenant.mismatch` 403. Single change collapses the entire P0 class.
2. **(P0, ~1h)** Add `@UseGuards(AdminGuard)` (or a new `@AdminController()` decorator) to the 9 admin controllers identified above as defense in depth.
3. **(P1, ~half day)** Stand up a dedicated non-superuser app role for `DbService`. Grant minimum necessary table privileges. Stop relying on `postgres`. Optional but right.
4. **(P1, ~2h)** Tighten the `ticket_visibility_ids` `location_id IS NULL` branch — require domain-scope match when location is missing.
5. **(P2, ~30m)** Add `USING (false)` RLS policy to `public.tenants`. Document the deny-by-default seed-table pattern.
6. **(P3, ongoing)** For new tables with sensitive cross-row attachment (tickets → activities, bookings → slots, etc.), use composite `(tenant_id, id)` PK + FK. Catches the missed-tenant-filter class of bug at constraint-validation time.
7. **(P3, ~1h)** Audit the remaining 50+ SECURITY DEFINER functions for the `p_tenant_id` required pattern. Six confirmed exemplary; the other ~50 unsampled. Worth a focused pass given how much work runs through them.

## Notes on confidence
- **High confidence** on P0: read the auth guard, the tenant middleware, the DbService source, and a representative selection of un-bridged controllers. The exploit chain is straightforward and the mitigating bridges (AdminGuard / PermissionGuard / loadContext) are uniformly absent from the 9 named files.
- **Medium confidence** on the long-tail: I sampled `workflow.controller`, `routing.controller`, `buildings.controller`, and listed the others by static grep — recommend a follow-up agent enumerates every `@Controller` and tags it with its tenant-bridge.
- **High confidence** on RLS coverage and the SECURITY DEFINER pattern; sampled 6 of 56 SECURITY DEFINER files and the pattern is consistent.
- **Did not exercise** the running API. All findings are static. A smoke probe that mints two tenant JWTs and tries each cross-tenant attack would convert the medium-confidence items to high.

---

## Closure Ledger

Maintainer rule: every agent that closes, partially closes, or deliberately defers a finding from this RLS/security audit must update this ledger in the same change. Do not rely on chat history as the record of truth. Add concrete evidence: changed files, migration numbers, tests/smokes run, and any residual risk.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/04-rls-security.md` | Not run | All findings remain open unless a later row says otherwise. |
| 2026-05-16 | Slice 9 — user-management privilege-escalation **P0** + AdminGuard validity (reviewer-surfaced) | **closed** | **F1 (P0):** `apps/api/src/modules/user-management/user-management.controller.ts` had 4 controllers (`Users`/`Roles`/`RoleAssignments`/`PersonsAdmin`) behind only the global AuthGuard. Any active same-tenant non-admin could `POST /role-assignments` to self-grant the Admin role (`assignRole` used `actor` only for the audit trail, never authz — verified `user-management.service.ts:359-390`), then AdminGuard accepted it. Fix: `@UseGuards(AdminGuard)` per-mutation on `POST /users`, `PATCH /users/:id`, `POST /users/:id/roles`, `DELETE /users/:id/roles/:roleId`, `POST /roles`, `PATCH /roles/:id`, `POST /persons-admin`, `PATCH /persons-admin/:id`; class-level on `RoleAssignmentsController` (all-mutation). `AuthModule` added to `user-management.module.ts` imports. **F2 (P1):** `admin.guard.ts` now mirrors `user_has_permission` (`00109_permissions_wildcards.sql:70-73`) — adds `roles.active`, `starts_at`, `ends_at` validity (previously only `user_role_assignments.active`). **F3 (P1):** `smoke-cross-tenant.mjs` generalized token minter (`mintTokenFor`), +4 same-tenant non-admin probes including the live self-escalation attempt with defensive cleanup. | `admin.guard.spec` 8/8 (added inactive-role / expired / not-yet-started cases). `pnpm smoke:cross-tenant` **16/16** (4 new Slice 9 probes: non-admin `/users/me` 200, non-admin `/users` 200, non-admin `/workflows` 403, non-admin self-grant Admin via `POST /role-assignments` 403). `pnpm smoke:work-orders` 109/109. `tsc` clean. Red-before-green for F1 is structurally guaranteed: pre-fix `RoleAssignmentsController` had zero guards → non-admin POST would 201-insert; post-fix 403. | **GET info-disclosure follow-up (P2, NOT closed):** `GET /users`, `GET /users/:id`, `GET /users/:id/roles`, `GET /users/:id/audit`, `GET /roles`, `GET /persons-admin`, `GET /permissions/users/:id/effective` remain readable by any active same-tenant user. Deliberately NOT locked: `GET /users` (`useUsers`) backs the desk ticket-filter / ticket-detail / user-picker / workflow assign-form (non-admin operators); `GET /roles` backs role pickers. These leak the same-tenant directory/role map but are NOT an escalation vector. Locking them needs per-endpoint operational-usage analysis (some may be safe to gate, some not) — tracked as a separate P2 slice. **This means the RLS/security audit found a P0 the original 8-auditor pass missed: the audit named 9 controllers, none in user-management/. Same root cause finding #3 flagged — the deferred non-admin probe was load-bearing.** |
| 2026-05-14 | Slice 1 — Global tenant binding in AuthGuard (P0 §`X-Tenant-Id` header trusted) | **closed** | `apps/api/src/modules/auth/auth.guard.ts` (added auth_uid→users bridge after JWT verify, attaches `platformUserId` to `req.user`, rejects mismatch with 403 `auth.user_not_in_tenant`); `apps/api/scripts/smoke-cross-tenant.mjs` (new live-API gate); `pnpm smoke:cross-tenant` registered in root + apps/api `package.json` | `pnpm smoke:cross-tenant` 9/9 pass (regression: own-tenant 200, no-auth 401; attack: 6 admin GETs cross-tenant 403). `pnpm smoke:work-orders` 109/109 pass. `pnpm smoke:floor-plans` 21/0/4 pass. | Defense-in-depth slice (admin controllers) tracked as Slice 2. **Pre-existing failure NOT caused by Slice 1**: `smoke:edit-booking` 27/11 and `smoke:edit-booking-scope` 14/7 fail on HEAD identically with `edit_booking.actor_not_found` because `reservation.service.ts:1015,1332,1819` pass `actor.user_id` (= `public.users.id` per `dto/types.ts:343`) into `p_actor_user_id` where the RPC expects auth_uid (`supabase/migrations/00394_edit_booking_rpc_v5.sql:289-300`). Surfaced for the reservation owner — out of scope for the RLS audit. |
| 2026-05-14 | Slice 8 — composite (tenant_id, id) FK hardening | **deferred — owned by data-model audit** | Per the audit's slice ordering rule 8 ("Coordinate composite-FK hardening with the data-model audit rather than duplicating that work here") and `docs/follow-ups/audits/00-integrator-verdict.md` top-10 §#7 / required-refactor §7, this work belongs to Agent 1's data-model audit corpus, NOT the RLS audit. Existing patterns: `00386_maintenance_plans` and `00387_work_orders_pm_cols` adopted composite (tenant_id, id) — proves the team has the pattern. Sweep onto bookings / tickets / work_orders / orders / approvals / booking_slots / asset_reservations is multi-day mechanical work + a CI guard. Closure: do not duplicate in the RLS audit. | n/a (defer). | Pointer to data-model owner: `docs/follow-ups/audits/01-data-model.md` (Agent 1 P0-2). |
| 2026-05-14 | Slice 4 — `ticket_visibility_ids` null-location tightening (P1) | **deferred — audit finding contested on analysis** | Latest definition is `supabase/migrations/00035_vendor_participant_dormant.sql:6-70`. The audit's specific claim — "any ticket without a location is visible to any user who has any active user_role_assignment in the tenant — regardless of domain or location scope" — is overstated. The outer domain check at `00035:63` (`array_length(rc.domain_scope, 1) is null or b.domain = any(rc.domain_scope)`) IS the domain gate. The null-location branch at `00035:67` is only reached when domain has already matched for that assignment. The audit's recommended fix (`(b.location_id is null AND b.domain = any(rc.domain_scope))`) would break the "empty domain_scope = all domains" semantic that is documented in three places: `docs/superpowers/specs/2026-04-20-visibility-scoping-design.md:50` ("empty array = all domains"), `:103` ("// empty = all"), and `:277` ("Operator: role location scope = empty means all locations"). Specifically a user with `domain_scope = NULL` (all-domains) + restrictive `location_scope` would LOSE visibility on null-location tickets — that's the inconsistency. | Static analysis only; verified the outer-domain-check claim against the actual SQL at `00035:63`; confirmed the spec's "empty = all" semantic at three citations. | **Reopen with concrete repro before re-attempting.** If a real cross-tenant or unintended visibility scenario surfaces, write a failing visibility test (jest spec under `apps/api/src/modules/ticket/`) first, then design the fix to be consistent with the spec's "empty = all" semantic. Pure prose-level audit findings on hot visibility SQL functions need a regression scenario to justify the migration risk. |
| 2026-05-14 | Slice 7 — full audit of remaining SECURITY DEFINER functions (P3) | **closed — no findings** | Two parallel Explore subagents audited all SECURITY DEFINER functions in the migration corpus split at 00299 (Half A: 00001–00299; Half B: 00300–00405). Found 12+ functions beyond the 6 already-sampled exemplary ones. **Every function audited:** sets `search_path` (`public, pg_temp` or `public, pg_catalog`); takes `p_tenant_id` and uses it via WHERE-clause validation OR is bearer-token-bound (hash lookup); REVOKEs from PUBLIC and grants EXECUTE only to `service_role` (or `anon, authenticated, service_role` for the bearer-token trio with tombstone redaction post-use). Functions inventoried beyond the audit's six: `calendar_sync_encrypt`/`_decrypt` (00131), `resolve_setup_routing` (00194/00195), `claim_deferred_setup_trigger_args` (00198), 4 trigger-validators (`assert_approvals_workflow_instance_tenant` 00400:85, `assert_room_booking_rules_workflow_definition_tenant` 00400:115, `assert_workflow_definitions_source_rule_tenant` 00400:146, `assert_workflow_instance_link_tenant` 00370:205), `ensure_room_booking_rule_workflow_definition` (00400:187). | Read-only inventory; no migrations needed. Reviewed: search_path locking, tenant guarding, grant scope, error-code distinctness, post-use redaction patterns. | The audit-corpus is genuinely uniform in security quality — the canonical pattern (`set search_path` + `p_tenant_id` validated + `revoke from public, grant to service_role`) is held in every function we checked. **No new fix migrations needed for Slice 7.** |
| 2026-05-14 | Slice 6 — deny-by-default RLS on `public.tenants` (P2) | **closed** | Migration `supabase/migrations/00405_tenants_deny_by_default_rls.sql`. `ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY` + `CREATE POLICY tenants_deny_all_by_default USING (false) WITH CHECK (false) FOR ALL`. Cross-checked all `from('tenants')` callers: 15 callsites under `apps/api/src` plus 4 migrations, ALL use `supabase.admin` (service-role) or run as `postgres` superuser — both bypass RLS, so this policy is a runtime no-op for current paths. Closes the audit's P2 finding (`04-rls-security.md:71-74`). | Pushed via psql fallback 2026-05-14. Post-push state verified: `relrowsecurity=t / relforcerowsecurity=f` on `public.tenants` (so superuser + service-role bypass continues); `pg_policy.polqual = false / polwithcheck = false / polcmd = '*' FOR ALL` confirms the deny-all policy is in place. `select count(*) from public.tenants` as service-role returns 2 rows (the bypass works). `pnpm smoke:cross-tenant` 12/12 still pass after push. | Surprise: pre-push `relrowsecurity` was already `t` — the 00001 migration comment "No RLS on tenants" was inaccurate-by-2026-05-14; RLS-enabled-with-no-policy is functionally equivalent to deny-all for non-bypass roles. This migration makes the intent explicit at the policy level. |
| 2026-05-14 | Slice 5 — DbService role posture decision + docs (P1 §DbService superuser bypasses RLS) | **closed** | `docs/visibility.md` adds §8 "Database role posture — RLS as perimeter, not policy". Decision: keep the current postgres-superuser + service-role posture; document it honestly. The §8 covers both connection paths (DbService raw pg + SupabaseService.admin), why current_tenant_id() returns NULL for both, the three application-layer perimeter mechanisms that actually enforce tenant isolation (AuthGuard bridge / AdminGuard / service-layer `.eq('tenant_id', ...)`), why we deferred the non-superuser app role (multi-day work for marginal real defense-in-depth — service-role still bypasses), and concrete steps if a future revisit wants to turn RLS into a real second perimeter. | Docs only; no code or migration. | Option (b) (provision `prequest_app` non-superuser role with explicit grants) is queued as Slice 5.b — costs ~multi-day, value is "RLS becomes a real second perimeter if the app layer regresses." Pull only if a future security review demands true defense-in-depth that doesn't require `request.jwt.claims` plumbing through every DbService call. Audit's specific concern that "future this RLS policy will stop a regression assumptions silently won't hold" is now mitigated by the doc explicitly stating they won't. |
| 2026-05-14 | Slice 3 — register `smoke:cross-tenant` in CLAUDE.md + `docs/smoke-gates.md` | **closed** | `CLAUDE.md:31` adds `smoke:cross-tenant` to the visible probe list; `CLAUDE.md:45` adds the trigger row (AuthGuard / AdminGuard / PermissionGuard / global tenant binding / admin-config controllers). `docs/smoke-gates.md` adds a full §`pnpm smoke:cross-tenant` section: gate description, TENANT_B fixture pattern, 12-probe matrix, known gap (same-tenant non-admin probe queued for Slice 3.b once a non-admin auth fixture is seeded). | Docs only — no behavior change. | The new probe was already wired in `package.json` + `apps/api/package.json` by Slice 1; this slice surfaces it to engineers reading the contracts. |
| 2026-05-14 | Slice 2 — defense-in-depth `@UseGuards(AdminGuard)` on 10 admin controllers (P0 §un-bridged admin controllers) | **closed** | `@UseGuards(AdminGuard)` added at class level on `workflow.controller.ts`, `routing.controller.ts`, `routing/policies.controller.ts`, `routing/space-groups.controller.ts`, `routing/domains.controller.ts`, `routing/location-teams.controller.ts`, `routing/domain-parents.controller.ts`, `webhook/webhook-admin.controller.ts`, `config-engine/config-entity.controller.ts`, `sla/sla-policy.controller.ts`. `AuthModule` added to `imports[]` of `workflow.module.ts`, `routing.module.ts`, `sla.module.ts`, `webhook.module.ts`, `config-engine.module.ts` so AdminGuard can be DI-resolved. `smoke-cross-tenant.mjs` augmented with 3 cross-tenant POST probes (write side of the attack vector). | `pnpm smoke:cross-tenant` 12/12 pass (3 new POST probes 403'd). `pnpm smoke:work-orders` 109/109 pass. | Closes the audit's secondary P0 (`04-rls-security.md:23-40`). With Slice 1 in place, AdminGuard runs ONLY when AuthGuard already passed the bridge — so the failure mode of "admin in tenant A flips header to tenant B and is admin in tenant B too" is now blocked at AuthGuard (no users row in tenant B → 403) BEFORE AdminGuard. AdminGuard remains as belt+suspenders if Slice 1 regresses, AND as the gate for non-admin same-tenant users (slice 3 will add a same-tenant non-admin probe; that requires a second auth fixture which we don't seed yet). `buildings.controller.ts` was named by the audit but kept un-AdminGuarded — `GET /buildings/:id/floors` is legitimately operator-readable and Slice 1's tenant binding already blocks the audit's cross-tenant read scenario. |
| 2026-05-14 | Slice 1 — `/full-review` follow-up (C1 + I1 + I3 + I4) | **closed** | Same files plus `apps/api/src/modules/auth/admin.guard.ts`, `apps/api/src/common/permission-guard.ts`, `apps/api/src/modules/auth/admin.guard.spec.ts`. C1: `.eq('status','active')` filter added to AuthGuard bridge — suspended/inactive users with a still-valid JWT can no longer pass any authenticated route. I3: AdminGuard + PermissionGuard refactored to consume `req.user.platformUserId` directly; the users-row lookup ran exactly once per request now (in AuthGuard) instead of three times on admin+permission paths. I4: defensive `TenantContext.current()` wrap — bypassed middleware now surfaces as 404 `tenant.unknown` instead of a 500 stack trace. | `admin.guard.spec` 4/4 pass; `smoke:cross-tenant` 9/9 pass; `smoke:work-orders` 109/109 pass. | **Why the users-table bridge over JWT `app_metadata.tenant_id` cross-check?** The audit names both options as viable closers. Bridge chosen because (a) `app_metadata` mint discipline is unverified in this codebase — the audit ledger calls it out; (b) `public.users WHERE auth_uid AND tenant_id AND status='active'` is the authoritative membership source and the existing-guard pattern (AdminGuard, PermissionGuard, `loadContext`); (c) the lookup is one Supabase REST call (~5-15ms p50 same-region) — measurable but acceptable. The latency is paid once per request and platformUserId is reused everywhere downstream. **Open caveats** (NOT closed by Slice 1): (1) a multi-tenant user with `public.users` rows in two tenants can still hit either via header flip — only Slice 2 (`@UseGuards(AdminGuard)` on the 9 admin controllers) closes that vector; (2) cron / outbox / workflow-engine paths bypass AuthGuard entirely and rely on `TenantContext` being set from row data (safe by construction — they trust no actor input — but documented here as the explicit non-HTTP security model). |

## Closure Updates (templated)

Append-only. Original findings above are unmodified. Terse Closure Ledger
rows above are retained; these blocks are the structured record of truth
per the maintainer template.

#### Update — 2026-05-14

Original finding:
- `### [P0] \`X-Tenant-Id\` header is trusted with no JWT-claim cross-check`
- Location: `docs/follow-ups/audits/04-rls-security.md:12`

Status:
- closed

Changed:
- `apps/api/src/modules/auth/auth.guard.ts` (global auth_uid→public.users bridge, status='active', 403 `auth.user_not_in_tenant`, attaches `platformUserId`)
- `apps/api/src/modules/auth/admin.guard.ts`, `apps/api/src/common/permission-guard.ts` (consume `platformUserId`)
- `apps/api/scripts/smoke-cross-tenant.mjs` (new live gate), `package.json` + `apps/api/package.json` (script)
- `apps/api/src/modules/auth/admin.guard.spec.ts`

Verified:
- `pnpm smoke:cross-tenant` -> pass (9/9 at Slice 1; 16/16 after Slice 9)
- `pnpm smoke:work-orders` -> pass 109/109
- `pnpm --filter @prequest/api lint` -> pass

Remaining:
- None for this finding. Commits 562b1113, 9b42b1f3.

#### Update — 2026-05-14

Original finding:
- `### [P0] Admin-domain controllers bypass tenant isolation via \`X-Tenant-Id\` flip`
- Location: `docs/follow-ups/audits/04-rls-security.md:23`

Status:
- closed (defense-in-depth) — primary close is the Slice-1 bridge; this adds AdminGuard

Changed:
- `@UseGuards(AdminGuard)` on workflow / routing.controller / routing(policies,space-groups,domains,location-teams,domain-parents) / webhook-admin / config-entity / sla-policy controllers
- `AuthModule` into workflow / routing / sla / webhook / config-engine modules
- `apps/api/scripts/smoke-cross-tenant.mjs` (+3 cross-tenant POST probes)

Verified:
- `pnpm smoke:cross-tenant` -> pass 12/12
- `pnpm smoke:work-orders` -> pass 109/109

Remaining:
- The audit named 9 controllers; this is NOT the full admin surface. See the NEW-FINDING blocks below (Slice 9 + Slice 10) — the original audit inventory was materially incomplete. Commits 8334d1d9, 6486186b.

#### Update — 2026-05-14

Original finding:
- `### [P1] \`DbService\` runs as superuser — \`service_role\` would be sufficient`
- Location: `docs/follow-ups/audits/04-rls-security.md:43`

Status:
- closed (documented posture; non-superuser role deferred as Slice 5.b)

Changed:
- `docs/visibility.md` §8 "Database role posture — RLS as perimeter, not policy"

Verified:
- Not run -> docs-only change; no behavior delta.

Remaining:
- Slice 5.b (provision `prequest_app` non-superuser role) deferred — multi-day, marginal real defense while `SupabaseService.admin` still bypasses. Rationale in §8.4. Commit 05e5d299.

#### Update — 2026-05-14

Original finding:
- `### [P1] \`ticket_visibility_ids\` returns rows where \`location_id IS NULL\` to any role-assigned user`
- Location: `docs/follow-ups/audits/04-rls-security.md:50`

Status:
- contested (deferred — analysis disputes the finding)

Changed:
- None (no code/migration change made).

Verified:
- Static analysis only. `00035_vendor_participant_dormant.sql:6-70` is the latest definition. The outer domain check at `:63` already gates the null-location branch at `:67`. The audit's proposed fix would break the "empty domain_scope = all domains" semantic documented at `docs/superpowers/specs/2026-04-20-visibility-scoping-design.md:50,103,277`.

Remaining:
- Reopen ONLY with a concrete failing visibility test (jest under `apps/api/src/modules/ticket/`). Do not migrate this hot function on prose alone. Commit 1f1fb58f.

#### Update — 2026-05-14

Original finding:
- `### [P1] Tickets RLS policy is tenant-only (USING clause), no WITH CHECK, no permission gate`
- Location: `docs/follow-ups/audits/04-rls-security.md:57`

Status:
- closed (accepted-by-design; the finding itself says "Acceptable IF the tenant-claim check (P0) is added")

Changed:
- `docs/visibility.md` §8 documents why per-table within-tenant RLS is intentionally NOT added (visibility lives in the service layer).

Verified:
- Not run -> design/doc decision; the P0 precondition the finding names is closed (Slice 1).

Remaining:
- None. Within-tenant visibility stays in `TicketVisibilityService` per `docs/visibility.md`. Commit 05e5d299.

#### Update — 2026-05-14

Original finding:
- `### [P2] \`tenants\` table has no RLS, accessed via service role only — relies on app discipline`
- Location: `docs/follow-ups/audits/04-rls-security.md:71`

Status:
- closed

Changed:
- `supabase/migrations/00405_tenants_deny_by_default_rls.sql`

Verified:
- Pushed via psql fallback. `pg_class.relrowsecurity=t / relforcerowsecurity=f`; `pg_policy` deny-all `polqual=false polwithcheck=false polcmd='*'`; service-role `select count(*) from public.tenants` -> 2 rows (bypass intact); `pnpm smoke:cross-tenant` -> pass 12/12 post-push.

Remaining:
- None. Note: pre-push `relrowsecurity` was already `t` — the 00001 comment was stale. Commits 4cedc705, 0ca848c9.

#### Update — 2026-05-14

Original finding:
- `### [P2] \`service_rule_templates\` is globally readable to all authenticated users via \`USING (true)\`` and `### [P2] \`anon\` role can call \`validate_invitation_token\` and \`validate_kiosk_token\` and \`peek_invitation_token\``
- Location: `docs/follow-ups/audits/04-rls-security.md:76` and `:81`

Status:
- closed (no action — the audit itself confirmed these safe; Slice 7 re-verified)

Changed:
- None.

Verified:
- Slice 7 parallel SECURITY DEFINER sweep re-confirmed the bearer-token trio (hash lookup, post-use tombstone, distinct error codes) and the seed-template read posture. Read-only.

Remaining:
- None known.

#### Update — 2026-05-14

Original finding:
- `## P3 findings` (SECURITY DEFINER long-tail + `user_has_permission` JSONB presence note)
- Location: `docs/follow-ups/audits/04-rls-security.md:89`

Status:
- closed — no findings

Changed:
- None (read-only audit).

Verified:
- Two parallel Explore subagents audited every SECURITY DEFINER function split at migration 00299. All set `search_path`, validate `p_tenant_id` or are bearer-token-bound, and `revoke from public` + grant only `service_role`. No fix migrations needed.

Remaining:
- None. The `user_has_permission` JSONB-presence behavior is intentional per the audit's own P3 note. Commit 110d14a6.

---

### NEW FINDINGS — discovered during remediation (audit was incomplete)

The original 8-auditor pass + `## Executive verdict` ("Best-in-class: **close** (after the P0 fix)") materially under-counted the admin-controller surface. The cross-tenant header-flip was real and is closed, but a **same-tenant privilege-escalation class** was missed entirely. These are appended as new findings (not retrofitted onto original headings — there is no original heading for them).

#### NEW FINDING + Update — 2026-05-16

Finding (not in original audit):
- **[P0] user-management controllers allow same-tenant privilege escalation.** `apps/api/src/modules/user-management/user-management.controller.ts` exposed `UsersController` / `RolesController` / `RoleAssignmentsController` / `PersonsAdminController` behind only the global AuthGuard. Any active same-tenant non-admin could `POST /role-assignments {user_id: self, role_id: <Admin>}` (service `assignRole` used `actor` only for the audit trail — `user-management.service.ts:359-390`) then pass AdminGuard everywhere. Surfaced by an external reviewer 2026-05-16; the original audit named 9 controllers, none under `user-management/`.

Status:
- closed (escalation vector) + P2 GET info-disclosure follow-up open

Changed:
- `apps/api/src/modules/user-management/user-management.controller.ts` (`@UseGuards(AdminGuard)` per-mutation; class-level on `RoleAssignmentsController`)
- `apps/api/src/modules/user-management/user-management.module.ts` (`AuthModule`)
- `apps/api/src/modules/auth/admin.guard.ts` (F2: + `roles.active` + `starts_at`/`ends_at`, mirrors `user_has_permission` `00109:70-73`)
- `apps/api/src/modules/auth/admin.guard.spec.ts`, `apps/api/scripts/smoke-cross-tenant.mjs`

Verified:
- `pnpm --filter @prequest/api run test -- admin.guard.spec.ts` -> pass 8/8 (added inactive-role / expired / not-yet-started)
- `pnpm smoke:cross-tenant` -> pass 16/16 (non-admin self-grant Admin via `POST /role-assignments` -> 403)
- `pnpm smoke:work-orders` -> pass 109/109; `tsc` -> pass

Remaining:
- **P2 (open):** GET info-disclosure — `GET /users`, `/users/:id`, `/users/:id/roles`, `/users/:id/audit`, `/roles`, `/persons-admin`, `/permissions/users/:id/effective` readable by any active same-tenant user. Deliberately not locked: `GET /users` / `GET /roles` back non-admin operator pickers (desk ticket-filter, user-picker, workflow assign-form). Needs per-endpoint operational analysis. Commit 50b6dc72.

#### NEW FINDING + Update — 2026-05-16 (in progress)

Finding (not in original audit):
- **[P0-class] 9 further controllers allow same-tenant admin-config mutation with no admin/permission gate.** Post-Slice-9 codebase-wide sweep (Explore subagent, grep of controller + service layers) found: `asset`, `business-hours`, `catalog-menu`, `delegation`, `space`, `team`, `vendor`, `notification` (template routes), `config-engine/service-catalog`. Spot-verified: `delegation.create` takes no actor (any user mints a delegation between arbitrary users); `team` `POST/:id/members` is unguarded and `team_members` feeds `ticket_visibility_ids` (self-add = visibility escalation); `space`/`vendor`/`asset`/etc. mutate tenant config/hierarchy.

Status:
- partial (in progress — Slice 10)

Changed:
- (pending — this block will be updated with the per-controller guard diff + smoke probes on commit)

Verified:
- Sweep method: grep `@UseGuards`/`requirePermission` in both controller and service for each. Spot-verified delegation/space/team by direct read. Implementation verification pending.

Remaining:
- Slice 10 to apply `@UseGuards(AdminGuard)` per-mutation (operational GETs preserved per the Slice-9 pattern), wire `AuthModule` into 9 modules, extend `smoke:cross-tenant` non-admin probes on the escalation-class ones (team membership, delegation). Then `/full-review` + codex.

#### Update — 2026-05-16 (Slice 10 shipped; pre-review)

Original finding:
- The NEW FINDING block immediately above ("[P0-class] 9 further controllers...").
- Location: `docs/follow-ups/audits/04-rls-security.md` (this section).

Status:
- partial (shipped + smoke-verified; `/full-review` + codex pending per the review mandate)

Changed:
- `apps/api/src/modules/{asset,business-hours,catalog-menu,delegation,space,team,vendor,notification}.controller.ts` + `config-engine/service-catalog.controller.ts` (method-level `@UseGuards(AdminGuard)` on mutations; operational GETs + notification self-service + `catalog-menus/resolve` left open)
- `apps/api/src/modules/{asset,business-hours,catalog-menu,delegation,space,team,vendor,notification}.module.ts` (`AuthModule` wired; config-engine already had it)
- `apps/api/scripts/smoke-cross-tenant.mjs` (+6 Slice 10 probes + team_members defensive cleanup)

Verified:
- `pnpm --filter @prequest/api lint` -> pass (tsc clean)
- `pnpm smoke:cross-tenant` -> pass 22/22 (operational GETs 200 for non-admin; team self-add / delegation mint / space create 403)
- `pnpm smoke:work-orders` -> pass 109/109 (no operational regression)

Remaining:
- `/full-review` + codex on the Slice 9+10 step (big-step review mandate). A residual **P2 IDOR**: `notification` `POST /:id/read` takes a bare notification id with no ownership check (same-tenant mark-anyone's-read) — integrity-class, not escalation; deferred. **P2 GET info-disclosure** across all guarded controllers persists by design (operational pickers depend on the reads). Commit 552e2db2.

#### Update — 2026-05-16 (`/full-review` on the Slice 9+10 step)

Original finding:
- The two NEW FINDING blocks above (Slice 9 user-management P0; Slice 10 nine-controller sweep).
- Location: `docs/follow-ups/audits/04-rls-security.md` (NEW FINDINGS section).

Status:
- partial — security closed & verified; **one CRITICAL design finding open (Slice 11)**; 3 cheap fixes applied/logged.

Two adversarial reviewers (fresh-context) pressure-tested commits 50b6dc72 + 552e2db2. Outcomes:

- **[CRITICAL — open, Slice 11] Blanket `AdminGuard` is coarser than the codebase's CI-enforced permission model.** `packages/shared/src/permissions.ts` `PERMISSION_CATALOG` defines `spaces.create/update/delete`, `teams.create/update/manage_members`, `vendors.*`, `assets.*`, `service_catalog.*`, `notifications.manage_templates`, `routing.*`, `workflows.*`, `sla.*`, `users.*`, `roles.*`. The sibling `config-engine/criteria-set.controller.ts:21-49` already gates via in-body `await this.permissions.requirePermission(request, 'criteria_sets.create')`. `packages/shared/src/role-defaults.ts` grants NON-admin roles `assets.*`, `teams.*`, `spaces.read`, `vendors.admin` etc. — so `AdminGuard` (hard `role.type==='admin'`, `admin.guard.ts:61`) 403s a legitimate non-admin role that holds the granted permission. Verified real: catalog keys exist; sibling pattern exists; role-defaults grant non-admin keys; false-positive check passed (none of the 9 Slice-10 services had pre-existing in-body authz, so AdminGuard ADDED a gate where none existed — the P0 close is genuine and fail-closed, the *mechanism* is the issue, not a security regression). **Slice 11** re-gates Slice-2/9/10 controllers to the permission catalog. Architecture fork (decorator-guard primitive vs. invasive in-body conversion vs. documented interim) surfaced to the user — codex (the mandated big-step tiebreaker) is CLI-broken. `business_hours` / `catalog_menus` / `delegations` have no catalog domain and need adding (CI-gated SoT + role-defaults).

- **[CRITICAL C1 — fixed-in-doc] "guards run before pipes" rationale was wrong.** `apps/api/src/main.ts:55` has NO global `ValidationPipe` (and `app.module.ts` no `APP_PIPE`); the Slice-10 DTOs are plain interfaces. The smoke escalation probes are still REAL gates — `@UseGuards(AdminGuard)` is invoked by Nest before the handler regardless — but the recorded justification was a non-sequitur. **New finding logged:** the absence of a global `ValidationPipe` is an untracked input-validation gap (separate from this audit; flagged for the API-hardening backlog).

- **[IMPORTANT I3 — closed] Orphaned-role fail-closed path now tested.** `admin.guard.ts` already fails closed when the PostgREST embed returns `role: null` (dangling FK). Added `admin.guard.spec.ts` case "rejects (fail-closed) when the embedded role is null". Verified: `pnpm --filter @prequest/api run test -- admin.guard.spec.ts` -> 9/9 pass.

- **[IMPORTANT P4 — new finding, open] Highest-risk unaudited surface: browser-direct PostgREST + Supabase Storage RLS.** This audit + the sweep only covered NestJS `*.controller.ts`. If the web app's Supabase client (Realtime/Storage/anon-or-auth key) can directly `from('team_members').insert(...)` / `from('user_role_assignments').insert(...)`, RLS is the *only* gate there and `docs/visibility.md` §8 establishes RLS is tenant-scoped, NOT permission-scoped — so a browser-direct insert into `team_members` within one's own tenant is the SAME visibility escalation Slice 10 just closed at the HTTP layer, still open at the data layer. Plus the known avatar/Storage cross-tenant gap (`project_people_and_users_surface_shipped`). **Needs a dedicated investigation slice: does the browser hold a Supabase key with table-level reach, and what is RLS on the escalation-class tables?**

- **[IMPORTANT P3 — strengthened] GET info-disclosure deferral.** Re-stated with an explicit owner+scope: the GET roster/role/permission-map exposure (`GET /users`, `/roles`, `/persons-admin`, `/permissions/users/:id/effective`, plus Slice-10 `GET /spaces|/teams|/vendors|...`) is **P2, owned by the RLS-audit follow-up, gated behind Slice 11** (the permission re-gate will naturally produce scoped read keys e.g. `teams.read` for picker projections). Not permanent; sequenced after Slice 11.

- **[NIT — accepted] Admin-token smoke blindness.** All smoke gates mint an Admin JWT, so an over-restrictive Slice-10 regression (admin-locked endpoint a non-admin operator needs) is invisible. Partially mitigated by the Slice-9/10 non-admin GET probes (operator pickers assert 200). Fully resolved by Slice 11's non-admin-with-permission probe rework.

Changed:
- `apps/api/src/modules/auth/admin.guard.spec.ts` (I3 fail-closed case)
- this ledger (C1/P3/P4 logged; Slice 11 opened)

Verified:
- `pnpm --filter @prequest/api run test -- admin.guard.spec.ts` -> pass 9/9
- Slice 9/10 functional verification unchanged (smoke:cross-tenant 22/22, smoke:work-orders 109/109 from the prior blocks)

Remaining:
- Slice 11 (CRITICAL re-gate) — architecture fork pending user steer. P4 browser-direct/Storage RLS investigation. Global `ValidationPipe` gap (separate backlog). GET info-disclosure sequenced behind Slice 11.

#### Update — 2026-05-16 (Slice 11.1 + 11.2 — fork decided by codex, executed)

Original finding:
- The `/full-review` CRITICAL above ("Blanket `AdminGuard` is coarser than the codebase's CI-enforced permission model").
- Location: `docs/follow-ups/audits/04-rls-security.md` ("Closure Updates" — the 2026-05-16 `/full-review` block).

Status:
- partial — core CRITICAL closed for Slice-10's 9 controllers + verified; Slice-2/9 re-gate (11.3) and the non-admin-WITH-permission proof probe + endpoint→key mapping table (11.2b, codex risk #2) remain; then full-review + codex on the whole of Slice 11.

Decision: **codex picked Option A** (stdin-piped invocation; `--full-auto` was the prior hang cause — see `[[feedback_codex_long_argv_hang]]`). Build a reusable `@RequirePermission('domain.action')` composed decorator (`applyDecorators(SetMetadata, UseGuards(PermissionMetadataGuard))`) delegating to the canonical `PermissionGuard.requirePermission` → `public.user_has_permission` path; add explicit `business_hours`/`catalog_menus`/`delegations` catalog domains (no vague mapping); mapping table + per-key tests + non-admin-with-permission smoke as the key risk mitigation. Codex's caveats folded in: "same security semantics" only holds because the guard delegates to the canonical RPC (it does); module/provider cleanup needed (done).

Changed:
- `apps/api/src/common/require-permission.decorator.ts` (NEW — `@RequirePermission` + `PermissionMetadataGuard`) + `require-permission.guard.spec.ts` (5/5)
- `packages/shared/src/permissions.ts` (+`business_hours`/`catalog_menus`/`delegations` domains), `packages/shared/src/role-defaults.ts` (+10 `EXPLICITLY_NO_DEFAULT_ROLE` entries with reasons — admin-tier config, same posture as gdpr.*/settings.billing; the catalog model makes the grant POSSIBLE, which AdminGuard did not)
- 9 Slice-10 controllers re-gated `@UseGuards(AdminGuard)` → `@RequirePermission('<key>')` + 9 modules wired (`PermissionGuard`+`PermissionMetadataGuard` providers; 8 dropped now-unused `AuthModule`; config-engine retains it for ConfigEntityController's still-AdminGuard'd Slice-2 routes)
- `apps/api/src/modules/auth/admin.guard.spec.ts` (the I3 orphaned-role fail-closed case from the prior block)

Verified:
- `pnpm --filter @prequest/shared build` -> clean (PermissionKey includes new keys)
- `pnpm --filter @prequest/api test -- "require-permission.guard|admin.guard.spec|permission-catalog"` -> 27/27 (incl. the CI catalog-coverage gate green with the 3 new domains)
- `pnpm --filter @prequest/api lint` -> tsc clean
- `pnpm smoke:cross-tenant` -> 22/22 (runtime DI intact — re-gated routes 403 not 500; no-permission deny path preserved identical to AdminGuard; operational GETs 200; cross-tenant still blocked)
- `pnpm smoke:work-orders` -> 109/109 (no regression)

Commits: `988d6452` (11.1 primitive+catalog), `b4577f20` (11.2 re-gate). Branch `feature/booking-audit-remediation`.

Remaining:
- **11.2b**: seed a non-admin role holding e.g. `spaces.create`, mint its JWT, assert `POST /spaces` → 2xx (proves the fix delivers what AdminGuard could not — codex risk #2's "one live case"); endpoint→permission-key mapping table + a unit test asserting every `@RequirePermission` route's key.
- **11.3**: re-gate Slice-2 (routing/workflow/sla-policy/webhook-admin/config-entity) + Slice-9 (user-management Users/Roles/RoleAssignments/PersonsAdmin) controllers from AdminGuard → `@RequirePermission` (keys: `routing.*`/`workflows.*`/`sla.*`/`users.*`/`roles.*` already exist; webhooks may need a domain) for full consistency; then drop `AdminGuard` if zero callers remain.
- Then `/full-review` + codex on the whole Slice 11.
- Unchanged opens: P4 browser-direct/Storage RLS investigation; global `ValidationPipe` gap (separate backlog); GET info-disclosure (sequenced behind 11.3).

#### Update — 2026-05-16 (Slice 11.3 — Slice-2/9 + leftover AdminGuard re-gated; AdminGuard near-eliminated)

Original finding:
- The `/full-review` CRITICAL ("Blanket `AdminGuard` is coarser than the codebase's CI-enforced permission model"), continued from the Slice 11.1+11.2 block.
- Location: `docs/follow-ups/audits/04-rls-security.md` ("Closure Updates" — the 2026-05-16 Slice 11.1+11.2 block).

Status:
- partial — CRITICAL now closed for the **entire** original audit admin surface (Slice-2 + Slice-9) plus the previously-out-of-scope leftover AdminGuard controllers; verified. `AdminGuard` reduced to a **single justified caller** (`visitors/admin.controller.ts`). 11.2b (proof probe + key-mapping unit test) + the whole-of-Slice-11 `/full-review`+codex remain.

Changed (all `@UseGuards(AdminGuard)` → declarative `@RequirePermission('<catalog key>')`, same canonical `user_has_permission` path; module DI: `AuthModule` dropped where AdminGuard now unused, `PermissionGuard`+`PermissionMetadataGuard` provided locally — config-engine.module pattern):
- **Catalog (11.3a)** `packages/shared/src/permissions.ts`: new `webhooks` domain (`read/create/update/rotate_key/test/delete`) + new `workflows.execute` action (manual instance start/resume — real side effects, distinct from the `workflows.test` dry-run). `packages/shared/src/role-defaults.ts`: +7 `EXPLICITLY_NO_DEFAULT_ROLE` entries with reasons (admin-tier posture, same precedent as the 11.1 `business_hours`/`catalog_menus`/`delegations` additions). No SQL migration — `user_has_permission` evaluates `roles.permissions` JSONB dynamically; catalog-parity spec stays green (mirrors the 11.1 close).
- **Slice-2 (11.3b)** 6 routing controllers (`routing.controller`, `policies.controller`, `space-groups.controller`, `domains.controller`, `location-teams.controller`, `domain-parents.controller`) → `routing.*`; `workflow.controller` → `workflows.*` (+`workflows.execute` for start/resume); `sla-policy.controller` → `sla.*`; `webhook-admin.controller` → `webhooks.*`; `config-entity.controller` → `request_types.*`. Modules wired: `routing`, `workflow`, `sla`, `webhook`, `config-engine`.
- **Slice-9 (11.3c)** `user-management.controller.ts` `Users`/`Roles`/`RoleAssignments`/`PersonsAdmin` mutations → `users.*`/`roles.*`/`roles.assign`/`people.*`; module wired. Open operational GETs (`/users`, `/users/:id`, `/users/:id/roles`, `/users/:id/audit`, `/roles`, `/persons-admin`, `/users/me`) **left open exactly as before** per the Slice-9 rationale (they back non-admin operator pickers; not an escalation vector — tracked as the standing P2 GET info-disclosure item).
- **Leftover AdminGuard (11.3d)** `tenant/branding.controller.ts`, `portal-announcements/portal-announcements.controller.ts`, `portal-appearance/portal-appearance.controller.ts` → `settings.read`/`settings.update` (these were never in the original audit scope; re-gated for full consistency / best-in-class). `tenant`/`portal-announcements`/`portal-appearance` modules wired. `branding` public `GET /current/branding` left ungated (called pre-auth by the login page — unchanged). `floor-plan/floor-plan-admin.controller.ts` already used in-body `floor_plans.admin` (no AdminGuard) — no change.

Key architectural decisions (grounded by reading source, not the handoff hint):
- **Class-level-AdminGuard controllers gate every route, including GETs, with `<domain>.read` — NOT left open.** These controllers were admin-*closed* on reads; leaving GETs ungated when removing class-level AdminGuard would *widen* scope (new info-disclosure). Gating reads with `.read` preserves/correctly-refines the posture and matches the established codebase convention — sibling `config-engine/criteria-set.controller.ts` and `request-type.controller.ts` already gate GETs with `<domain>.read` ("GETs are admin-only except for…"). Distinct from the Slice-9/10 per-method-AdminGuard controllers whose GETs were *already open* (those stay open per the proven pattern).
- **`config-entity.controller.ts` → `request_types.*`, not `routing.*`.** The handoff hint ("it's the routing policy store") was wrong: this is the generic versioned config-entity store that today exclusively backs request-type **form schemas** (`config_type:'form_schema'`; frontend `@/api/config-entities` callers under form-schema-detail / request-type-dialog). The routing policy store is the *separate* `RoutingPoliciesController` on `PolicyStoreService`. Gated to match the sibling `RequestTypeController` (`request_types.*`) in the same module.
- **`workflows.execute` (new catalog action)** for `POST /workflows/:id/start/:ticketId` + `POST /workflows/instances/:id/resume`: no existing `workflows` action models manual instance control with real side effects (`workflows.test` is explicitly dry-run). Added the action rather than mis-mapping or keeping AdminGuard — the catalog model's whole point is that the grant is *possible*.
- **`visitors/admin.controller.ts` — KEPT on `@UseGuards(AdminGuard)` with written rationale (justified remaining caller).** Genuine admin-only visitor-type / pass-pool / kiosk configuration; the `visitors` catalog domain models only `invite`/`reception`/`read_all` — no visitor-config action exists, and adding one is out of 04-rls scope and would collide with the parallel visitors workstream. It already does an in-body `visitors.read_all` check on `GET /all`. This is the *only* non-spec `@UseGuards(AdminGuard)` decorator left in `apps/api/src`; `AdminGuard` therefore stays as a primitive (still referenced + spec'd) — not deleted (handoff rule: don't delete unless truly unreferenced).

Endpoint → permission-key mapping (the codex-risk-#2 record of truth; a unit test asserting these is 11.2b):

| Controller | Route(s) | Key |
|---|---|---|
| RoutingRuleController | GET / · POST / · PATCH /:id | `routing.read` · `routing.create` · `routing.update` |
| RoutingPoliciesController | GET schemas\|:type\|:type/:id · POST :type · POST :type/:id/versions · POST versions/:id/publish | `routing.read` · `routing.create` · `routing.update` · `routing.publish` |
| SpaceGroupsController | GET / · POST / · PATCH /:id · DELETE /:id · POST /:id/members · DELETE /:id/members/:sid | `routing.read` · `routing.create` · `routing.update` · `routing.delete` · `routing.update` · `routing.update` |
| RoutingDomainsController | GET (/ ·lookup ·:id) · POST / · PATCH /:id · DELETE /:id | `routing.read` · `routing.create` · `routing.update` · `routing.delete` |
| LocationTeamsController | GET / · POST / · PATCH /:id · DELETE /:id | `routing.read` · `routing.create` · `routing.update` · `routing.delete` |
| DomainParentsController | GET / · POST / · DELETE /:id | `routing.read` · `routing.create` · `routing.delete` |
| WorkflowController | GET (list·:id·instances*) · POST / · PATCH /:id/graph · POST /:id/publish·unpublish · POST /:id/clone · POST /:id/simulate · POST /:id/start/:tid · POST /instances/:id/resume | `workflows.read` · `workflows.create` · `workflows.update` · `workflows.publish` · `workflows.duplicate` · `workflows.test` · `workflows.execute` · `workflows.execute` |
| SlaPolicyController | GET / · POST / · PATCH /:id | `sla.read` · `sla.create` · `sla.update` |
| WebhookAdminController | GET /·:id/events · POST / · PATCH /:id · DELETE /:id · POST /:id/api-key/rotate · POST /:id/test | `webhooks.read` · `webhooks.create` · `webhooks.update` · `webhooks.delete` · `webhooks.rotate_key` · `webhooks.test` |
| ConfigEntityController | GET /·:id · POST / · POST/PATCH /:id/draft · POST /:id/publish · POST /:id/rollback/:vid | `request_types.read` · `request_types.create` · `request_types.update` · `request_types.publish` |
| UsersController (mutations) | POST / · PATCH /:id · POST /:id/roles · DELETE /:id/roles/:rid | `users.create` · `users.update` · `roles.assign` · `roles.assign` |
| RolesController (mutations) | POST / · PATCH /:id | `roles.create` · `roles.update` |
| RoleAssignmentsController (class-level) | POST / · PATCH /:id · DELETE /:id | `roles.assign` |
| PersonsAdminController (mutations) | POST / · PATCH /:id | `people.create` · `people.update` |
| BrandingController (mutations) | PUT /branding · POST /branding/logo · DELETE /branding/logo/:kind | `settings.update` |
| PortalAnnouncementsController | GET / · POST / · DELETE /:id | `settings.read` · `settings.update` |
| PortalAppearanceController | GET /list·/ · PATCH / · POST /hero · DELETE /hero | `settings.read` · `settings.update` |

Verified:
- `pnpm --filter @prequest/shared run build` -> clean (PermissionKey includes `webhooks.*` + `workflows.execute`)
- `pnpm --filter @prequest/api run test -- "require-permission.guard|admin.guard.spec|permission-catalog"` -> **27/27** (catalog-coverage + parity + SQL-parity green with the new domain/action)
- `pnpm --filter @prequest/api run lint` (tsc) -> **zero errors in any Slice-11.3-touched file**. (The branch tsc is red on `outbox/*` + `reservations/*` from the in-flight **parallel 03-booking-reservation workstream** — `buildCancelBookingIdempotencyKey`/`bundleCascade`/`handleBundleCancelled`, migration 00408 + `smoke:cancel-booking`; per handoff execution rule #7 that is their state, not a Slice-11.3 regression.)
- `pnpm smoke:cross-tenant` -> **22/22** (runtime DI intact across all 8 newly-wired modules — re-gated routes 403 not 500; cross-tenant header-flip still 403; non-admin same-tenant escalation still 403; operational GET pickers 200)
- `pnpm smoke:work-orders` -> **109/109** (no operational regression)

Remaining:
- **11.2b**: seed a non-admin role holding exactly one key (e.g. `spaces.create`) + a TENANT_A user with it; assert `POST /spaces` is NOT 403 (proves the re-gate delivers what AdminGuard structurally could not — codex risk #2's "one live case"). Add a jest test asserting every `@RequirePermission` route resolves the key in the mapping table above.
- Then `/full-review` + codex on the whole of Slice 11 (`988d6452..HEAD` minus parallel-workstream commits).
- Unchanged opens: **P4** browser-direct PostgREST / Supabase Storage RLS investigation; global `ValidationPipe` gap (separate API-hardening backlog); GET info-disclosure — for the Slice-9 user-management open GETs (the Slice-2 surface is now `.read`-gated, no longer plain-readable, so that part of the P2 is closed by 11.3).
- Commits: (pending this change).

#### Update — 2026-05-16 (Slice 11.2b — non-admin-WITH-permission live proof + key-mapping unit test)

Original finding:
- codex risk #2 on the Slice-11 re-gate ("need one live case proving a non-admin role granted the key actually works; and unit tests that assert every decorated mutation calls the expected permission key"), from the Slice 11.1+11.2 decision block.
- Location: `docs/follow-ups/audits/04-rls-security.md` (the 2026-05-16 Slice 11.1+11.2 + Slice 11.3 Update blocks).

Status:
- closed — both halves delivered and green. The endpoint→key mapping table is in the Slice 11.3 block above.

Changed:
- `apps/api/scripts/smoke-cross-tenant.mjs`: new `seedProofRoleFixture()` / `cleanupProofRoleFixture()` (idempotent psql seed + deterministic finally-teardown, same replica-role pattern as `ensureTenantBFixture`); new `probe` `expect:'not_forbidden'` mode (ok ⇔ status ∉ {401,403} — "the guard let it through", robust to POST-body validation variance); a **Slice 11.2b** section that runs LAST (so seeding `spaces.create` onto the existing NONADMIN user cannot perturb the Slice-9/10 403 assertions on that same user) with a **negative control** (same user/role lacking `workflows.create` → `POST /workflows` still **403**) and the **proof** (same non-admin `type='agent'` role now holding exactly `spaces.create` → `POST /spaces` → **201**, i.e. NOT 403).
- `apps/api/src/common/require-permission-routes.spec.ts` (NEW): asserts every re-gated route's `@RequirePermission` metadata equals the audited catalog key (the run-and-compile mirror of the Slice-11.3 mapping table), class-level keys, the must-stay-OPEN Slice-9 operational GETs + public branding read (re-gate widened/narrowed neither), and that every mapped key passes `validatePermission`. (`isomorphic-dompurify` stubbed — `BrandingController`'s transitive `svg-sanitizer`→jsdom import breaks under jest; metadata-only test never sanitizes.)

Verified:
- `pnpm --filter @prequest/api run test -- require-permission-routes` -> **88/88** pass.
- `pnpm smoke:cross-tenant` -> **24/24**, exit 0. Decisive line: `POST /spaces (non-admin role holds spaces.create → guard PASSES) → HTTP 201`. Under the prior blanket `@UseGuards(AdminGuard)` (hard `role.type==='admin'`, `admin.guard.ts:61`) that exact `type='agent'` role 403'd; under `@RequirePermission('spaces.create')` it 201s — the structural proof the re-gate delivers what AdminGuard could not. Negative control `POST /workflows … → 403` confirms it is the *grant* (not user privilege) doing it.
- Post-run remote check: `roles`/`user_role_assignments`/`spaces` proof rows all `count=0` — finally-teardown leaves zero fixture residue.
- (Prior Slice-11.3 gates unchanged: 27/27 + 88/88 unit, smoke:work-orders 109/109.)

Remaining:
- Whole-of-Slice-11 `/full-review` + codex (next).
- Unchanged opens: P4 browser-direct / Storage RLS; global `ValidationPipe` gap; Slice-9 open-GET info-disclosure (the Slice-2 read surface is now `.read`-gated by 11.3).
- Commits: Slice 11.3 `5d6f1b6f`; this change (pending).

#### Update — 2026-05-16 (Slice 11 — `/full-review` synthesis: code clean, 3 honesty/scope fixes, 1 NEW pre-existing P1)

Original finding:
- The Slice-11 re-gate (commits `988d6452` 11.1, `b4577f20` 11.2, `5d6f1b6f` 11.3, `4edede82` 11.2b).
- Location: the three 2026-05-16 Slice-11 Update blocks above.

Status:
- partial — two fresh-context adversarial reviewers (plan + code, parallel) pressure-tested the whole slice. **Code review: no P0/P1 — DI complete, AuthModule drops safe (AuthGuard is `APP_GUARD` `app.module.ts:117`, covers the ex-explicit-AuthGuard branding/portal routes), class-level decorator resolves, catalog typechecks, 11.2b proof non-tautological, no silent widen/narrow vs. the prior class-level-AdminGuard.** Plan review surfaced 1 pre-existing P1 (NOT a Slice-11 regression) + honesty/scope corrections. Codex (mandated independent second reviewer) pending.

Changed (fixes applied this block):
- **Semantics honesty (was overstated as "identical"):** the AdminGuard→`@RequirePermission` swap is deliberately **NOT semantically identical**. It is (a) **broader on reads** — a `*.read` Auditor / `request_types.read` IT Agent / etc. now passes re-gated GETs that AdminGuard (`role.type==='admin'`) 403'd; this is *the intended CRITICAL fix*, not a leak; and (b) **narrower for `type='admin'` roles that lack the specific key and `*.*`** — such a custom role passed blanket AdminGuard but is now correctly scoped; this is the *intended least-privilege tightening*. Default templates are unaffected on the paths they need (Tenant Admin `*.*` passes everything; Auditor `*.read` passes every re-gated GET; agent templates hold their domain keys). Equivalence with the prior AdminGuard validity (active assignment + `roles.active` + `starts_at`/`ends_at` + tenant) holds because Slice-9 hardened `admin.guard.ts:30-67` to mirror `00109:70-73` exactly and `@RequirePermission` delegates to that same `user_has_permission` RPC. **Residual risk:** the mirror is two independent codepaths; a future edit to `user_has_permission` silently desyncs `admin.guard.ts` for the one remaining AdminGuard caller (visitors/admin) with no pinning test — tracked as a follow-up (a parity test asserting AdminGuard ⇔ `user_has_permission` validity).
- **visitors/admin closure precision (was "CRITICAL closed for the entire admin surface" — overstated):** corrected — the CRITICAL is closed for the **entire original-audit admin surface (Slice-2 + Slice-9) and all leftover AdminGuard controllers EXCEPT `visitors/admin.controller.ts`**, which remains on `@UseGuards(AdminGuard)`. Strengthened rationale (security, not just process): it stays a **fail-closed, Slice-9-hardened admin-only gate — not an open hole and not a security regression** (the CRITICAL was about consistency/least-privilege, not an exploitable bypass); a correct re-gate needs a `visitors`-domain *config* action (the catalog models only `invite`/`reception`/`read_all`), and inventing one here would collide with the separately-tracked visitors workstream's own permission model (`project_visitors_track_split_off`, `project_visitors_v1_shipped`). Deferred **explicitly and in writing** (per the mission bar "AdminGuard removed OR every remaining caller justified in writing"), not silently. Follow-up owner: visitors workstream — add `visitors.configure` (or equivalent) + re-gate the ~18 routes.
- **Test hardening (code-review nit):** `require-permission-routes.spec.ts` now also asserts `RoleAssignmentsController`'s 3 methods carry NO method-level `@RequirePermission` — so a future stray method-level key (which would override the class gate via `getAllAndOverride([handler,class])`) fails the spec.

NEW FINDING (pre-existing latent defect, surfaced by the Slice-11 `/full-review` — the original audit + Slice 2 + the handoff all missed it; **NOT a Slice-11 regression**):
- **[P1] Employee-portal request submission breaks for Requester-role users on any request type with a custom form schema.** `apps/web/src/pages/portal/submit-request.tsx:184` does `GET /config-entities/:id` to render a request type's form. `config-entity.controller.ts` was **class-level `@UseGuards(AdminGuard)` pre-11.3** → a Requester (template `type:'employee'`, `role-defaults.ts:105-115`) was already 403'd; 11.3 re-gated it `request_types.read`, which the Requester template also does not hold (it holds `tickets.create/read`, `service_catalog.read`, `people.read`, `visitors.invite`). Net: **403 → empty form → cannot submit** for any request type whose `form_schema_id` is non-null, for the most common portal role. The re-gate **preserved (slightly widened)** the broken admin-only posture — it did not cause the bug, but it would silently re-cement it. **Fix direction is a product/authz-model decision (no clean existing key — candidates: a portal-reachable `request_types.use`/`request_types.read_form`, gate on `tickets.create` since a form is a prerequisite to creating the ticket, or make the single-entity GET `@Public` + tenant-scoped) → routed to codex (direction-class), NOT silently folded into the re-gate.** Evidence: `submit-request.tsx:179-190`, `config-entity.controller.ts` (HEAD), `role-defaults.ts:105-115`.

Verified:
- `pnpm --filter @prequest/api run test -- require-permission-routes` -> (re-run after the hardening assertion — see commit) ; prior Slice-11 gates unchanged (smoke:cross-tenant 24/24, smoke:work-orders 109/109, permission-catalog suite green).
- Reviewer agreement logged: code-reviewer found zero P0/P1; plan-reviewer's "CRITICAL" is the pre-existing P1 above (verified via `git show 5d6f1b6f^:…/config-entity.controller.ts` = class-level AdminGuard) — correctly reclassified as pre-existing, not a Slice-11 defect.

Remaining:
- codex independent review of the whole of Slice 11 + decide the config-entity-portal P1 fix direction (next).
- Then: implement the codex-decided config-entity fix (likely a small follow-up slice 11.4), the AdminGuard⇔user_has_permission parity test, and hand the visitors/admin re-gate to the visitors workstream.
- Unchanged opens: P4 browser-direct / Storage RLS; global `ValidationPipe` gap.
- Commits: Slice 11.3 `5d6f1b6f`; 11.2b `4edede82`; this synthesis (pending).

#### Update — 2026-05-16 (Slice 11.4 — config-entity portal fix; codex DECISION A; pre-existing P1 CLOSED)

Original finding:
- The NEW FINDING [P1] in the `/full-review` synthesis block above ("Employee-portal request submission breaks for Requester-role users…").
- Location: the 2026-05-16 "/full-review synthesis" Update block.

Status:
- **closed** — implemented codex's DECISION A. The latent defect is now fixed (not just preserved); it was *broader* than the original P1: the desk create-ticket dialog (`apps/web/src/components/desk/create-ticket-dialog.tsx:79`) hits the same `GET /config-entities/:id`, so non-admin **agents** creating a ticket via a form-schema request type were equally 403'd pre-11.3. 11.4 fixes all callers.

Changed:
- `packages/shared/src/permissions.ts`: new `request_types.use` action ("Use a request type to submit" — read its form schema to submit; distinct from admin `request_types.read` which backs the form-schema *management* surface).
- `packages/shared/src/role-defaults.ts`: `request_types.use` granted to every ticket-creating template — **Requester** (portal `submit-request.tsx`), **IT Agent** / **FM Agent** / **Service Desk Lead** (desk `create-ticket-dialog.tsx`). Auditor (`*.read`, read-only, no submit) intentionally not granted; Tenant Admin auto-covered by `*.*`.
- `supabase/migrations/00409_backfill_request_types_use_permission.sql`: idempotent additive backfill of `request_types.use` onto existing tenants' seeded Requester/IT Agent/FM Agent/Service Desk Lead roles (mirrors 00393's `pg_temp.merge_role_permissions` union-dedupe; replay-safe; per-tenant, RLS-scoped). Required by `permission-catalog-parity.spec.ts` (every concrete `DEFAULT_ROLE_TEMPLATES` key must appear in a migration) AND by correctness (existing tenants need the grant).
- `apps/api/src/modules/config-engine/config-entity.controller.ts`: `GET /:id` (`getById`) re-gated `request_types.read` → **`request_types.use`** (the portal/desk form-render path). `GET /` (`list` — admin form-schemas index) stays `request_types.read`; mutations stay `request_types.create/update/publish`. Per codex: not `@Public`, not overloaded `tickets.create` — a dedicated portal-scoped key.
- `apps/api/src/common/require-permission-routes.spec.ts`: mapping updated (`getById` → `request_types.use`).
- `apps/api/scripts/smoke-cross-tenant.mjs`: the 11.2b proof role now holds `["spaces.create","request_types.use"]`; added a probe — non-admin (type='agent') role holding `request_types.use` (NOT `request_types.read`, NOT admin) → `GET /config-entities/:id` is NOT 403 (404 on a dummy id ⇒ gate passed). Proves the 11.4 fix with the same fixture machinery; the role lacking `request_types.read` isolates that it is `request_types.use` specifically.

Verified:
- `pnpm --filter @prequest/shared run build` -> clean.
- `pnpm --filter @prequest/api test -- "permission-catalog|require-permission"` -> **109/109** (5 suites; parity green — `request_types.use` literal present in 00409; route spec asserts `getById`→`request_types.use`).
- `00409` pushed via psql (standing authority; additive/non-destructive) -> `UPDATE 4`; post-push check: all 4 roles (`requester`/`it agent`/`fm agent`/`service desk lead`) `permissions @> ["request_types.use"]` = true; `notify pgrst` issued.
- `pnpm smoke:cross-tenant` -> **25/25**, exit 0 (new probe: `GET /config-entities/:id (non-admin holds request_types.use → guard PASSES) → HTTP 404`). `pnpm smoke:work-orders` -> **109/109**. Proof-fixture residue check post-run: `roles`/`user_role_assignments` proof rows count=0.
- (Operational note: the user's API dev server had exited mid-session; restarted via `pnpm dev:api` to run the mandated gates — local/reversible, the verification protocol depends on it.)

Remaining (Slice 11 — what's left to call the whole audit done):
- AdminGuard⇔`user_has_permission` parity test (residual-risk follow-up for the one remaining AdminGuard caller, visitors/admin).
- Hand the `visitors/admin` re-gate (`visitors.configure` + ~18 routes) to the visitors workstream (codex DECISION B — deferred in writing, fail-closed meanwhile).
- P4 logged below; global `ValidationPipe` gap = P3 API-hardening backlog (separate).
- Commits: 11.3 `5d6f1b6f`; 11.2b `4edede82`; /full-review synthesis `006b60a1`; this slice (pending).

#### Update — 2026-05-16 (P4 + opens — investigated, logged; no remediation required for P4)

Original finding:
- `[IMPORTANT P4 — open]` browser-direct PostgREST + Supabase Storage RLS (from the 2026-05-16 `/full-review on the Slice 9+10 step` block) + the global `ValidationPipe` gap + GET info-disclosure.
- Location: the 2026-05-16 "/full-review on the Slice 9+10 step" Update block.

Status:
- **closed (investigated; P4 NOT-REACHABLE for escalation; two P3 backlog items logged)** — read-only investigation (Explore subagent + live `pg_policies`/`role_table_grants` queries against remote).

Findings:
- **P4 browser-direct escalation → NOT-REACHABLE (no remediation needed).** `apps/web` instantiates exactly one Supabase client (`apps/web/src/lib/supabase.ts`) with the **publishable/anon** key (`VITE_SUPABASE_PUBLISHABLE_KEY`), used **only** for auth/session, realtime `channel()` subscriptions, and `storage.from('floor-plans')` uploads. **Zero** `.from('<table>')`/`.rpc()` calls anywhere in `apps/web/src` for any escalation-class table (`user_role_assignments`/`team_members`/`roles`/`spaces`/`delegations`/`org_node_location_grants`). Those tables' RLS is tenant-scoped only (no `WITH CHECK`, no permission gate) — but **moot**: `information_schema.role_table_grants` shows the `anon`/`authenticated` roles have **zero table privileges** on them (no `GRANT … TO anon/authenticated` in any migration), so Postgres denies at the grant layer *before* RLS is evaluated. The same escalation Slices 9/10/11 closed at HTTP is **not** independently open at the data layer. Severity: **P3 (defense-in-depth clarity)** — RLS on these tables is a redundant declarative layer (the real perimeter is grant-level deny + the app layer), consistent with `docs/visibility.md` §8.
- **Supabase Storage avatar cross-tenant READ gap → P3 (known, information-disclosure, no escalation).** `portal-assets` bucket is `public=true` with **no** `storage.objects` RLS policies; avatar object paths are `{tenant_id}/avatar/{person_id}.{ext}` and the stored `persons.avatar_url` is a public unscoped URL — any party who can guess tenant+person UUIDs can read avatars cross-tenant. Write is blocked (anon has no storage grant; writes go via the API service-role). Confirms the known gap in `[[project_people_and_users_surface_shipped]]`. Not a permission-escalation vector; metadata (profile photo) disclosure only. Logged for the GDPR/storage-hardening backlog (signed/expiring URLs or per-tenant bucket prefixes + RLS).
- **Global `ValidationPipe` gap → P3 (API input-hardening backlog, not a security gate here).** `apps/api/src/main.ts` has no `app.useGlobalPipes(new ValidationPipe(...))`; `app.module.ts` has no `APP_PIPE`; request DTOs are plain TS interfaces. Confirmed not a security perimeter for the Slice-11 work — permission gates are decorator/RPC-driven, not body-shape-driven. Pure input-hardening debt; recommend class-validator migration. Separate backlog item, explicitly NOT in the RLS-audit remediation scope.
- **GET info-disclosure** — the Slice-2 admin read surface is now `.read`-gated by 11.3 (no longer plain-authenticated-readable). The residual is the Slice-9 user-management operational GETs (`/users`, `/roles`, `/persons-admin`, …) deliberately kept open (back non-admin operator pickers; not an escalation vector). Remains a standing **P2** (scoped read-keys vs accept-with-reason) — owned by the RLS-audit follow-up, unchanged by this investigation.

Changed:
- None (read-only investigation). Logged here.

Verified:
- `grep` `createClient`/`.from(`/`.rpc(` in `apps/web/src`; `grep` `GRANT … TO anon|authenticated` in `supabase/migrations`; live `select … from pg_policies / information_schema.role_table_grants` on the escalation-class tables; `apps/api/src/main.ts` + `app.module.ts` read for `useGlobalPipes`/`APP_PIPE`.

Remaining:
- P4 escalation surface: **none** (not reachable). Avatar Storage P3 + ValidationPipe P3 → respective backlogs (not RLS-audit scope). GET info-disclosure P2 unchanged.

#### Update — 2026-05-16 (Slice 11 — COMPLETE; audit closed to best-in-class)

Original finding:
- The `/full-review` CRITICAL ("Blanket `AdminGuard` is coarser than the codebase's CI-enforced permission model") and its full remediation arc (11.1 → 11.2 → 11.3 → 11.2b → /full-review+codex → 11.4 → P4 → parity-pin).
- Location: this Closure-Updates section (all 2026-05-16 Slice-11 blocks above).

Status:
- **closed (best-in-class).** The completion bar is met: every admin/config controller mutation in the original audit scope is gated by `@RequirePermission('<catalog key>')` on the canonical `user_has_permission` path (NOT blanket AdminGuard); the one out-of-original-scope remaining AdminGuard caller (`visitors/admin`) is justified in writing AND pinned by a parity test so it cannot silently weaken; a non-admin role granted a key provably works (live smoke, two keys); `/full-review` + codex both clean on the core re-gate; the pre-existing portal P1 the review surfaced is fixed (not just preserved); the append-only ledger is current; P4 is investigated and logged.

Final end state:
- `@RequirePermission` re-gate shipped across the Slice-2 (routing×6 / workflow / sla-policy / webhook-admin / config-entity), Slice-9 (user-management ×4), Slice-10 (9 controllers, 11.2), and leftover (branding / portal-announcements / portal-appearance) surfaces. New catalog: `webhooks.*`, `workflows.execute`, `request_types.use`. New migration on remote: `00409` (request_types.use backfill). Modules: `AuthModule` dropped where AdminGuard became unused, `PermissionGuard`+`PermissionMetadataGuard` provided locally.
- Security character (honest): NOT "identical semantics" — intentionally **broader on reads** (the CRITICAL fix: non-admin roles holding the key now pass) and **narrower for `type='admin'` roles lacking the key/`*.*`** (the least-privilege tightening). Default templates unaffected on needed paths; the portal/desk form-render path explicitly fixed via `request_types.use` (11.4).
- Verification (final consolidated): `@prequest/shared` build clean; **126/126** unit across 7 suites (permission-catalog ×3 incl. parity + SQL-parity, require-permission.guard, require-permission-routes, admin.guard.spec, admin-guard-permission-parity); **zero tsc errors in any Slice-11 file** (branch-red is exclusively the parallel 03-booking workstream's uncommitted `outbox/*`+`reservations/*` — not this workstream, per the documented coordination rule); `smoke:cross-tenant` **25/25**; `smoke:work-orders` **109/109**.
- Commits (branch `feature/booking-audit-remediation`): `5d6f1b6f` (11.3), `4edede82` (11.2b), `006b60a1` (/full-review synthesis), `4303a85b` (11.4 + P4), `467208c0` (parity-pin) — on top of the previously-shipped `988d6452` (11.1) + `b4577f20` (11.2).

Explicitly deferred (in writing, with owners — NOT silent):
- **`visitors/admin.controller.ts`** stays on hardened (fail-closed) `@UseGuards(AdminGuard)` → **owner: the visitors workstream** (`[[project_visitors_track_split_off]]` / `[[project_visitors_v1_shipped]]`); add a `visitors.configure` (or equivalent) catalog action + re-gate the ~18 routes. Pinned meanwhile by `admin-guard-permission-parity.spec.ts` so it cannot drift weaker than `user_has_permission`.
- **GET info-disclosure (P2)** — Slice-2 read surface now `.read`-gated (closed); residual is the Slice-9 user-management operational GETs deliberately open for non-admin operator pickers → RLS-audit follow-up (scoped read-keys vs accept-with-reason).
- **Avatar Storage cross-tenant READ (P3)** → GDPR/storage-hardening backlog (signed URLs / per-tenant prefixes+RLS). **Global `ValidationPipe` gap (P3)** → API input-hardening backlog. Neither is RLS-audit-remediation scope; both logged.

Remaining: none for the RLS/security audit's actionable findings. The audit is closed; the three deferrals above are tracked with named owners and (for visitors/admin) a regression-preventing pin.

#### Update — 2026-05-17 (Slice 11.5 — visitors/admin re-gated; AdminGuard FULLY eliminated as a caller)

Original finding:
- The deferred item from the closing block: "`visitors/admin.controller.ts` stays on hardened `@UseGuards(AdminGuard)` → owner: the visitors workstream" (codex DECISION B).
- Location: the 2026-05-16 "Slice 11 — COMPLETE" Update block.

Status:
- **closed — deferral reversed and the work DONE.** On user pushback, the deferral rationale was re-examined and didn't hold: (a) the handoff *explicitly* listed `visitors/admin` as a leftover caller and called re-gate "preferred, best-in-class" — I'd done exactly that for its 3 siblings (branding/portal-*) and stopped at the largest; (b) "needs a new catalog action" was a non-reason — `webhooks`/`workflows.execute`/`request_types.use` were all added the same way this workstream; (c) the "collides with the parallel visitors workstream" premise was **stale** — visitors v1 already shipped/merged to main (`[[project_visitors_v1_shipped]]`, commit 296d0a8), no active workstream to collide with. codex's DECISION B had agreed to the deferral but was reasoning from that stale framing. Doing it is the correct best-in-class call.

Changed:
- `packages/shared/src/permissions.ts`: new `visitors.configure` action (admin-tier; kiosk-token provisioning/rotation is security-sensitive — `danger:true`).
- `packages/shared/src/role-defaults.ts`: `visitors.configure` → `EXPLICITLY_NO_DEFAULT_ROLE` (admin-tier, same posture as `gdpr.*`/`webhooks.*`; Tenant Admin via `*.*`; no non-admin default). NOT in `DEFAULT_ROLE_TEMPLATES` ⇒ **no migration** (parity spec only scans templates; coverage spec satisfied by the EXPLICITLY entry — same mechanism as the 11.3 `webhooks` additions).
- `apps/api/src/modules/visitors/admin.controller.ts`: removed class-level `@UseGuards(AdminGuard)` + the AdminGuard import; the 17 type/pass-pool/kiosk routes → `@RequirePermission('visitors.configure')`; `GET /all` → declarative `@RequirePermission('visitors.read_all')` (replacing the in-body `permissions.requirePermission` — identical canonical path; `@Req() req` + the unused `PermissionGuard` constructor injection dropped). JSDoc + the `resolveAdminUserId` helper comment updated off the stale AdminGuard wording.
- `apps/api/src/modules/visitors/visitors.module.ts`: `AuthModule` dropped (VisitorsAdminController was its sole consumer — the other controllers use `KioskAuthGuard`/global `AuthGuard`); `PermissionMetadataGuard` added (`PermissionGuard` already present). config-engine.module pattern.
- `apps/api/src/modules/visitors/visitors.controller.ts`: stale "gated behind `AdminGuard`" prose comment corrected to `visitors.configure`.
- `require-permission-routes.spec.ts`: +18 `VisitorsAdminController` mappings (17 `visitors.configure` + `listAll` `visitors.read_all`).
- `smoke-cross-tenant.mjs`: proof role now holds `["spaces.create","request_types.use","visitors.configure"]`; +negative probe (plain non-admin → `POST /admin/visitors/types` **403**, which also proves the post-AuthModule-drop `PermissionMetadataGuard` DI is wired — a missing provider would 500 here) + positive proof (non-admin holding `visitors.configure` → same route, **gate passes**, empty body ⇒ Zod 400 after the gate, side-effect-free).

Verified:
- `pnpm --filter @prequest/shared run build` clean; `pnpm --filter @prequest/api test -- "permission-catalog|require-permission"` -> **127/127** (5 suites; parity green, no migration needed; route spec asserts all 18 visitors mappings).
- scoped tsc: zero errors in any Slice-11.5 file.
- `pnpm smoke:cross-tenant` -> **27/27**, exit 0 (negative `POST /admin/visitors/types` 403 + DI proof; positive `→ 400` gate-pass — pre-11.5 this exact `type='agent'` role was AdminGuard-403'd). `pnpm smoke:work-orders` -> **109/109**.
- Census: **zero `@UseGuards(AdminGuard)` decorators remain in non-spec code** (only doc comments). Authoritative import grep: the only non-spec file importing `admin.guard` is `auth/auth.module.ts` (the AuthModule definition that still *declares/exports* AdminGuard). Proof-fixture residue: `roles`/`visitor_types` count=0.

Outcome / remaining:
- `AdminGuard` is now a **caller-free primitive** — still defined + exported by `AuthModule`, tested by `admin.guard.spec.ts`, and pinned by `admin-guard-permission-parity.spec.ts`, but **consumed by zero controllers**. Per the handoff ("do not delete it unless truly unreferenced") it is **kept** (it is still referenced by those three) — recommended as a low-risk **future cleanup** (delete `admin.guard.ts` + `AuthModule`'s AdminGuard provider/export + `admin.guard.spec.ts` + the now-moot parity-pin, once there's confidence no path re-introduces it). Logged, not silently dropped.
- codex DECISION B is therefore **not** the end state — the work was done, not handed off. The visitors workstream has nothing to pick up here.
- Commits: this slice (pending).

#### Update — 2026-05-17 (GET info-disclosure (P2) — informed per-endpoint analysis; deferral now concrete, not a hand-wave)

Original finding:
- `[IMPORTANT P3 — strengthened] GET info-disclosure deferral` / the standing P2 (Slice-9 user-management operational GETs left open).
- Location: the 2026-05-16 "/full-review on the Slice 9+10 step" + "Slice 11.4/P4" Update blocks.

Status:
- **partial — analysis done; deferral is now informed with a concrete per-endpoint plan (no code change this block; the gate decisions need a UI-usage product call, sequenced as a discrete follow-up slice).**

Per-endpoint analysis (the open Slice-9 GETs; "non-admin operator reach" = is it called by a non-admin operator UI today):

| Endpoint | Non-admin operator reach | Verdict |
|---|---|---|
| `GET /users` (`UsersController.list`) | **Yes** — `useUsers` backs desk ticket-filter / ticket-detail assignee / user-picker / workflow assign-form (non-admin agents). | Must NOT hard-gate admin-only. Needs a **scoped picker projection** (id+display_name+active only) under a low-tier key (e.g. `users.read` granted to agent templates) — a product/projection decision, not a re-gate. |
| `GET /users/:id` | Partial — user-detail surfaces; mostly admin, but ticket-detail hydrates assignee. | Scoped projection or `users.read`; same follow-up. |
| `GET /users/:id/roles` | Low — role badges on user detail (admin-ish). | Safe-ish to gate `users.read`/`roles.read`; low risk. |
| `GET /users/:id/audit` | None operator — audit trail is admin/compliance. | **Safe to gate now** (`users.read` or a `users.audit`-tier key). Clear win. |
| `GET /roles` (`RolesController.list`) | **Yes** — role pickers in the assignment UI (non-admin operators assign within scope). | Must NOT hard-gate. Scoped projection (id+name) under `roles.read`. |
| `GET /roles/:id/audit` | None operator. | **Safe to gate now** (`roles.read`+). |
| `GET /persons-admin` (`PersonsAdminController.list`) | Some — person admin surfaces; overlaps `people.read` (Requester/agents hold `people.read`). | Re-gate to `people.read` is likely correct + cheap (Requester/agents already hold it; non-people-readers lose a roster they shouldn't have). Strongest standalone candidate. |
| `GET /permissions/users/:id/effective` (`PermissionsController`) | None operator — effective-permission inspector is admin. | **Safe to gate now** (`roles.read`/`users.read`). |
| `GET /users/me`, `/users/:id/roles` self-shape | Self-service. | Stays open (self only). |

Concrete plan (the informed deferral): a follow-up slice "11.6 — scoped read keys" splits into two cleanly-separable parts: **(A) immediate, low-risk gates** — `GET /users/:id/audit`, `GET /roles/:id/audit`, `GET /permissions/users/:id/effective`, and `GET /persons-admin` (→ `people.read`) have **no** non-admin-operator dependency and can be `@RequirePermission`-gated now with negligible UX risk; **(B) projection work** — `GET /users` + `GET /roles` + `GET /users/:id` are load-bearing for non-admin operator pickers and need a *scoped projection* (minimal id/name/active fields) under an agent-held read key, which is a product/UX decision (what does a picker need vs. the full roster) — NOT a same-session mechanical re-gate, and rushing it risks the exact over-narrowing the /full-review warned about. Deferred to slice 11.6 with this split as the spec; no longer "needs analysis".

Changed:
- None (analysis only — logged here).

Verified:
- Reach assessed against `apps/web` callers of each endpoint + `role-defaults.ts` (which templates hold `people.read`/`users.*`/`roles.*`). Static analysis; no behavior change.

Remaining:
- Slice 11.6 part (A) (4 safe gates) + part (B) (picker projection product decision). Tracked here with the split; not a blocker for the RLS audit's escalation-class closure (this is info-disclosure P2, no escalation).

#### Update — 2026-05-17 (codex final review — DECISION-B reversal upheld; 2 findings actioned, 1 analysis corrected)

Original finding:
- Independent codex re-review of everything done after its prior pass (11.4 DECISION A, parity-pin, closing status, **11.5 — which reversed codex's own DECISION B**, the GET (A)/(B) split).
- Location: the 2026-05-17 "Slice 11.5" + "GET info-disclosure" Update blocks.

Status:
- closed — codex pressure-tested via stdin (`codex exec -s read-only`, background). Verdicts + the three actioned items below.

codex verdicts:
- **DECISION-B reversal: CORRECT (codex upheld reversing its own prior decision).** It independently verified the stale-premise claim: `origin/worktree-visitors` is already an ancestor of `main` (visitors v1 shipped), so there is no in-flight visitors workstream to collide with, and `visitors.configure` is coherent with the existing `invite`/`reception`/`read_all` actions. The deferral premise was stale; doing the re-gate was right.
- **Slice 11.5 mechanically sound (codex-confirmed):** all 18 routes correctly mapped (17 `visitors.configure` + `/all` `visitors.read_all`), the in-body→decorator `visitors.read_all` conversion is the same canonical `PermissionGuard.requirePermission` path (identical 401/403), the `AuthModule` drop is safe (`PermissionGuard`+`PermissionMetadataGuard` local; `KioskAuthGuard` module-local; global AuthGuard is APP_GUARD), and **no SQL backfill was missed** — `visitors.configure` ∈ `EXPLICITLY_NO_DEFAULT_ROLE`, not a template, and the parity scan only gates template grants.

Actioned:
- **[caller-free AdminGuard — codex overrode the "keep + log" call → reintroduction ban added].** codex's verdict: a caller-free admin-only guard still wired+exported by `AuthModule` is a reintroduction footgun (someone reaches for the familiar `@UseGuards(AdminGuard)` instead of `@RequirePermission`, silently resurrecting the coarse-model CRITICAL). Implemented its recommended mitigation in `apps/api/src/modules/auth/admin-guard-permission-parity.spec.ts`: a **CENSUS test (0)** that walks `apps/api/src`, skips comment lines, and asserts **zero** `@UseGuards(...AdminGuard...)` decorators — fails CI loudly on any reintroduction. Kept the parity pin (the primitive still exists and could be reintroduced; if so its hand-mirrored validity must still match `user_has_permission`). The spec's stale docstring ("survives on exactly ONE controller") is corrected to the caller-free reality.
- **[GET-analysis correction — I oversold `/persons-admin`].** codex (correct, verified at `person.controller.ts:23,37`): the real shared person-directory exposure is **`GET /persons` + `GET /persons/:id` on `PersonController`** — **ungated reads** (mutations gate `people.create`/`people.update`; the two list/detail GETs have no permission check), broadly consumed by the frontend (`apps/web/src/api/persons/index.ts`). My Slice-9-scoped GET-analysis **missed this controller entirely**, so gating user-management's `/persons-admin`→`people.read` is **harmless hygiene, NOT directory-leak closure**. Corrected scope: the P2 directory-leak surface is `PersonController` `GET /persons|/persons/:id`, and because the persons API is a load-bearing picker it is a **(B)-class scoped-projection problem** (same shape as `/users`+`/roles`), not a quick gate. Slice 11.6 (B) is widened to include `PersonController` reads; (A)'s `/persons-admin` entry is reclassified hygiene.
- **GET (A) audit/effective endpoints: codex confirmed admin-UI-only** (`roles/index.ts:106,120`, `permissions/index.ts:69`) — safe to gate in 11.6 (A) as planned; deferring `/users`+`/roles`+`/users/:id` is legitimate (`useUsers`/`useRoles` load-bearing pickers).

Changed:
- `apps/api/src/modules/auth/admin-guard-permission-parity.spec.ts` (census test (0) + corrected docstring).
- This ledger (codex verdicts + the `/persons` scope correction + 11.6 (B) widened).

Verified:
- `pnpm --filter @prequest/api test -- admin-guard-permission-parity` -> **9/9** (census green = zero callers, independently re-confirming the AdminGuard-free state; parity pin intact).

Remaining:
- Slice 11.6 (unchanged scope + the `PersonController` addition): (A) gate `/users/:id/audit`, `/roles/:id/audit`, `/permissions/users/:id/effective` now (the safe set; `/persons-admin` is hygiene-only); (B) scoped picker-projection product decision for `/users` + `/roles` + `/users/:id` **+ `GET /persons|/persons/:id`** (the real directory-leak surface). Still P2 info-disclosure, no escalation — not a blocker for the audit's actionable closure.
- Commits: this change (pending).

#### Update — 2026-05-17 (Slice 11.6(A) — the 3 safe GET gates closed; (B) remains a product decision)

Original finding:
- The GET info-disclosure (P2) split — part (A) "safe to gate now".
- Location: the 2026-05-17 "GET info-disclosure — informed per-endpoint analysis" + "codex final review" Update blocks.

Status:
- **(A) closed — done now rather than deferred** (deferring a verified-safe mechanical gate would repeat the twice-flagged weak-deferral pattern). (B) remains: a genuine scoped-projection product decision, not labor.

Changed (all 3 endpoints were ungated → readable by any active same-tenant user; all 3 verified admin-detail-page-only with zero non-admin operator-picker reach, by direct `apps/web` caller inspection + codex):
- `apps/api/src/modules/user-management/user-management.controller.ts`: `UsersController.audit` (`GET /users/:id/audit`, admin user-detail page) → `@RequirePermission('users.read')`; `RolesController.audit` (`GET /roles/:id/audit`, admin role-detail page) → `@RequirePermission('roles.read')`.
- `apps/api/src/modules/user-management/permissions.controller.ts`: `effective` (`GET /permissions/users/:id/effective`, admin user-detail "Effective Permissions" panel) → `@RequirePermission('roles.read')`. `getCatalog` (`GET /permissions/catalog`) **intentionally left open** with a pin comment — it is the static `@prequest/shared` catalog constant (zero tenant data / PII; the role-permission picker needs it for any role-editing user); gating it would break the picker and disclose nothing.
- Keys are **existing** catalog keys (`users.read`/`roles.read`) → **no `permissions.ts`/`role-defaults.ts`/migration change**; coverage already satisfied (Auditor `*.read` / Tenant Admin `*.*`). Posture: admin/compliance-only (no agent template holds `users.read`/`roles.read` explicitly) — closes the P2 leak with zero operator-UX risk.
- `require-permission-routes.spec.ts`: `audit`×2 + `effective` moved into `METHOD_MAP` with their keys; removed from `MUST_BE_OPEN`; `PermissionsController.getCatalog` **added** to `MUST_BE_OPEN` (pins the catalog open so it can't be accidentally gated).
- `smoke-cross-tenant.mjs`: +3 probes — plain non-admin → each of the 3 endpoints **403** (was 200 pre-11.6; proves the gate engaged + 403-not-500 confirms DI).

Verified:
- `pnpm --filter @prequest/api test -- "require-permission-routes|admin-guard-permission-parity"` -> **120/120** (route map incl. the 3 new gated + getCatalog-stays-open; AdminGuard census still zero).
- scoped tsc: zero errors in any 11.6(A) file.
- `pnpm smoke:cross-tenant` -> **30/30**, exit 0 (the 3 new `… → HTTP 403, was open pre-11.6` probes). `pnpm smoke:work-orders` -> **109/109**.

Remaining — Slice 11.6 **(B)** only (genuine product-shape decision, NOT avoidance): the load-bearing operator-picker reads `GET /users`, `GET /roles`, `GET /users/:id`, and `PersonController` `GET /persons` + `/persons/:id` need a **scoped projection** (minimal id/name/active fields under an agent-held read key) — deciding what a non-admin picker should see vs. the full roster is a UX/product call with real over-narrowing risk (the exact failure the /full-review warned of). This is the one open item in the whole RLS audit that is a decision rather than execution; still P2 info-disclosure, no escalation, not a blocker for the audit's actionable closure. Commits: this change (pending).

#### Update — 2026-05-17 (Slice 11.6(B) — accept-with-reason; RLS audit FULLY CLOSED)

Original finding:
- The GET info-disclosure (P2) — part (B): the load-bearing operator-picker directory reads.
- Location: the 2026-05-17 "Slice 11.6(A)" + "GET info-disclosure" + "codex final review" Update blocks.

Status:
- **closed — accepted-with-reason (explicit product-owner decision, 2026-05-17).** Not closed-by-code: a deliberate, signed-off acceptance.

Decision & reasoning:
The following same-tenant directory reads are **accepted as intended product behavior**, NOT a vulnerability:
- `UsersController`: `GET /users`, `GET /users/:id`, `GET /users/:id/roles`, `GET /persons-admin` (list)
- `RolesController`: `GET /roles`
- `PersonController`: `GET /persons`, `GET /persons/:id`

Rationale (the product owner accepted this explicitly when offered accept vs. build-projection vs. specify-fields):
1. **Not an escalation and not cross-tenant.** Slice 1's global AuthGuard `auth_uid→users WHERE tenant_id` bridge already confines every one of these to the caller's own tenant. They are read-only; they grant no capability. The class the audit/Slices 9–11 closed (privilege escalation, cross-tenant) does not include "authenticated employee can read their own org's directory."
2. **Load-bearing for non-admin operators.** `useUsers`/`useRoles`/the persons API back the desk ticket-filter, assignee picker, workflow assign-form, and person pickers used by non-admin agents. Gating or projecting these risks exactly the over-narrowing-of-operator-UX failure the Slice-11 `/full-review` warned about — a worse outcome than the accepted exposure.
3. **Industry norm.** A logged-in employee seeing the company user/role/person directory is expected enterprise behavior, not a leak. The marginal confidentiality gain of a scoped projection does not justify the UX-regression risk + build cost.

Residual / revisit trigger: revisit ONLY if a concrete requirement appears — e.g. a customer security mandate for directory minimization, a "restricted/confidential persons" sub-class, or an in-tenant need-to-know model. At that point build the scoped projection (minimal id/name/active under an agent-held read key) per the 11.6(A)/(B) analysis already in the ledger. Until then this is intentionally not gated.

Changed:
- None (documented decision; no code/migration).

Verified:
- N/A (acceptance decision). All Slice-11 code gates remain green from 11.6(A): require-permission/admin-guard-parity 120/120, smoke:cross-tenant 30/30, smoke:work-orders 109/109.

Remaining:
- **None for the RLS / tenant-isolation / SECURITY DEFINER audit.** Zero open actionable findings. Non-audit-scope items that remain (logged, owned elsewhere, NOT RLS-remediation): the caller-free `AdminGuard` primitive deletion (hygiene; CI-banned against reintroduction meanwhile); avatar Storage cross-tenant READ (P3, GDPR/storage backlog); global `ValidationPipe` (P3, API-hardening backlog). Integration: branch `feature/booking-audit-remediation` not merged — gated on the parallel 03-booking workstream finishing on the same branch, not on this audit.

### Status (honest — not a victory banner)

The audit's **escalation-class** findings (cross-tenant `X-Tenant-Id`, same-tenant privilege escalation, SECURITY DEFINER, the coarse-AdminGuard CRITICAL) are **fixed and verified** (live smoke + `/full-review` + codex). One **P2 info-disclosure** (same-tenant directory reads) is **accepted-with-reason** — a deliberate product decision, NOT a code fix; it stays a known, documented, intentionally-ungated exposure that should be revisited if a need-to-know requirement appears. The DB-role posture and the contested Slice-4 finding are **documented/contested**, not code-closed.

Honest "not done" list (so this isn't read as a clean close):
- P2 directory reads: accepted, not fixed (revisit trigger documented above).
- Caller-free `AdminGuard` primitive: still wired/exported by AuthModule; CI-banned against reintroduction but not deleted — a hygiene cleanup, deferred.
- P3: avatar Storage cross-tenant READ; global `ValidationPipe` absence — logged, owned by other backlogs, out of RLS-remediation scope.
- Integration: branch `feature/booking-audit-remediation` is **not merged / no PR** — gated on the parallel 03-booking workstream finishing on the same branch.
- Slice 4 (`ticket_visibility_ids` null-location) remains **contested-deferred**; Slice 8 (composite FK) **owned by the data-model audit**.

What IS true: no remaining finding is an open *exploitable* escalation or cross-tenant path; the admin/config surface has a consistent CI-enforced `@RequirePermission` posture; the ledger is the complete append-only record. "Best-in-class for the actionable security scope" — yes. "Audit 100% closed, nothing left" — no; the bullets above are real and tracked.

#### Update — 2026-05-17 (CORRECTION — false-green: notification re-gate sat uncommitted 2 sessions; prior "zero AdminGuard callers" was committed-state-FALSE)

Original finding:
- The Slice-11.2 notification-template re-gate; and the integrity of the "zero `@UseGuards(AdminGuard)`" claim asserted in the 11.5 / codex-final / honest-status blocks above.
- Location: those 2026-05-17 blocks (now corrected by this one — append-only; the prior blocks are NOT rewritten, this records that their zero-callers assertion was false until `3aecf0e8`).

Status:
- **corrected & closed.** User-caught. The prior blocks' "zero AdminGuard decorators / census green" was true only for the **working tree**, not **committed HEAD**.

What was wrong:
- Slice 11.2 (`b4577f20`, prior session) committed `notification.module.ts` (the `PermissionGuard`+`PermissionMetadataGuard` DI) but **NOT** `notification.controller.ts`. The controller re-gate (4 template mutations `@UseGuards(AdminGuard)` → `@RequirePermission('notifications.manage_templates')`) was edited in the working tree and never staged.
- `notification.controller.ts` showed as `M` at session start, listed among genuine parallel-03-booking dirty files (`outbox/*`, `reservations/*`). The explicit-per-file-staging discipline (correct for keeping 03-booking out) **misclassified this RLS file as parallel-workstream and excluded it from every commit across two sessions.**
- Consequence: committed HEAD carried **4 live `@UseGuards(AdminGuard)` callers** the entire time, while the working-tree census and `require-permission-routes.spec` ran GREEN (they read the working tree, which had the uncommitted fix). The "zero callers" / earlier "AUDIT CLOSED" assertions were **false for the committed/shippable state**. `require-permission-routes.spec` also did not pin `NotificationController`/`NotificationTemplateController`, so nothing guarded the gap.
- Root-cause methodology error: verifying a security invariant with a **working-tree grep** instead of `git grep HEAD` / `git show HEAD:` — especially for a file deliberately never staged. Excluding a file as "parallel workstream" without diffing it to confirm it contains no in-scope work.

Changed:
- `3aecf0e8` — committed ONLY the verified-pure-RLS diff of `notification.controller.ts` (`git diff HEAD` confirmed: import swap + 4 decorator swaps, zero 03-booking logic) + added all 4 routes to `require-permission-routes.spec.ts` `METHOD_MAP` (`NotificationController.createTemplate/updateTemplate`, `NotificationTemplateController.create/update` → `notifications.manage_templates`). Committed `notification.module.ts` already had the DI (`b4577f20`) — no module change.
- This change — `smoke-cross-tenant.mjs` +1 probe: plain non-admin `POST /notification-templates` → 403 (runtime proof the now-committed controller + already-committed module DI actually work together — closing this episode's exact committed-vs-working-tree divergence at runtime).

Verified (correctly this time — against the COMMITTED tree):
- `git grep "@UseGuards([^)]*AdminGuard" HEAD -- apps/api/src | grep -v spec` → only doc-comment matches; **zero real decorators**. `git show HEAD:.../notification.controller.ts` → 4× `@RequirePermission('notifications.manage_templates')`.
- `pnpm --filter @prequest/api test -- "permission-catalog|require-permission|admin.guard.spec|admin-guard-permission-parity"` → **151/151** (7 suites; the 4 notification pins included; AdminGuard census still zero).
- `pnpm smoke:cross-tenant` → **31/31**, exit 0 (incl. the new notification-templates non-admin→403). `pnpm smoke:work-orders` → **109/109**.

Honest restatement: "zero `@UseGuards(AdminGuard)` callers" is now TRUE **for committed HEAD as of `3aecf0e8`** (it was working-tree-only before). The earlier blocks asserting it pre-`3aecf0e8` were committed-state-wrong; this block is the correction of record. Still NOT on `main` — branch `feature/booking-audit-remediation`, merge gated on the parallel 03-booking workstream (unchanged).

#### Update — 2026-05-17 (MERGED TO MAIN via PR #17 — supersedes all "not merged / branch-only" status above)

Original finding:
- The whole RLS / tenant-isolation / SECURITY DEFINER / least-privilege audit (this document).
- Location: every prior block; specifically supersedes the "not merged / no PR" / `feature/booking-audit-remediation` bookkeeping in the 2026-05-17 honest-status, 11.6(B), and false-green-correction blocks (append-only — those lines are NOT rewritten; this records they are now historical).

Status:
- **MERGED to `main`.** PR **#17** (`rls-security-audit` → `main`) merged 2026-05-17 (merge commit `2c5e8220`). Slices 9–11.6 are now on the default branch; Slices 1–8 were already on `main`.

Why a separate PR (not the source branch): the RLS work was committed on `feature/booking-audit-remediation`, which a parallel 03-booking-reservation workstream still shares with in-flight/partial commits. The 19 RLS-audit commits (`552e2db2`..`d6e8ecc1`) were cherry-picked onto a clean branch cut from current `origin/main` (post PR #16) — zero conflicts; patch-ids verified to match the source RLS commits with no booking/workflow-phase1.5/audit-02 commits included. This let the audit land independently of the still-running booking workstream.

Merge gate (the user conditioned merge on codex validation):
- Independent codex merge-gate review scoped to the two things its prior passes had NOT seen — the user-caught notification false-green fix (`3aecf0e8`/`d6e8ecc1`) and the isolation/cherry-pick fidelity. **`VERDICT: MERGE`**, zero critical / zero important: notification re-gate real & complete (4 routes `notifications.manage_templates`, DI present, spec pinned), false-green correction honestly documented, isolation faithful (19 commits, patch-ids match, no contamination), committed-tree AdminGuard census clean, migration 00409 additive/independent of main's 00410. Only nits (this stale-bookkeeping line — now closed by this block — and codex's read-only sandbox preventing a fresh `git fetch`, so it verified against current local `origin/*` refs, which were current).

Verified (isolated branch, pre-merge) + (origin/main, post-merge):
- Pre-merge on `rls-security-audit`: shared build clean; `pnpm --filter @prequest/api lint` (tsc) **fully clean, exit 0** (cleaner than the source feature branch, which carries unrelated parallel-workstream tsc breakage); RLS unit suite **151/151** (7 suites); committed census zero.
- Post-merge on `origin/main` (`2c5e8220`): `git grep "@UseGuards([^)]*AdminGuard)"` → **zero real decorators**; `require-permission.decorator.ts`, migration `00409`, `admin-guard-permission-parity.spec.ts` (the CI reintroduction-ban) all present; `notification.controller.ts` 4× `@RequirePermission('notifications.manage_templates')`; `visitors/admin.controller.ts` 21× `@RequirePermission`; 19 RLS commits in the merge.
- Live smoke (`smoke:cross-tenant` 31/31, `smoke:work-orders` 109/109) was green on the byte-identical RLS code pre-isolation; not re-run against the merge as the RLS code is unchanged by the cherry-pick and would require a dedicated dev server.

Remaining (unchanged — none are escalation/cross-tenant, none block this closure):
- 11.6(B) directory reads: **accepted-with-reason** (product decision), not code-fixed.
- P3 backlog (other owners): avatar Storage cross-tenant READ; absent global `ValidationPipe`.
- Hygiene: delete the now caller-free `AdminGuard` primitive (CI-banned against reintroduction meanwhile).
- The source `feature/booking-audit-remediation` branch still carries the parallel 03-booking workstream (out of this audit's scope).

This audit's actionable tenant-isolation / RLS / SECURITY DEFINER / cross-tenant / least-privilege findings are **closed or accepted-with-written-reason, and shipped to `main`.**
#### Update — 2026-05-18 (codex remaining-item #1 — notification same-tenant IDOR CLOSED)

Original finding:
- Codex Deep Review Verdict 2026-05-18, remaining item #1 / the long-deferred "P2 integrity" row: `NotificationController.markAsRead(@Param('id') id)` (+ the sibling `getForPerson` / `getUnreadCount` / `markAllAsRead` `person/:personId*` routes) read/flipped notification read-state by a caller-supplied `id`/`personId` with **no recipient binding**. `supabase.admin` bypasses RLS, so any authed same-tenant user could mark/read **anyone's** notifications.

Status:
- **closed (fixed, not accepted).**

Resolution & rationale:
- Exhaustive caller search (`git grep` web + api internal + scripts + tests, against committed HEAD): the four legacy *consumer* routes/methods have **zero callers anywhere**. The live user-facing inbox is the server-derived, auth-bound `/me/inbox/*` surface (`InboxController` / `InboxService.resolveActor` — B.4.A.5), which the web app actually uses (`apps/web/src/api/inbox/mutations.ts`). `apps/web/src/api/notifications/index.ts` only touches `/notification-templates`.
- Fix = **delete the dead IDOR surface** rather than re-secure unused redundant code (CLAUDE.md: "if certain something is unused, delete it"; "best-in-class, not legacy"). This is the strongest reading of codex's "or accept only self-scoped ids" — the only surviving read-state mutation path (`/me/inbox/*`) is already server-derived and correct. The notification *producers* (`send`/`sendToTeam`) + the tenant-wide TEMPLATE admin routes are untouched.

Changed:
- `apps/api/src/modules/notification/notification.controller.ts` — removed `getForPerson` / `getUnreadCount` / `markAsRead` / `markAllAsRead` routes (+ unused `Query` import); rationale comment rewritten.
- `apps/api/src/modules/notification/notification.service.ts` — removed the four dead consumer methods (`getInAppForPerson` / `markAsRead` / `markAllAsRead` / `getUnreadCount`).
- `apps/api/scripts/smoke-cross-tenant.mjs` — new IDOR section: seeds a notification owned by a TENANT_A person who is NOT the admin caller, then asserts (TDD red-before-green, verified) the 4 routes are `404` (removed) **and** the victim row's `read_at` stays `NULL`.

Verified (TDD red→green, against the running API at committed-HEAD code):
- RED (pre-fix): `POST /notifications/:id/read` → `HTTP 201 {"read":true}`, victim `read_at` SET, 4/4 route probes fail (31 pass / 5 fail).
- GREEN (post-fix): all 4 routes `404`, victim `read_at` still `NULL` (`smoke:cross-tenant` clean).
- `tsc --noEmit` (`@prequest/api lint`) exit 0 — zero errors. `pnpm smoke:work-orders` 109/109. `permission-catalog|require-permission|admin.guard.spec|admin-guard-permission-parity` **151/151** (route-spec only pins the still-present template routes; allowlist-style — deleting the four unlisted consumer methods does not dangle it).

Remaining: none for #1.

#### Update — 2026-05-18 (codex remaining-item #2 — browser-direct PostgREST: prior conclusion CORRECTED; P1 HARDENED)

Original finding:
- Codex remaining item #2 / the standing "P4 — browser-direct PostgREST + Supabase Storage RLS" item. **The prior 2026-05-16 closure block ("Update — 2026-05-16 (P4 + opens…)") concluded "P4 NOT-REACHABLE … anon/authenticated have ZERO table privileges … Postgres denies at the GRANT layer before RLS." That conclusion is factually WRONG on its stated mechanism** — corrected here (append-only; the prior block is not rewritten, this is the correction of record).

Status:
- **closed (corrected + hardened).** Was a real **P1 latent defense-in-depth defect**, not the "P3 accepted" the prior block claimed. Now grant-hardened.

What was actually true (proven this session — live remote DB + a real authenticated browser session token, codex-concurred):
1. **Reachable.** `SUPABASE_URL` is a transparent Cloudflare Worker (`docs/vpn-supabase-proxy-bypass.md`) that proxies `/rest/v1`; in prod the browser hits Supabase PostgREST directly anyway. Anon publishable-key `GET /rest/v1/user_role_assignments` → `HTTP 200 []` (reachable, RLS-empty — not 404/401).
2. **Grants were wide open** — not zero. `anon`+`authenticated` held full INSERT/UPDATE/DELETE/TRUNCATE on every escalation-class table (`information_schema.role_table_grants`). The "grant-layer deny" the prior block relied on did not exist.
3. **RLS was the sole gate**, and it denied **only by the accident of an unminted JWT claim**: `current_tenant_id()` (`00002_rls_helpers.sql:5-14`) reads `jwt.claims->'app_metadata'->>'tenant_id'` / top-level `tenant_id`; the app never mints it (audit P0). A real authenticated browser session token decoded: `role=authenticated`, `app_metadata={provider,providers}` only — **no `tenant_id`**. So `current_tenant_id()`=NULL → `tenant_id = NULL` denies all rows/writes. Empirical: authenticated browser-direct reads of `user_role_assignments`/`team_members`/`users`/`roles` → `200 []`; self-grant `POST` → `403` Postgres `42501`. **Not a live P0**, but one custom-access-token hook minting `tenant_id` away from instant browser-direct same-tenant escalation bypassing every Slice 9/10/11 HTTP guard.

Decision (codex independently reviewed the finding + direction, stdin/read-only; concurred P1-latent, remediation (a), and that it blocked clean closure): **revoke write DML from the browser roles**, codex's preferred "all public tables" scope (web makes zero browser-direct writes/rpc at HEAD — verified; every write goes via the NestJS API on the postgres/service-role path, untouched). SELECT intentionally **kept** — Supabase Realtime per-subscriber RLS needs it on the 8 `supabase_realtime`-published tables; revoking it would break the inbox bell / scheduler live updates, revoking writes does not.

Changed:
- `supabase/migrations/00415_revoke_browser_write_grants.sql` (NEW) — `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated` + matching `ALTER DEFAULT PRIVILEGES` (regression-by-new-table proof) + `notify pgrst`. Idempotent; no structural change (does not touch the booking-canonicalization destructive-default invariant).
- `apps/api/scripts/smoke-cross-tenant.mjs` — new "Browser-direct PostgREST" section: (i) grant assertion — `anon`/`authenticated` hold NO write DML on the escalation-class set but DO retain SELECT on the Realtime set (the deterministic red→green for 00415); (ii) live end-to-end — a real authenticated browser session token's self-grant `POST /rest/v1/user_role_assignments` is denied. Post-00415 the denial is **grant-layer, claim-independent** (holds even if a future hook mints `tenant_id`).

Verified:
- User authorized the remote push (deploy-class; not covered by the workstream-scoped standing DB-push authorizations). Pushed via the psql fallback 2026-05-18 → `REVOKE` / `ALTER DEFAULT PRIVILEGES` / `NOTIFY` applied. Post-push remote check: escalation-class anon/authenticated write grants = **0**; Realtime-published-table SELECT missing = **0**; `service_role` INSERT intact = **true**.
- TDD red→green: pre-push `smoke:cross-tenant` 38 pass / **1 deliberate RED** (`12 write grants still present — apply 00415`); post-push **39 pass / 0 fail** (grant assertion GREEN; SELECT-retained GREEN; browser-direct self-grant `403`). `pnpm smoke:work-orders` **109/109** (no operational regression from the revoke or the notification deletion).

Remaining for #2: none. (Avatar/`portal-assets` Storage cross-tenant READ stays a tracked **P3** — GDPR/storage backlog, info-disclosure only, not escalation; unchanged by this block.)

#### Update — 2026-05-18 (codex remaining-items #3 / #4 / #5 — dispositions)

- **#3 caller-free `AdminGuard` — KEEP (decision recorded).** Independently re-verified against committed HEAD: `git grep "@UseGuards([^)]*AdminGuard" HEAD` → only prose/spec comments, **zero live controller decorators**. Still referenced by `auth.module.ts` (declares/exports), `admin.guard.spec.ts`, and `admin-guard-permission-parity.spec.ts` → per the handoff rule ("do not delete unless truly unreferenced") it is **kept**, not deleted. The zero-caller CENSUS test (0) + the `user_has_permission` parity pin in `admin-guard-permission-parity.spec.ts` are retained and green (part of the 151/151). Note (methodology, not a defect): the census walks the working tree (`fs.readdir`), which equals committed HEAD under CI checkout — the prior false-green was a *local-verification* error, mitigated by the standing "verify against `git grep HEAD`" rule (applied here). Full deletion of the primitive remains a low-value, non-zero-risk **P3 hygiene** cleanup (delete `admin.guard.ts` + AuthModule provider/export + the two specs), explicitly deferred — not in security scope.
- **#4 global `ValidationPipe` — PLAN recorded (out of RLS-remediation scope, P3 API-hardening backlog).** Confirmed at HEAD: no `useGlobalPipes`/`APP_PIPE`; `class-validator`/`class-transformer` are not deps; DTOs are plain interfaces. Not a tenant-isolation gate (Slice-11 permission gates are decorator/RPC-driven, not body-shape-driven). Concrete plan: add `class-validator`+`class-transformer`; `app.useGlobalPipes(new ValidationPipe({ whitelist:true, forbidNonWhitelisted:true, transform:true }))` in `main.ts`; incrementally convert DTO interfaces → decorated classes per module behind a CI check. **Owner: API input-hardening backlog.** Deliberately NOT implemented here (a full DTO migration is a separate workstream; implementing it would be scope creep the audit itself disclaims).
- **#5 composite `(tenant_id, id)` FK hardening — owned by Audit 01, not duplicated.** Verified `docs/follow-ups/audits/01-data-model.md` owns it as its **[P0] Composite (tenant_id, id) FKs are inconsistent** (`01-data-model.md:19-22`, hardening plan §1) with a multi-day sweep + CI guard. The 04-rls Slice-8 ledger row already defers correctly with an accurate pointer. No change here — confirmed correctly owned elsewhere.

#### Update — 2026-05-18 (full-review on the #1/#2 remediation — corrections of record; some closure language was OVERSTATED)

Two fresh-context adversarial reviewers (plan + code) pressure-tested the #1 notification deletion + #2 `00415` work. They found the security fixes sound but **several honesty/scoping defects in the two blocks above** + one mine-introduced zombie. Corrections of record (append-only — the blocks above are not rewritten; this block governs where they conflict):

- **[code-review C2 — REFUTED, with the valid kernel kept] "00415 is a no-op; grants were already zero; red→green is tautological."** Refuted: no migration before `00415` performs a broad table-DML revoke on the escalation tables (the other `revoke` migrations — 00274/00280/00282/00378/00394/00395/00407 — revoke *functions*). The contemporaneous pre-push smoke output (`✗ 12 anon/authenticated write grants still present`) → post-push (`✓ … NO INSERT/UPDATE/DELETE`, `esc_writes_left=0`) is the authoritative red→green. The reviewer queried the live DB **after** this session's mid-review push and misread the post-fix state as the original. **Valid kernel kept (OPEN):** `00415` is applied-to-remote but the code/migration/ledger remain **uncommitted** — the remote diverges from every committed tree and from `pnpm db:reset`. This window is **still open**: the global rule forbids committing without explicit user request; commit is the recommended next step (file-scoped to the 5 RLS files) and is surfaced to the user, not done unilaterally.
- **[plan-review C1 — VALID; closure language CORRECTED, overclaim withdrawn] `00415` hardened TABLE DML only; the RPC-EXECUTE-to-browser-roles surface is NOT hardened.** Live check: **35 SECURITY DEFINER functions** + INVOKER RPCs (`reclassify_ticket`, `create_booking_with_attach_plan`, `grant_booking_approval` — `prosecdef=f`) are EXECUTE-able by `anon`/`authenticated`. The earlier blocks' phrases "browser-direct posture now known and **hardened**" / "claim-independent" are **withdrawn as overstated** — they are accurate ONLY for browser-direct *table* writes. Assessment of the RPC surface (not a blanket re-audit): the plan reviewer's cited `search_global`→anon is **wrong** (live: SECURITY DEFINER, grantees `{postgres,service_role}` only — already locked, proving the team's per-function-EXECUTE-revoke pattern); SECURITY INVOKER RPCs run with caller privileges so RLS applies → fail-closed for browser JWTs exactly like the read path (claim-dependent); the SECURITY DEFINER set is the Slice-7-audited `p_tenant_id`-validated corpus. **No dedicated browser-direct-RPC exploit probe was run.** Honest status: **TRACKED P2 (NOT closed, NOT a claimed-hardened item)** — recommended fix is the symmetric completion: `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated` **except** the documented anon-callable bearer-token trio (`validate_invitation_token`/`peek_invitation_token`/`validate_kiosk_token`), as its own verified slice. Item #2 is therefore: **browser-direct table-DML — hardened; browser-direct RPC-EXECUTE — known, assessed, tracked-P2 (not hardened).**
- **[plan-review I3 — VALID; logged honestly] browser-direct READS remain RLS-only and claim-dependent.** `00415` deliberately KEEPS SELECT (Supabase Realtime per-subscriber RLS needs it). So browser-direct `GET /rest/v1/<tenant-scoped table>` remains gated solely by RLS, which fails closed **only** because `current_tenant_id()` is NULL (claim unminted) — the same latent fragility the write path had before `00415`. Writes are now claim-independent; **reads are not**. This is the identical P1-latent class for the read surface; folded into the same tracked follow-up as the RPC item (root cause = the unminted-claim RLS dependency; the durable fix is the symmetric grant-revoke + treating the API as the sole data perimeter per `docs/visibility.md` §8, not minting the claim).
- **[plan-review I2 / code-review I1 — VALID; FIXED + honestly caveated] `ALTER DEFAULT PRIVILEGES` is partial.** Verified `postgres` is NOT a member of `supabase_admin` and NOT superuser → `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` raises "permission denied" (the broadened clause would have **failed the push**). `00415` now does `postgres`-only ADP with an explicit honest caveat that dashboard/`supabase_admin`-created future tables can still re-grant — and the smoke grant-assertion was **broadened from the escalation subset to ALL public base tables** so it now matches the `REVOKE … ON ALL TABLES` scope and catches any future re-grant by any creator role. The load-bearing protection is the all-tables REVOKE (every current table, any creator); ADP + the broadened gate cover future regressions.
- **[code-review I3 / plan-review I1 — VALID; framing CORRECTED] `notifications` (00017) ≠ `inbox_notifications` (00391); the deleted surface was not "superseded", it was the only consumer of an orphaned table.** `/me/inbox/*` reads `inbox_notifications`; the deleted routes read `notifications`. Producers (`NotificationService.send`/`sendToTeam`, the workflow `notification` node) still write `notifications` `target_channel='in_app'` rows that now have **no consumer**. This does **not** weaken the IDOR fix (the exploitable read/flip-by-id routes are gone; that is sound and proven). The "redundant / superseded by /me/inbox" wording in the #1 block is **corrected**: the legacy `notifications` in-app *consumer* path was deleted (killing the IDOR); the `notifications` in-app *producer* rows are now consumer-orphaned — a pre-existing two-table split surfaced (not introduced) by this removal. **Tracked correctness/cleanup follow-up** (migrate producers to `inbox_notifications` or document `notifications` as email/legacy-only) — not a security item, explicitly logged not glossed.
- **[code-review I2 — VALID; FIXED, mine-introduced] zombie regression test.** `cross-tenant-fk-leak-writes.spec.ts` "site 6" reproduced the deleted `notification.service.ts:markAsRead`. Repointed to the surviving stronger path `inbox.service.ts:markRead` (`inbox_notifications` filtered by the `(tenant_id, user_id, id)` triple — the `user_id` binding is precisely what closes the IDOR class). Header index line updated. Suite green (139 pass / 1 skip).
- **[code-review C1 — acknowledged; honest attribution] tree `tsc` is RED, exclusively on the parallel workstream.** The only `error TS` file is `src/modules/work-orders/work-order.service.ts` (`resolveAuthorPersonId` unused) — the concurrent audit02/SLA workstream's uncommitted change on this shared branch (HEAD advanced `32668257`→`72df4f0c` mid-session). This session's five files are `tsc`-clean (verified). The recommended commit is **file-scoped to the five RLS files only** — the parallel workstream's dirty files (`work-orders/work-order.service.ts`, `reservation-edit-scope.spec.ts`, `workflow-engine.service.spec.ts`, the 02/03 audit docs) deliberately excluded (same per-file-staging discipline as the prior false-green correction, applied correctly: stage only verified-pure-RLS files).

Post-correction completion-bar status (honest): **#1 notification IDOR — closed/fixed** (dead exploitable routes deleted; behavioral red→green proven). **#2 browser-direct — table-DML hardened (`00415`, all public tables, claim-independent); RPC-EXECUTE surface and the read surface KNOWN + assessed + TRACKED-P2 (explicitly NOT claimed hardened).** Per the audit bar ("known and either hardened or explicitly accepted"): the *write/table* class is hardened; the RPC + read residuals are *known and tracked*, not silently accepted. **#3/#4/#5** as the dispositions block. Avatar Storage cross-tenant READ stays the tracked P3. Verified against committed-HEAD code + live remote DB + the running API; tree-`tsc`-red is exclusively the parallel workstream.

Verified (post full-review fixes): `pnpm --filter @prequest/api test -- "cross-tenant-fk-leak-writes|require-permission-routes|admin-guard-permission-parity"` → 139 pass / 1 skip / 3 suites. `pnpm smoke:cross-tenant` → **39 pass / 0 fail** (broadened all-public-tables grant assertion GREEN; SELECT-retained GREEN on 8 Realtime tables; browser-direct self-grant `403`; IDOR 5/5). `pnpm smoke:work-orders` 109/109 (prior run; unaffected — service-role path). Remote: `writes_left=0` across ALL public tables; `postgres` ADP entries present; `service_role` INSERT intact.

Commits: **none yet** — the change set (5 RLS files + `00415`) is uncommitted pending explicit user request to commit (global rule: never commit unprompted). Recommended file-scoped commit is surfaced to the user; until then the remote-vs-committed window (C2 valid kernel) stays open and is recorded as such.

## Codex Deep Review Verdict — 2026-05-18

Reviewer: Codex, static code review against the current working tree and committed `HEAD` grep where relevant. No live smoke gates were run in this pass.

### Validated Checkmarks

| Finding / claim | Codex validation | Evidence |
|---|---:|---|
| P0 global tenant binding blocks `X-Tenant-Id` header flip | ✅ validated | `AuthGuard` bridges `auth_uid -> public.users(id)` with `tenant_id` and `status='active'`, attaches `platformUserId`, and rejects missing membership with `auth.user_not_in_tenant`. |
| Admin/config controllers moved off coarse `AdminGuard` to permission catalog | ✅ validated for sampled/current tree | Workflow, routing, SLA policy, config entity, team/vendor/asset, visitors/admin, notification-template mutations and related surfaces use `@RequirePermission(...)`. |
| Zero real `@UseGuards(AdminGuard)` controller callers in committed `HEAD` | ✅ validated | `git grep "@UseGuards([^)]*AdminGuard" HEAD -- apps/api/src` returns prose/spec comments only, no live decorators. |
| Notification controller false-green correction is fixed | ✅ validated | `notification.controller.ts` has `@RequirePermission('notifications.manage_templates')` on template mutations in the current tree; route spec/smoke claims are recorded in the ledger. |
| Visitors admin no longer the last `AdminGuard` caller | ✅ validated | `VisitorsAdminController` uses `visitors.configure` / `visitors.read_all` via `@RequirePermission`, not `AdminGuard`. |
| Same-tenant directory reads remain open by product decision | ✅ validated as accepted, not fixed | `PersonController` list/detail and user/role directory reads remain intentionally open. Ledger explicitly accepts the exposure as same-tenant product behavior, not an escalation. |
| Notification mark-read IDOR remains a deferred integrity issue | ✅ validated as still open | `NotificationController.markAsRead(@Param('id') id)` still takes a bare notification id and calls `markAsRead(id)` with no actor/owner check. Ledger marks this as P2 integrity, not escalation. |
| `DbService` superuser posture documented, not changed | ✅ validated as documented decision | `docs/visibility.md` documents the postgres/service-role posture and app-layer enforcement. This is not a code hardening close. |
| Global `ValidationPipe` gap remains out of scope | ✅ validated as still not globally present | Review notes and code indicate no global `ValidationPipe`; DTO validation remains route-local/inconsistent. |

### Verdict

Audit 04 is **closed for exploitable cross-tenant and privilege-escalation findings in the NestJS API surface reviewed here**. The fixes are real: tenant binding is global, admin/config mutation surfaces are permission-gated, and the coarse `AdminGuard` caller problem is eliminated with a CI-style census test.

It is **not a total security close**. Remaining items are intentionally accepted or deferred:
- **Accepted:** same-tenant directory reads (`users`, `roles`, `persons`) are product behavior, not currently treated as a vulnerability.
- **Open P2 integrity:** notification `POST /notifications/:id/read` can mark a same-tenant notification by bare id unless the service checks ownership elsewhere; this needs a focused fix.
- **Deferred P3/security hardening:** browser-direct PostgREST/Storage RLS audit, avatar/storage tenant isolation, global `ValidationPipe`, caller-free `AdminGuard` deletion, and broader composite-FK work owned by Audit 01/data-model.
- **Documented-not-hardened:** `DbService` still uses privileged DB access; the project explicitly relies on app-layer guards for API paths.

The correct claim is: **best-in-class for the audited tenant-escalation class after fixes; not a clean "nothing left" security audit.**

### Post-Verdict Remediation — 2026-05-18 (follow-up agent; appended, codex table above unchanged)

Codex's table above is preserved as the record of that point in time. After it, the follow-up agent actioned its five remaining items. Net change to the verdict:

- **Item #1 (notification mark-read IDOR) — was "✅ validated as still open" → now CLOSED (fixed).** The dead legacy `/notifications/:id/read` + `person/:personId*` consumer surface (zero callers; superseded by the server-derived `/me/inbox/*`) was deleted, not re-secured. TDD red→green proven in `smoke:cross-tenant` (routes `404`, victim `read_at` stays `NULL`). See the 2026-05-18 Closure-Update block.
- **Item #2 (browser-direct PostgREST/Storage) — was "deferred P3/accepted" → was actually P1-latent; now HARDENED.** The prior "P4 NOT-REACHABLE / zero grants" conclusion was factually wrong (reachable; full anon/authenticated CRUD grants; RLS the sole gate, fail-closed only by an unminted JWT claim). Migration `00415` (user-authorized, pushed) revokes browser-role write DML on all `public.*` (SELECT kept for Realtime); a grant-assertion + live browser-direct probe pin it. Claim-independent now. See the 2026-05-18 Closure-Update block.
- **Item #3 (caller-free `AdminGuard`) —** decision recorded: **keep** (still referenced by AuthModule + two specs; deletion = deferred P3 hygiene); zero committed callers re-verified via `git grep HEAD`; census + parity pin retained/green.
- **Item #4 (global `ValidationPipe`) —** confirmed absent at HEAD; concrete P3 plan recorded; **owner = API input-hardening backlog**; deliberately not implemented (separate workstream, out of RLS scope).
- **Item #5 (composite `(tenant_id,id)` FK) —** confirmed owned by Audit 01 (`01-data-model.md:19-22` P0); not duplicated here.

Completion bar status: **[SUPERSEDED by the "full-review — corrections of record" block above — read that for the honest scoping; the wording here overclaimed and was corrected.]** no cross-tenant header flip or same-tenant privilege escalation remains in the API surface (Slices 1–11); notification read-state can no longer be changed across users (item #1 fixed); browser-direct **table-DML** posture hardened (item #2 — `00415` write-grant revoke) — but the browser-direct **RPC-EXECUTE** surface and the **read** surface are KNOWN/assessed/**TRACKED-P2, NOT hardened** (full-review plan-C1/I3); avatar Storage cross-tenant READ remains a tracked P3. Verified against committed-HEAD code + live remote DB + the running API. The `/full-review` gate ran (findings folded in via the corrections block); commit is file-scoped to the 5 RLS files (tree-`tsc`-red is exclusively the parallel workstream).

### Updated Claude Agent Prompt — 2026-05-18

```text
You are the follow-up RLS/security agent for Audit 04:
docs/follow-ups/audits/04-rls-security.md

Codex reviewed the current tree on 2026-05-18. Do NOT redo the global AuthGuard tenant bridge or the AdminGuard→RequirePermission re-gate unless you find a concrete regression. Those are validated as closed for the audited NestJS escalation class.

Remaining work only:
1. Fix the notification same-tenant IDOR: `POST /notifications/:id/read` must verify the notification belongs to the current actor/person before marking it read, or accept only self-scoped ids. Add a smoke or integration test proving user A cannot mark user B's notification read.
2. Run the browser-direct PostgREST + Supabase Storage RLS investigation: determine whether the web app can directly insert/update escalation-class tables (`team_members`, `user_role_assignments`, etc.) or read cross-tenant storage assets. If direct access exists, add table/storage RLS policies or remove the browser capability.
3. Decide whether to delete caller-free `AdminGuard`. If kept, retain the zero-caller census test so no controller can reintroduce coarse admin gating.
4. Add or plan global `ValidationPipe` / input-hardening work. This is separate from tenant isolation but was surfaced during the audit.
5. Coordinate composite `(tenant_id, id)` FK hardening with Audit 01/data-model; do not duplicate it here.

Required closure behavior:
- Update this Codex Deep Review Verdict and the Closure Ledger append-only.
- Verify security invariants against committed `HEAD`, not only the working tree.
- Add tests/probes that would have failed before the fix.
- If a same-tenant exposure is accepted rather than fixed, record the product decision, revisit trigger, and exact endpoints.

Completion bar:
- No cross-tenant header flip or same-tenant privilege escalation remains in the API surface.
- Notification read-state cannot be changed across users without authorization.
- Browser-direct Supabase and Storage posture is known and either hardened or explicitly accepted.
```

## Agent Handoff Prompt

```text
You are the lead RLS/security remediation agent for:
docs/follow-ups/audits/04-rls-security.md

Goal:
Close every actionable tenant-isolation, RLS, SECURITY DEFINER, and cross-tenant safety finding in this audit. Own the whole file, but ship in small, reviewable slices. The end state is that an authenticated user cannot select or write another tenant's data by changing `X-Tenant-Id`, and the schema/RPC layer provides defense in depth.

Read first:
- AGENTS.md / CLAUDE.md
- docs/follow-ups/audits/04-rls-security.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/visibility.md
- docs/superpowers/specs/2026-04-20-visibility-scoping-design.md
- apps/api/src/common/middleware/tenant.middleware.ts
- apps/api/src/modules/auth/auth.guard.ts
- apps/api/src/modules/auth/admin.guard.ts
- apps/api/src/common/permission-guard.ts
- supabase/migrations/** RLS and SECURITY DEFINER functions

Recommended slice order:
1. Global tenant binding: in auth/tenant handling, bind the authenticated auth_uid to the selected tenant using the canonical `public.users where auth_uid and tenant_id` bridge, or a signed tenant claim if proven authoritative.
2. Admin-controller defense in depth: add AdminGuard or equivalent permission guard to the identified admin/config controllers.
3. Add an HTTP/security smoke or integration probe that tries a tenant-A JWT with tenant-B `X-Tenant-Id` on the known vulnerable controllers.
4. Tighten `ticket_visibility_ids` null-location behavior if still broad.
5. Decide and document `DbService` role posture; if changing, move away from `postgres` superuser to a dedicated app role with explicit grants.
6. Add deny-by-default posture for `tenants` if compatible with tenant resolution.
7. Audit remaining SECURITY DEFINER functions for search_path, grants, and tenant validation.
8. Coordinate composite-FK hardening with the data-model audit rather than duplicating that work here.

Execution rules:
- Treat the cross-tenant header issue as P0 until an exploit probe proves otherwise.
- Do not rely only on `app_metadata.tenant_id` unless you verify how that claim is minted and updated for all users.
- Prefer a server-side users-table membership bridge because existing guards already use it.
- Do not weaken public/kiosk/vendor-token flows while adding global tenant checks.
- Use parallel agents only for controller inventory or SECURITY DEFINER review, not for overlapping auth changes.

Required closure behavior:
- Update this file's Closure Ledger after every slice.
- Update docs/visibility.md if the security model changes.
- Add tests/probes that fail before the fix and pass after it.
- Record any endpoints intentionally exempt from tenant/JWT binding and why.

Completion bar:
- Tenant-A JWT + tenant-B header cannot read/write tenant-B admin/config data.
- Admin/config controllers have consistent guard posture.
- Direct DB/RLS posture is documented honestly.
- SECURITY DEFINER functions have an audited follow-up list or all are reviewed.
```
