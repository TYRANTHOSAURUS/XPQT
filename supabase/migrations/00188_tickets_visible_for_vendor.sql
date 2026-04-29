-- 00188_tickets_visible_for_vendor.sql
-- Vendor-scoped ticket visibility predicate. Mirrors tickets_visible_for_actor
-- (00187) but keys off vendor_id instead of user_id, so the vendor portal
-- (which authenticates via vendor_users, not users) has a first-class
-- visibility surface.
--
-- Vendors are participant-only on tickets where they're explicitly the
-- assigned vendor. No team / role / read-all paths apply — those concepts
-- are tenant-employee-only.
--
-- The dormant 00035_vendor_participant_dormant.sql clause stays dormant on
-- purpose: it was conceived for a vendor-as-employee model where a tenant
-- `users` row would have a person whose external_source = 'vendor'. Vendor
-- auth in this codebase is a parallel `vendor_users` table with its own
-- session token. Activating that clause would be a no-op for vendor-portal
-- callers; this function is the surface they actually use.

begin;

create or replace function public.tickets_visible_for_vendor(
  p_vendor_id uuid,
  p_tenant_id uuid
) returns setof public.tickets
language sql
stable
as $$
  select t.*
  from public.tickets t
  where t.tenant_id = p_tenant_id
    and t.assigned_vendor_id = p_vendor_id
    and t.ticket_kind = 'work_order';
$$;

comment on function public.tickets_visible_for_vendor(uuid, uuid) is
  'Vendor-scoped ticket visibility. Returns work-order tickets where the vendor is the explicit assignee. Companion to tickets_visible_for_actor(p_user_id,...). Used by /vendor/work-orders + Wave-2 fulfillment_units_v vendor consumers.';

commit;

notify pgrst, 'reload schema';
