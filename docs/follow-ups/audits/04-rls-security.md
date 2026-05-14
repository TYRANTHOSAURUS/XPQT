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
| 2026-05-14 | Slice 1 — Global tenant binding in AuthGuard (P0 §`X-Tenant-Id` header trusted) | **closed** | `apps/api/src/modules/auth/auth.guard.ts` (added auth_uid→users bridge after JWT verify, attaches `platformUserId` to `req.user`, rejects mismatch with 403 `auth.user_not_in_tenant`); `apps/api/scripts/smoke-cross-tenant.mjs` (new live-API gate); `pnpm smoke:cross-tenant` registered in root + apps/api `package.json` | `pnpm smoke:cross-tenant` 9/9 pass (regression: own-tenant 200, no-auth 401; attack: 6 admin GETs cross-tenant 403). `pnpm smoke:work-orders` 109/109 pass. `pnpm smoke:floor-plans` 21/0/4 pass. | Defense-in-depth slice (admin controllers) tracked as Slice 2. **Pre-existing failure NOT caused by Slice 1**: `smoke:edit-booking` 27/11 and `smoke:edit-booking-scope` 14/7 fail on HEAD identically with `edit_booking.actor_not_found` because `reservation.service.ts:1015,1332,1819` pass `actor.user_id` (= `public.users.id` per `dto/types.ts:343`) into `p_actor_user_id` where the RPC expects auth_uid (`supabase/migrations/00394_edit_booking_rpc_v5.sql:289-300`). Surfaced for the reservation owner — out of scope for the RLS audit. |
| 2026-05-14 | Slice 2 — defense-in-depth `@UseGuards(AdminGuard)` on 10 admin controllers (P0 §un-bridged admin controllers) | **closed** | `@UseGuards(AdminGuard)` added at class level on `workflow.controller.ts`, `routing.controller.ts`, `routing/policies.controller.ts`, `routing/space-groups.controller.ts`, `routing/domains.controller.ts`, `routing/location-teams.controller.ts`, `routing/domain-parents.controller.ts`, `webhook/webhook-admin.controller.ts`, `config-engine/config-entity.controller.ts`, `sla/sla-policy.controller.ts`. `AuthModule` added to `imports[]` of `workflow.module.ts`, `routing.module.ts`, `sla.module.ts`, `webhook.module.ts`, `config-engine.module.ts` so AdminGuard can be DI-resolved. `smoke-cross-tenant.mjs` augmented with 3 cross-tenant POST probes (write side of the attack vector). | `pnpm smoke:cross-tenant` 12/12 pass (3 new POST probes 403'd). `pnpm smoke:work-orders` 109/109 pass. | Closes the audit's secondary P0 (`04-rls-security.md:23-40`). With Slice 1 in place, AdminGuard runs ONLY when AuthGuard already passed the bridge — so the failure mode of "admin in tenant A flips header to tenant B and is admin in tenant B too" is now blocked at AuthGuard (no users row in tenant B → 403) BEFORE AdminGuard. AdminGuard remains as belt+suspenders if Slice 1 regresses, AND as the gate for non-admin same-tenant users (slice 3 will add a same-tenant non-admin probe; that requires a second auth fixture which we don't seed yet). `buildings.controller.ts` was named by the audit but kept un-AdminGuarded — `GET /buildings/:id/floors` is legitimately operator-readable and Slice 1's tenant binding already blocks the audit's cross-tenant read scenario. |
| 2026-05-14 | Slice 1 — `/full-review` follow-up (C1 + I1 + I3 + I4) | **closed** | Same files plus `apps/api/src/modules/auth/admin.guard.ts`, `apps/api/src/common/permission-guard.ts`, `apps/api/src/modules/auth/admin.guard.spec.ts`. C1: `.eq('status','active')` filter added to AuthGuard bridge — suspended/inactive users with a still-valid JWT can no longer pass any authenticated route. I3: AdminGuard + PermissionGuard refactored to consume `req.user.platformUserId` directly; the users-row lookup ran exactly once per request now (in AuthGuard) instead of three times on admin+permission paths. I4: defensive `TenantContext.current()` wrap — bypassed middleware now surfaces as 404 `tenant.unknown` instead of a 500 stack trace. | `admin.guard.spec` 4/4 pass; `smoke:cross-tenant` 9/9 pass; `smoke:work-orders` 109/109 pass. | **Why the users-table bridge over JWT `app_metadata.tenant_id` cross-check?** The audit names both options as viable closers. Bridge chosen because (a) `app_metadata` mint discipline is unverified in this codebase — the audit ledger calls it out; (b) `public.users WHERE auth_uid AND tenant_id AND status='active'` is the authoritative membership source and the existing-guard pattern (AdminGuard, PermissionGuard, `loadContext`); (c) the lookup is one Supabase REST call (~5-15ms p50 same-region) — measurable but acceptable. The latency is paid once per request and platformUserId is reused everywhere downstream. **Open caveats** (NOT closed by Slice 1): (1) a multi-tenant user with `public.users` rows in two tenants can still hit either via header flip — only Slice 2 (`@UseGuards(AdminGuard)` on the 9 admin controllers) closes that vector; (2) cron / outbox / workflow-engine paths bypass AuthGuard entirely and rely on `TenantContext` being set from row data (safe by construction — they trust no actor input — but documented here as the explicit non-HTTP security model). |

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
