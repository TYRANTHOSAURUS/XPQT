-- 00184_orders_line_vendor_provenance_backfill.sql
-- Backfill order_line_items.menu_item_id from policy_snapshot.
-- Both insert paths historically wrote menu_item_id into policy_snapshot but
-- not into the dedicated columns the vendor portal queries against. The
-- vendor portal therefore sees mostly-null vendor_id for legacy rows and
-- can't filter today's deliveries correctly.
--
-- Strategy (revised after codex review 2026-04-29):
--   1. Where policy_snapshot.menu_item_id is set and the FK is still null,
--      copy it into the menu_item_id column. This is safe because both
--      insert paths historically wrote the snapshot at order time and the
--      row only becomes wrong if the menu_item itself was deleted (handled
--      below: the existence check skips orphans).
--
--   2. Do NOT auto-derive vendor_id from catalog_menus.vendor_id today.
--      catalog_menus.vendor_id reflects PRESENT-day vendor ownership; if a
--      menu was ever reassigned to a different vendor after the line was
--      created, that historical line would be retroactively re-attributed
--      to the new vendor. Vendor-facing reads filter directly on
--      order_line_items.vendor_id (vendor-order.service.ts:128 +
--      daily-list.service.ts:157), so a wrong vendor here is a real
--      visibility bug, not just a denorm mismatch. We accept that historical
--      rows stay vendor_id=NULL and let ops fix them manually (or via a
--      follow-up migration once a vendor-reassignment audit trail exists).
--
--   3. Skip rows where the snapshot value no longer exists in menu_items
--      (orphaned references). The menu_item_id stays null in that case.

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

-- Telemetry: log how many rows are NULL on non-cancelled lines — these are
-- the legacy rows that need ops attention OR will fix themselves the next
-- time someone edits/recreates them through a flow that resolves the menu.
do $$
declare
  v_null_vendor int;
  v_null_menu int;
begin
  select count(*) into v_null_vendor
    from public.order_line_items
   where vendor_id is null
     and fulfillment_status not in ('cancelled');
  select count(*) into v_null_menu
    from public.order_line_items
   where menu_item_id is null
     and fulfillment_status not in ('cancelled');
  raise notice 'order_line_items NULL vendor_id (non-cancelled): %', v_null_vendor;
  raise notice 'order_line_items NULL menu_item_id (non-cancelled): %', v_null_menu;
end$$;

notify pgrst, 'reload schema';
