-- 00434 — Revoke browser-role write grants on public.* (RLS Audit 04, P1)
--
-- RENUMBERED 2026-05-19 (release-integration): was 00415 — collided with the
-- incumbent floor-plans 00415_spaces_floor_plan_render_hint.sql (on main since
-- 2026-05-18). Rename only; SQL byte-identical. The RLS-Audit-04 ledger
-- (docs/follow-ups/audits/04-rls-security.md) refers to this file as "00415".
--
-- docs/follow-ups/audits/04-rls-security.md — codex 2026-05-18 remaining
-- item #2 (browser-direct PostgREST). The prior ledger conclusion
-- ("NOT-REACHABLE / zero grants to anon/authenticated / grant-layer
-- deny") was factually wrong on mechanism. Proven this session:
--
--   * SUPABASE_URL is a transparent Cloudflare Worker that proxies
--     /rest/v1 (and in prod the browser hits PostgREST directly anyway).
--   * `anon` and `authenticated` hold FULL CRUD on every public table
--     (Supabase's default `GRANT ALL ... TO anon, authenticated`).
--   * RLS is the SOLE gate. All app tables use
--     `tenant_isolation ALL USING (tenant_id = current_tenant_id())`
--     with NO `WITH CHECK` (so writes evaluate the USING expr).
--   * `current_tenant_id()` (00002_rls_helpers.sql:5-14) reads
--     `jwt.claims->'app_metadata'->>'tenant_id'` / top-level
--     `tenant_id`. The application never mints that claim, so for
--     every browser session token `current_tenant_id()` is NULL and
--     the policy denies all rows/writes.
--
-- Net: browser-direct read/write is fail-closed ONLY by the accident of
-- an unminted JWT claim, behind wide-open grants. The instant any
-- Supabase custom-access-token hook injects `tenant_id`, every browser
-- user gets direct CRUD on their own tenant's `user_role_assignments` /
-- `team_members` / `roles` via PostgREST — same-tenant privilege
-- escalation at the data layer, bypassing every Slice 9/10/11 HTTP
-- guard. P1 latent defense-in-depth defect (not a live P0 — empirically
-- fail-closed today; reads -> 200 [], write -> 403 42501).
--
-- Fix (codex-concurred remediation (a)): revoke write DML from the two
-- browser roles on ALL public tables. The app makes ZERO browser-direct
-- table writes / rpc (verified at HEAD) — every write goes through the
-- NestJS API on the postgres-superuser pool / service-role client, which
-- this REVOKE does not touch. SELECT is intentionally KEPT: Supabase
-- Realtime ("Postgres Changes") evaluates per-subscriber RLS on SELECT
-- for published tables (booking_slots / bookings / inbox_notifications /
-- order_line_items / orders / recurrence_series / room_booking_rules /
-- vendor_order_status_events) — revoking SELECT would break the inbox
-- bell + scheduler live updates; revoking writes does not.
--
-- After this, browser-direct writes are denied at the GRANT layer —
-- claim-independent: the protection no longer depends on `tenant_id`
-- staying unminted. RLS remains as defense-in-depth for reads.
--
-- Idempotent (REVOKE of an absent privilege is a no-op). Safe under
-- `pnpm db:reset`. No structural change to any table — does not touch
-- the booking-canonicalization destructive-default invariant.

revoke insert, update, delete, truncate
  on all tables in schema public
  from anon, authenticated;

-- Future-proofing is PARTIAL by design — stated honestly, not oversold
-- (full-review 2026-05-18, findings PLAN-I2 / CODE-I1).
--
-- `ALTER DEFAULT PRIVILEGES` only affects objects created by the role(s)
-- in `FOR ROLE` (default: the current role). On this project
-- `pg_default_acl` is keyed by BOTH `postgres` and `supabase_admin`, and
-- Supabase's platform default is `GRANT ALL TO anon, authenticated`. We
-- can only set the default for `postgres` here: the migration role is
-- `postgres`, which is NOT a member of `supabase_admin` and NOT a
-- superuser on this project (verified — `ALTER DEFAULT PRIVILEGES FOR
-- ROLE supabase_admin` raises "permission denied"). So a future table
-- created via the dashboard / platform tooling (as `supabase_admin`)
-- CAN still re-open browser write access.
--
-- That residual is acceptable because it is NOT the load-bearing
-- protection. Two stronger layers cover it:
--   1. `REVOKE … ON ALL TABLES` above hardens every CURRENT table
--      regardless of which role created it.
--   2. The AUTHORITATIVE ongoing guard is the all-public-base-tables
--      grant assertion in `apps/api/scripts/smoke-cross-tenant.mjs`
--      (scoped to match THIS REVOKE — every public table, not an
--      escalation subset): any future re-grant (by any creator role)
--      fails that gate loudly.
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables
  from anon, authenticated;

-- PostgREST schema-cache reload so the revoked privileges take effect
-- immediately for the running gateway.
notify pgrst, 'reload schema';
