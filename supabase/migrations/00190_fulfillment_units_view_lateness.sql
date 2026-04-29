-- 00190_fulfillment_units_view_lateness.sql
-- Adds is_late to fulfillment_units_v so cross-source scorecards can compute
-- on-time rate without per-source-kind branching client-side.
--
-- Postgres CREATE OR REPLACE VIEW only allows ADDING columns at the end —
-- existing columns must keep their name + position + type. This migration
-- preserves the 14 columns from 00186 verbatim and appends is_late.
--
-- For service_line rows, is_late mirrors order_line_lateness_v.is_late
-- (00189). For work_order tickets, the same shape is computed against
-- sla_resolution_due_at + status_category — re-using the existing SLA
-- machinery's notion of breach without persisting it. SLA-paused tickets
-- (sla_paused = true) are NOT considered late while paused; this matches
-- the runtime semantic SLA service already enforces.

create or replace view public.fulfillment_units_v as
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
  -- New (Wave 2 Slice 3): derived lateness, mirrors order_line_lateness_v.
  case
    when oli.service_window_end_at is null then false
    when oli.fulfillment_status in ('delivered', 'cancelled') then false
    else oli.service_window_end_at < now()
  end as is_late
from public.order_line_items oli
join public.orders ord on ord.id = oli.order_id and ord.tenant_id = oli.tenant_id
left join public.catalog_items ci on ci.id = oli.catalog_item_id and ci.tenant_id = oli.tenant_id

union all

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
  -- New (Wave 2 Slice 3): derived lateness for work-order tickets.
  -- Mirrors the SLA service's notion of breach but computed lazily.
  -- Paused SLAs aren't "late" while paused — that's the SLA contract.
  case
    when t.sla_resolution_due_at is null then false
    when t.status_category in ('resolved', 'closed') then false
    when coalesce(t.sla_paused, false) then false
    else t.sla_resolution_due_at < now()
  end as is_late
from public.tickets t
where t.ticket_kind = 'work_order';

notify pgrst, 'reload schema';
