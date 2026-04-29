-- 00189_order_line_lateness_view.sql
-- Derived lateness metrics on order_line_items, computed at read time.
-- No persisted state, no SLA-style pause/business-hours engine. Vendor
-- scorecards consume this for "on-time delivery rate" and similar KPIs.
--
-- Three columns:
--   * is_late: line is past its service_window_end_at AND not terminal
--   * lateness_minutes: how late, NULL when not late or terminal
--   * was_late_at_completion: best-effort historical lateness for delivered
--     lines (uses updated_at as a proxy for completion time — approximate;
--     vendor_order_status_events would be more accurate but is a Sprint-2
--     follow-up; we'll re-derive from there if/when scorecards demand it).
--
-- Why a view, not a column: the values change every minute (now() moves).
-- A persisted column would need a sweeper to flip is_late as the clock
-- ticks past each line's window. The view computes per-read, the indexes
-- on the underlying columns (`idx_oli_vendor` etc.) cover the typical
-- predicate (tenant + vendor + service_window_end_at), so this is fine
-- for vendor-scorecard volumes. Materialise later if a hot dashboard
-- needs sub-millisecond reads.

create or replace view public.order_line_lateness_v as
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
  end as lateness_minutes,
  case
    when oli.fulfillment_status = 'delivered'
         and oli.service_window_end_at is not null
         and oli.updated_at > oli.service_window_end_at
      then true
    when oli.fulfillment_status = 'delivered' then false
    else null
  end as was_late_at_completion
from public.order_line_items oli;

comment on view public.order_line_lateness_v is
  'Derived lateness on order_line_items. is_late + lateness_minutes are open-line metrics; was_late_at_completion is best-effort historical for delivered lines (uses updated_at as proxy for completion time).';

notify pgrst, 'reload schema';
