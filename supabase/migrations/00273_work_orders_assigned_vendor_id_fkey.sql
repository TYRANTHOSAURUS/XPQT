-- 00273_work_orders_assigned_vendor_id_fkey.sql
--
-- Bug context: booking-bundle drawers on /desk/bookings show
-- "Couldn't load services: Internal server error" because the API at
-- `apps/api/src/modules/booking-bundles/booking-bundles.controller.ts:231`
-- queries:
--
--     .from('work_orders')
--     .select('… assigned_vendor:vendors!assigned_vendor_id(name)')
--
-- PostgREST resolves `vendors!assigned_vendor_id` by looking up the FK
-- from `work_orders.assigned_vendor_id` → `vendors.id`. That FK does
-- NOT exist on `public.work_orders` — it was on `public.tickets`
-- (`tickets_assigned_vendor_id_fkey`) but never made the trip when
-- step 1c.1 created `work_orders_new` and step 1c.3.6 atomic-renamed
-- it. PostgREST returns PGRST200 ("Could not find a relationship
-- between 'work_orders' and 'vendors'"), the API surfaces it as a
-- 500, the FE renders "Couldn't load services: Internal server error".
--
-- Fix: add the missing FK. Mirrors the existing FK shape on
-- `public.tickets` (no ON DELETE / ON UPDATE clauses; default
-- NO ACTION semantics — vendors with assigned WOs cannot be deleted
-- without first reassigning, which is the desired safety).
--
-- Pre-flight audit on remote at write-time: 0 orphan vendor refs and
-- 0 cross-tenant leaks across 146 WO rows referencing 13 distinct
-- vendors. Safe to add the FK without a backfill.
--
-- Idempotent. Has post-state assertion that the FK exists.

-- Pre-flight: assert no orphan or cross-tenant vendor references.
-- If this fires, the migration aborts BEFORE the FK creation — the
-- caller can clean up the offending rows and re-run.
do $$
declare
  v_orphans int;
  v_cross_tenant int;
begin
  select count(*)
    into v_orphans
    from public.work_orders wo
    where wo.assigned_vendor_id is not null
      and not exists (select 1 from public.vendors v where v.id = wo.assigned_vendor_id);
  if v_orphans > 0 then
    raise exception
      '00273: % work_order(s) have an assigned_vendor_id that does not exist in public.vendors. Clear the orphans (e.g. UPDATE work_orders SET assigned_vendor_id=NULL WHERE assigned_vendor_id NOT IN (SELECT id FROM vendors)) before re-running.',
      v_orphans;
  end if;

  select count(*)
    into v_cross_tenant
    from public.work_orders wo
    join public.vendors v on v.id = wo.assigned_vendor_id
    where v.tenant_id != wo.tenant_id;
  if v_cross_tenant > 0 then
    raise exception
      '00273: % work_order(s) reference a vendor from a different tenant. This is a cross-tenant leak (per CLAUDE.md tenant_id_ultimate_rule); investigate before adding the FK.',
      v_cross_tenant;
  end if;
end
$$;

-- Add the FK. `if not exists` is not supported on ALTER TABLE ADD
-- CONSTRAINT in Postgres, so guard with a do-block lookup instead.
-- Idempotent: a re-run is a no-op.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'work_orders_assigned_vendor_id_fkey'
      and conrelid = 'public.work_orders'::regclass
  ) then
    alter table public.work_orders
      add constraint work_orders_assigned_vendor_id_fkey
      foreign key (assigned_vendor_id) references public.vendors(id);
  end if;
end
$$;

-- Post-state assertion: the FK now exists. Mirrors the 00248 pattern
-- of asserting the migration's intended effect inline before exit;
-- guards against silent no-ops on a future Postgres semantics change.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'work_orders_assigned_vendor_id_fkey'
      and conrelid = 'public.work_orders'::regclass
  ) then
    raise exception '00273: FK creation failed silently — work_orders_assigned_vendor_id_fkey not present after migration body';
  end if;
end
$$;

-- Tell PostgREST to reload its schema cache. Without this, the
-- in-memory FK graph PostgREST uses to resolve `vendors!assigned_vendor_id`
-- embeds stays stale and the 500 persists until the next natural
-- cache refresh.
notify pgrst, 'reload schema';
