-- 00438_order_line_lateness_v_security_invoker.sql
-- Address Supabase advisor warning: public.order_line_lateness_v is owned by
-- postgres and exposes SELECT to anon + authenticated, but the view default
-- in Postgres is to run as the OWNER (postgres), which bypasses RLS on the
-- underlying order_line_items table. order_line_items has a tenant_isolation
-- policy keyed on current_tenant_id() — without security_invoker, a browser
-- JWT querying the view would see ALL tenants' lateness rows.
--
-- Flip the view to security_invoker = true so RLS on order_line_items is
-- evaluated as the querying user. No app code currently queries this view
-- (verified via grep across apps/ + packages/), so this is a defense-in-depth
-- tightening, not a behavior change for live callers.
--
-- Cross-tenant gate covered by pnpm smoke:cross-tenant (no new probe needed;
-- the view has no API surface yet).

begin;

alter view public.order_line_lateness_v set (security_invoker = true);

commit;

notify pgrst, 'reload schema';
