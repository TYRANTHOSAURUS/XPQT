-- Step 1b cutover #2: rewrite the work-order half of fulfillment_units_v to
-- read from public.work_orders instead of public.tickets. Same row shape,
-- same UNION semantics — we're just moving the source from the underlying
-- table to the view.
--
-- Also closes a pre-existing security gap: 00186 created the view with the
-- default grant posture which gave anon + authenticated full DML on the
-- view. The view already documents that consumers should NOT query it
-- directly from anon/authenticated roles, and `today nothing in the API
-- queries this view` (00186:91), but the grants don't enforce that.
-- Revoke them now while we're touching the file.
--
-- Postgres allows view-on-view: this query plans through both
-- fulfillment_units_v and work_orders inlining. EXPLAIN ANALYZE on remote
-- after this migration confirms an Append → Bitmap Heap Scan / Seq Scan
-- plan equivalent to the prior single-table version.

-- DROP + CREATE because the existing view's column list (17 cols including
-- is_late from 00190) is preserved verbatim — no column add/drop, just a
-- source change. CREATE OR REPLACE VIEW would suffice, but using DROP gives
-- us a clean reset of the grants posture too. No DB-level dependents on the
-- view (no other view, function, or trigger references it).
drop view if exists public.fulfillment_units_v;

create view public.fulfillment_units_v as
select
  'service_line'::text as source_kind,
  oli.id as source_id,
  oli.tenant_id,
  oli.vendor_id,
  oli.fulfillment_team_id as assigned_team_id,
  null::uuid as assigned_user_id,
  ord.delivery_location_id as location_id,
  ord.booking_bundle_id,
  oli.service_window_end_at as due_at,
  oli.fulfillment_status as status,
  case oli.fulfillment_status
    when 'cancelled' then 'cancelled'
    when 'delivered' then 'done'
    else 'open'
  end as status_bucket,
  coalesce(ci.name, 'Service line') ||
    case when oli.quantity is not null then ' × ' || oli.quantity::text else '' end
    as summary,
  ord.id as parent_order_id,
  null::uuid as parent_ticket_id,
  oli.created_at,
  oli.updated_at,
  case
    when oli.service_window_end_at is null then false
    when oli.fulfillment_status in ('delivered', 'cancelled') then false
    else oli.service_window_end_at < now()
  end as is_late
from public.order_line_items oli
join public.orders ord on ord.id = oli.order_id and ord.tenant_id = oli.tenant_id
left join public.catalog_items ci on ci.id = oli.catalog_item_id and ci.tenant_id = oli.tenant_id

union all

-- Step 1b cutover: was `from public.tickets t where t.ticket_kind='work_order'`.
-- Now sources from the public.work_orders view (which already filters
-- ticket_kind='work_order' internally). Identical rows, stable target.
select
  'work_order'::text as source_kind,
  t.id as source_id,
  t.tenant_id,
  t.assigned_vendor_id as vendor_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.location_id,
  t.booking_bundle_id,
  t.sla_resolution_due_at as due_at,
  t.status_category as status,
  case t.status_category
    when 'closed' then 'done'
    when 'resolved' then 'done'
    else 'open'
  end as status_bucket,
  t.title as summary,
  null::uuid as parent_order_id,
  t.parent_ticket_id,
  t.created_at,
  t.updated_at,
  case
    when t.sla_resolution_due_at is null then false
    when t.status_category in ('resolved', 'closed') then false
    when coalesce(t.sla_paused, false) then false
    else t.sla_resolution_due_at < now()
  end as is_late
from public.work_orders t;

comment on view public.fulfillment_units_v is
  'Cross-root read model — every "unit of work the org owes" as one row, regardless of source (service_line on a reservation OR work_order ticket). Step 1b (00209) cutover: work-order half now sources from public.work_orders view. Read-only by intent. Direct API access revoked from anon/authenticated; service-role consumers are responsible for their own scoping.';

-- Lock down direct access: matches the posture on cases/work_orders views.
-- Service role is the only legitimate consumer (server-side, gated by API).
revoke insert, update, delete, truncate on public.fulfillment_units_v from anon, authenticated, public, service_role;
revoke select on public.fulfillment_units_v from anon, authenticated, public;
grant select on public.fulfillment_units_v to service_role;

notify pgrst, 'reload schema';
