-- 00184_orders_line_vendor_provenance_backfill.sql
-- Backfill order_line_items.vendor_id and .menu_item_id from policy_snapshot.
-- Both insert paths historically wrote menu_item_id into policy_snapshot but
-- not into the dedicated columns the vendor portal queries against. The
-- vendor portal therefore sees mostly-null vendor_id for legacy rows and
-- can't filter today's deliveries correctly.
--
-- Strategy:
--   1. Where policy_snapshot.menu_item_id is set and the FK is still null,
--      copy it into the menu_item_id column.
--   2. Derive vendor_id by joining menu_items -> catalog_menus.vendor_id
--      where order_line_items.vendor_id is still null.
--   3. Skip rows where the snapshot value no longer exists in menu_items
--      (orphaned references; vendor stays null and ops can fix manually).

update public.order_line_items oli
   set menu_item_id = (oli.policy_snapshot ->> 'menu_item_id')::uuid
 where oli.menu_item_id is null
   and oli.policy_snapshot ? 'menu_item_id'
   and (oli.policy_snapshot ->> 'menu_item_id') ~ '^[0-9a-f-]{36}$'
   and exists (
     select 1 from public.menu_items mi
      where mi.id = (oli.policy_snapshot ->> 'menu_item_id')::uuid
        and mi.tenant_id = oli.tenant_id
   );

update public.order_line_items oli
   set vendor_id = cm.vendor_id
  from public.menu_items mi
  join public.catalog_menus cm on cm.id = mi.menu_id and cm.tenant_id = mi.tenant_id
 where oli.vendor_id is null
   and oli.menu_item_id = mi.id
   and oli.tenant_id = mi.tenant_id
   and cm.vendor_id is not null;

-- Telemetry: log how many rows we couldn't backfill (vendor still null on a
-- non-cancelled line). These need manual ops attention or are pre-vendor-FK.
do $$
declare
  v_unfilled_count int;
begin
  select count(*) into v_unfilled_count
    from public.order_line_items
   where vendor_id is null
     and fulfillment_status not in ('cancelled');
  raise notice 'order_line_items rows with NULL vendor_id after backfill: %', v_unfilled_count;
end$$;

notify pgrst, 'reload schema';
