-- 00248_restore_work_orders_service_role_writes.sql
--
-- Root cause: at step 1c.3.6 (atomic rename, migration 00222 line 352-354),
-- public.work_orders was given a deliberately-temporary "SELECT only" grant
-- posture for service_role:
--
--   revoke all on public.work_orders from anon, authenticated, public;
--   grant select on public.work_orders to service_role;
--   -- service_role gets SELECT only during 1c.3.6 (still pre-1c.4 writer flip).
--
-- The 1c.4 writer cutover (commit 7be0669) flipped service code to write to
-- public.work_orders, but no migration ever restored INSERT/UPDATE/DELETE
-- grants for service_role. Every test path through the API mocks Supabase,
-- so the table-level 42501 (insufficient_privilege) never surfaced. The
-- first real PATCH against the live DB produced "permission denied for
-- table work_orders" on every write — observed in /tmp/api-dev.log
-- repeatedly throughout 2026-05-01.
--
-- This migration restores the full DML grant posture that
-- 00213_step1c1_work_orders_new_table.sql line 148 originally established
-- for the underlying base table (work_orders_new, before the rename).
--
-- Idempotent. Safe to re-apply.

-- Reset all role grants to a known posture, then grant precisely what
-- service_role needs. Mirrors the pattern in 00213.
revoke all on public.work_orders from anon, authenticated, public;
grant select, insert, update, delete on public.work_orders to service_role;
revoke truncate, references, trigger on public.work_orders from service_role;

-- Post-state assertion: service_role has all four DML privileges. If this
-- migration silently no-ops in the future (e.g. a Postgres upgrade changes
-- grant semantics), this raise blocks the migration window before the
-- silent-no-op pattern bites again. See the 00233/00234 LIKE-bug
-- postmortem in docs/follow-ups/data-model-rework-full-handoff.md for
-- the precedent.
do $$
declare
  missing text[];
begin
  select coalesce(array_agg(p), '{}'::text[])
  into missing
  from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p
  where not exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name   = 'work_orders'
      and grantee      = 'service_role'
      and privilege_type = p
  );
  if array_length(missing, 1) is not null then
    raise exception
      'service_role still missing privileges on public.work_orders: %',
      missing;
  end if;
end
$$;

-- Tell PostgREST to reload its schema cache so the new grants take effect
-- for any cached prepared statements / role-permission lookups. Belt and
-- braces — the API is on Nest+supabase-js (not PostgREST itself), but the
-- shared schema cache notification is harmless.
notify pgrst, 'reload schema';
