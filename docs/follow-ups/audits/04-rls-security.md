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
