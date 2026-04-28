# People & Users surface — follow-ups

Slice shipped as `feature/people-and-users-surface`. This doc tracks what was deliberately left out of the slice, plus what reviewers found and we deferred to follow-up work.

Scoped this way so `/admin/persons` and `/admin/users` could ship now without waiting on infra that doesn't exist yet (sessions, MFA, tokens) or scope-expanding security cleanup that pre-dates this slice.

---

## Must-do soon (post-merge)

### 1. Wire the Supabase Auth webhook (originally Task 4)

**Status:** code is ready; only the Supabase-side configuration + `parsePayload` adapter remain.

**Why it matters:** `auth_sign_in_events` will receive zero rows until this is done. The new "Recent sign-ins" panel on `/admin/users/:id` and the "Last sign-in" timestamp will both stay empty. The endpoint code, RLS, idempotency, and frontend rendering are all live.

**Steps when ready (assumes API deployed at `xpqt.vercel.app` or future prod URL):**

1. Supabase Dashboard → project `iwbqnyrvycqgnatratrk` → Database → Webhooks → New webhook
   - Table: `auth.audit_log_entries`
   - Events: `Insert`
   - HTTP Request → POST → `https://<api-host>/api/webhooks/auth/sign-in`
   - HTTP Headers: `Authorization: Bearer <SUPABASE_AUTH_HOOK_SECRET>` (the secret is in the project's `.env`; for new envs, generate with `openssl rand -hex 32` and update both Supabase Dashboard and the env)

2. Update `AuthEventsController.parsePayload` (`apps/api/src/modules/auth/auth-events.controller.ts`) to translate the **database webhook envelope shape** into the existing `SupabaseAuthEvent` interface. The DB webhook delivers:
   ```json
   { "type": "INSERT", "table": "audit_log_entries", "schema": "auth",
     "record": { "id": "...", "payload": {...}, "ip_address": "...", "created_at": "..." } }
   ```
   Map `record.payload.action`: `'login'` → `sign_in`, `'logout'` → `sign_out`, `'login_failed'` → `sign_in_failed` (verify exact strings against a real `auth.audit_log_entries` row in the project).

3. Smoke-test: log in via the deployed app, then run
   ```sql
   select event_kind, signed_in_at, ip_address from public.auth_sign_in_events order by signed_in_at desc limit 5;
   ```
   against remote — at least one row should appear.

The current `parsePayload` accepts the literal `{ type, user_id, session_id, ... }` shape; it expects no work to translate. Tests cover that path. When you swap to the DB-webhook envelope, add a translator at the top of `parsePayload` and keep the rest of the function unchanged.

---

### 2. Avatar storage policy: enforce per-tenant path ownership

**Status:** intentional gap, documented in the migration header.

**Why it matters:** Today the `avatars` bucket policies (`00175_avatars_bucket.sql`) check `auth.role() = 'authenticated'` only. Any authenticated user in any tenant can overwrite or delete `<other-tenant-id>/<person-id>.jpg` if they know the path (which follows the deterministic `<tenant_id>/<person_id>.<ext>` pattern). This is genuine cross-tenant privilege escalation.

**Fix:** add a path-prefix check to each storage policy. The first folder segment (`storage.foldername(name)[1]`) must equal the user's tenant id. Resolve the user's tenant via the existing `public.users` lookup (auth.uid → public.users.id → tenant_id). Tenant id is available from JWT app_metadata if we want to skip a roundtrip.

Touch: `supabase/migrations/00175_avatars_bucket.sql` lives only as a record — the actual fix is a new migration that drops + replaces the four `avatars_*` policies with the path-checked versions. Apply to remote via psql per the project pattern.

---

### 3. Pre-existing `/users/:id/audit` lacks permission gate

**Status:** pre-existing in `UsersController` (predates this slice). Not introduced by us, not fixed by us — this slice only fixed the new `/sign-ins` and `/password-reset` endpoints.

**Why it matters:** Any authenticated user in the same tenant can read another user's role audit log. Same-tenant-only, but still leaks who-changed-what-when across people who shouldn't see it.

**Fix:** add `await this.permissions.requirePermission(request, 'users.read')` to `audit()` in `apps/api/src/modules/user-management/user-management.controller.ts`. Trivial. Could batch with a sweep of the other unguarded user/role/person-admin endpoints (`getById`, `update`, etc.) if there's appetite — they all have the same gap.

---

## Should-do (next slice or sprint)

### 4. Sessions list + revoke + "Sign out all devices"

The data foundation is there: `auth_sign_in_events` records `event_kind='sign_in'` and `event_kind='sign_out'` with `session_id` per row. Add a UI surface that lists active sessions (sign_in rows whose session_id has no matching sign_out row) and a "Revoke" button per row + a "Sign out all devices" CTA paired with password change. Backend: `supabase.auth.admin.listUserSessions()` + `signOut(jti)`. ~3-4 days work.

### 5. New-device email alerts

Once webhook fires real events, add a check in `AuthEventsService.recordSignIn`: if `(user_id, ip_address)` is unseen in the last 30 days, queue a "new-device sign-in" notification email to the user. ~1 day.

### 6. MFA enrollment

No MFA implemented anywhere yet. Greenfield surface — needs UX + backend (Supabase Auth supports TOTP / webauthn factors). ~2-3 weeks.

### 7. API tokens / personal access tokens

No backend — needs token issuance + revocation table + UI surface. ~1 week.

### 8. Impersonate

Admin-as-user flow with audited session-swap. Needs trust-model design + backend support. ~1-2 weeks.

---

## Minor / nice-to-have

- **`PERSON_TYPES` duplication.** The constant is defined verbatim in both `apps/web/src/pages/admin/person-detail.tsx:50` and `apps/web/src/pages/admin/persons.tsx:33`. Extract to `@/api/persons/index.ts` (or a `persons.constants.ts`) so the next-added type doesn't drift.

- **`any` casts in `person-activity.service.ts`** (lines 47, 51, 59) on Supabase join results. Supabase JS client's inferred types for nested selects are `any` anyway — acceptable, but worth tightening if the team adopts a Zod-or-typed-client pattern later.

- **Inspector hydration UX.** When switching person rows in `/admin/persons` split-view, the controlled inputs show the previous person's values for ~150ms while the new query resolves. Not a bug — `useEffect([person?.id])` is the right guard — but a transition skeleton or `key`-based remount on the inspector content would smooth it.

- **Migration `00174` is not `IF NOT EXISTS`-guarded.** The remote DB already has the table from when the file was originally numbered 00172. Header comment explicitly warns "do not re-run". Idempotency wasn't built in because the application path doesn't replay (psql -f used directly). Worth knowing if any future CI auto-applies migrations.

---

## Pre-existing infra debt that bit us

### 00105 migration filename collision

Two migrations both prefixed `00105` (`00105_seed_centralised_example_catalog.sql` + `00105_tenant_branding_surface_colors.sql`). Blocks `pnpm db:reset` against a fresh DB with a schema_migrations PK violation. Doesn't affect this slice (the relevant DBs already had their state initialised before this collision was introduced), but a fresh contributor can't run `pnpm db:reset` until one of the two is renamed. Trivial fix: rename `00105_tenant_branding_surface_colors.sql` → `00106a_tenant_branding_surface_colors.sql` (or wherever fits the chronology) on a separate cleanup branch. Don't bundle into this slice.

### Frontend test runner

`apps/web/package.json` has no `test` script and no Vitest/Jest dep. All UI changes in this slice were smoke-built only (`pnpm --filter @prequest/web build` clean). Adding Vitest + RTL + MSW is a separate infrastructure decision per `feedback_frontend_skill_not_antd_agent` memory.
