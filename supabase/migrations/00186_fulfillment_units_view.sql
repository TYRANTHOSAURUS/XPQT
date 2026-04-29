-- 00186_fulfillment_units_view.sql
-- Cross-root read model: every "unit of work the org owes" represented as
-- one row, regardless of whether it originated as a service line on a
-- reservation or as a dispatched work-order ticket.
--
-- This is a READ-ONLY view. Underlying state machines stay separate:
--   * order_line_items.fulfillment_status drives vendor-facing flows
--   * tickets.status_category drives service-desk + dispatch flows
--
-- Use this view for:
--   * vendor scorecards ("on-time delivery rate" across both axes)
--   * "all my work this week" cross-source reporting
--   * the Wave 2 unified vendor inbox (gated on the dormant 00035 ticket-
--     visibility-for-vendors policy being activated)
--
-- Status values intentionally come through verbatim from each source — they
-- live in different state machines. Readers either:
--   (a) filter by source_kind and interpret status in that domain, or
--   (b) use the helper status_bucket below for a coarse open/done/cancelled
--       grouping that's safe across both sources.

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
  -- Best-effort summary: catalog item name + quantity. Falls back to a
  -- stub so callers always have a non-null label.
  coalesce(ci.name, 'Service line') ||
    case when oli.quantity is not null then ' × ' || oli.quantity::text else '' end
    as summary,
  ord.id as parent_order_id,
  null::uuid as parent_ticket_id,
  oli.created_at,
  oli.updated_at
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
  t.updated_at
from public.tickets t
where t.ticket_kind = 'work_order';

-- Indexable surface: most queries filter (tenant_id, vendor_id, due_at).
-- The view is non-materialized; composite indexes already exist on the
-- underlying tables (idx_oli_vendor + idx_tickets_queue_sla) so this is
-- adequate for now. If query latency becomes an issue, materialize and
-- refresh on writes (out of scope for Wave 1).
--
-- Security caveat (codex review 2026-04-29):
--   Plain views in Postgres run with the OWNER's privileges by default,
--   not the caller's — RLS on the underlying tables is NOT automatically
--   re-evaluated per caller for a plain view. Before exposing this view
--   directly to the vendor or authenticated role (e.g. via PostgREST or
--   a client query), recreate it with `with (security_invoker = true)`
--   so the caller's RLS context applies. Today nothing in the API queries
--   this view, so the risk is contained.
--
--   Wave 2 consumer guidance:
--     * If the consumer is a service that uses supabase.admin (already
--       bypasses RLS), the plain-view form is fine — the service must
--       apply its own scoping (vendor_id filter, ticket-visibility check).
--     * Vendor-portal callers should NOT query this view directly today.
--       Use the dedicated vendor predicates instead:
--         - tickets_visible_for_vendor(vendor_id, tenant_id)  [00188]
--         - VendorOrderService.listForVendor(...)              [oli side]
--       The dormant 00035 vendor-on-tickets clause stays dormant — vendor
--       auth in this codebase is the parallel `vendor_users` table, not a
--       tenant `users` row, so reactivating that clause would be a no-op.
--     * If a future consumer needs this view from an authenticated tenant
--       role, recreate with `with (security_invoker = true)` so RLS on the
--       underlying tables re-evaluates per caller.

notify pgrst, 'reload schema';
