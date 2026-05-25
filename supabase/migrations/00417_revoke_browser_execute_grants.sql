-- 00417 — Revoke browser-role EXECUTE on public functions (RLS Audit 04)
--
-- docs/follow-ups/audits/04-rls-security.md — codex done-check 2026-05-18
-- found this LIVE cross-tenant leak that the "RPC-EXECUTE tracked-P2,
-- not live" framing wrongly downgraded:
--
--   `public.tickets_distinct_tags(tenant uuid)` (00031) is
--   `SECURITY DEFINER`, `GRANT EXECUTE … TO authenticated`, body
--   `select … from tickets where tenant_id = tenant` — it trusts the
--   CALLER-SUPPLIED `tenant` arg with NO `current_tenant_id()` /
--   `auth.uid()` / users-membership check, and no later migration
--   revokes it. Verified live: an authenticated browser session token
--   `POST /rest/v1/rpc/tickets_distinct_tags {tenant:<any uuid>}` →
--   HTTP 200 returning that tenant's distinct ticket tags. This does
--   NOT depend on the unminted `tenant_id` JWT claim (the function
--   trusts the arg, not `current_tenant_id()`), so it is reachable NOW
--   — a cross-tenant read (tenant_id is the #0 invariant: a
--   cross-tenant leak is P0-class regardless of the low data
--   sensitivity of tag labels).
--
-- Root cause is structural and broad: Supabase's platform default is
-- `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon,
-- authenticated` — 370 public functions are browser-role-executable.
-- `tickets_distinct_tags` is the proven-live instance; the class is the
-- function-level twin of the table-DML hole 00415 closed. The app makes
-- ZERO browser-direct `.rpc()` calls (verified at HEAD) — every RPC is
-- invoked through the NestJS API on the service_role / postgres path.
--
-- ROOT CAUSE (a first cut `REVOKE … FROM anon, authenticated` did NOT
-- close it — verified): Postgres grants `EXECUTE` to **PUBLIC** by
-- default on every `CREATE FUNCTION`. `tickets_distinct_tags.proacl`
-- was `{=X/postgres, …, service_role=X/postgres}` — the `=X` (empty
-- grantee = PUBLIC) is the live grant; there was never an
-- `authenticated`-specific ACL entry, so revoking from `anon,
-- authenticated` was a no-op and `authenticated` kept EXECUTE via
-- PUBLIC. The leak must be closed at the PUBLIC grant.
--
-- Fix (the audit's own canonical SECURITY DEFINER pattern —
-- `revoke from public; grant to service_role`): revoke EXECUTE on ALL
-- public routines from **PUBLIC, anon, authenticated**, then GRANT
-- EXECUTE on ALL public routines back to **service_role** (the API's
-- role — `SupabaseService.admin`; raw-pg `DbService` connects as
-- `postgres`, the function OWNER, which always retains EXECUTE
-- irrespective of the PUBLIC revoke), and re-grant ONLY the
-- audit-documented anon-callable bearer-token trio (visitor magic-link
-- / kiosk device token / cancel-page peek — 04-rls P2 §81-87, Slice 7:
-- hashed-token, PII-tombstoned, anon-by-design). After this,
-- browser-direct RPC is GRANT-denied (claim-independent) for everything
-- except those three; the API (service_role/postgres) is unaffected;
-- trigger functions are unaffected (Postgres does not check EXECUTE on
-- trigger functions). Extension functions owned by `supabase_admin`
-- (pg_trgm/btree_gist math — no tenant data) cannot be revoked from
-- this non-owner role and are out of scope (search `similarity()`
-- etc. keep working).
--
-- Idempotent (REVOKE/GRANT of an absent/present privilege is a no-op).
-- Safe under `pnpm db:reset`. No structural table change — does not
-- touch the booking-canonicalization destructive-default invariant.
--
-- Default-privilege future-proofing is PARTIAL by the same constraint
-- as 00415: the migration role `postgres` is not a member of
-- `supabase_admin` and not superuser, so `ALTER DEFAULT PRIVILEGES`
-- only covers `postgres`-created future functions. The load-bearing
-- protection is the `REVOKE … ON ALL ROUTINES` (every current
-- function, any creator); the AUTHORITATIVE ongoing guard is the
-- all-public-routines EXECUTE assertion in smoke-cross-tenant.mjs.

revoke execute on all routines in schema public from public, anon, authenticated;

-- Preserve the API path: service_role is the role behind
-- SupabaseService.admin (all NestJS RPC calls). Explicit re-grant
-- because the PUBLIC revoke above also strips service_role's
-- PUBLIC-derived EXECUTE on any function that lacked an explicit
-- service_role grant. (postgres — the raw DbService pool — owns the
-- app functions and keeps EXECUTE inherently.)
grant execute on all routines in schema public to service_role;

alter default privileges in schema public
  revoke execute on routines from public, anon, authenticated;

-- Re-grant the audit-documented anon-callable bearer-token trio only.
grant execute on function public.validate_invitation_token(text, text) to anon, authenticated;
grant execute on function public.peek_invitation_token(text, text)      to anon, authenticated;
grant execute on function public.validate_kiosk_token(text)             to anon, authenticated;

notify pgrst, 'reload schema';
