-- 00191_wave2_codex_fixes.sql
-- Address codex findings on Wave 2 slices 1 + 3:
--
-- 1. tickets_visible_for_vendor (00188) trusted (vendor_id, tenant_id) as a
--    coherent pair. Tickets.assigned_vendor_id only FKs to vendors(id), not
--    to (vendors.id, vendors.tenant_id), so a drifted ticket row pointing
--    at a cross-tenant vendor would be returnable. Add a join on vendors
--    that proves vendor belongs to the tenant — defensive even if the
--    session-level pair is already coherent.
--
-- 2. order_line_lateness_v (00189) had was_late_at_completion deriving
--    from order_line_items.updated_at, which is a generic every-update
--    bumper. Any post-delivery edit retroactively flipped on-time lines
--    to late. Drop the column. When scorecards land we'll source
--    delivered_at from vendor_order_status_events directly.
--
-- 3. fulfillment_units_v: no SQL change here, but the title source for
--    work-order tickets is changed in the API service — see
--    vendor-work-order.service.ts. (The view itself does not project
--    title for vendor consumption — vendors don't query this view today.
--    The summary column stays as t.title because operator-facing dashboards
--    do want the human title; the constraint is only for vendor reads.)

begin;

-- 1. Self-defensive vendor visibility predicate.
create or replace function public.tickets_visible_for_vendor(
  p_vendor_id uuid,
  p_tenant_id uuid
) returns setof public.tickets
language sql
stable
as $$
  select t.*
  from public.tickets t
  join public.vendors v
    on v.id = t.assigned_vendor_id
   and v.tenant_id = t.tenant_id
   and v.tenant_id = p_tenant_id
  where t.tenant_id = p_tenant_id
    and t.assigned_vendor_id = p_vendor_id
    and t.ticket_kind = 'work_order';
$$;

comment on function public.tickets_visible_for_vendor(uuid, uuid) is
  'Vendor-scoped ticket visibility. Returns work-order tickets where the vendor is the explicit assignee AND the vendor demonstrably belongs to the tenant being queried. Self-defensive: a drifted ticket row pointing at a cross-tenant vendor will not be returned.';

-- 2. Drop was_late_at_completion — proxy was unreliable.
-- CREATE OR REPLACE VIEW can add columns at the end but cannot drop them,
-- so we drop and recreate. The view has no DB-level dependents (no other
-- view, function, or trigger references it), so DROP is safe.
drop view if exists public.order_line_lateness_v;

create view public.order_line_lateness_v as
select
  oli.id,
  oli.tenant_id,
  oli.vendor_id,
  oli.fulfillment_status,
  oli.service_window_end_at,
  oli.updated_at,
  case
    when oli.service_window_end_at is null then false
    when oli.fulfillment_status in ('delivered', 'cancelled') then false
    else oli.service_window_end_at < now()
  end as is_late,
  case
    when oli.service_window_end_at is null then null
    when oli.fulfillment_status in ('delivered', 'cancelled') then null
    when oli.service_window_end_at >= now() then null
    else (extract(epoch from (now() - oli.service_window_end_at)) / 60)::int
  end as lateness_minutes
from public.order_line_items oli;

comment on view public.order_line_lateness_v is
  'Derived lateness on order_line_items. is_late + lateness_minutes are open-line metrics. Historical "was this delivered late" is intentionally NOT computed here — order_line_items.updated_at bumps on every edit, including post-delivery edits, so that proxy was unreliable. Source delivered_at from vendor_order_status_events directly when scorecards land.';

commit;

notify pgrst, 'reload schema';
