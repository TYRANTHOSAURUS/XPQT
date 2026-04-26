-- 00148_booking_bundle_status_view.sql
-- Lazy status_rollup: derived at read time from linked entities.
-- This avoids a denormalised column that would need recomputation triggers
-- on every reservation/order/ticket status change.
--
-- The CASE ladder mirrors spec §3.3:
--   pending           — bundle exists but nothing is linked yet
--   pending_approval  — anything is awaiting approval
--   cancelled         — every linked entity is cancelled/closed
--   partially_cancelled — some cancelled, some still alive (incl. fulfilled)
--   confirmed         — everything else
--
-- Status names this view emits:
--   'pending' | 'pending_approval' | 'confirmed' | 'partially_cancelled' | 'cancelled'

create or replace view public.booking_bundle_status_v as
with bundle_reservations as (
  select b.id as bundle_id,
         array_agg(r.status) filter (where r.id is not null) as reservation_statuses
  from public.booking_bundles b
  left join public.reservations r on r.booking_bundle_id = b.id
  group by b.id
),
bundle_orders as (
  select b.id as bundle_id,
         array_agg(o.status) filter (where o.id is not null) as order_statuses
  from public.booking_bundles b
  left join public.orders o on o.booking_bundle_id = b.id
  group by b.id
),
bundle_tickets as (
  select b.id as bundle_id,
         array_agg(t.status_category) filter (where t.id is not null) as ticket_statuses
  from public.booking_bundles b
  left join public.tickets t on t.booking_bundle_id = b.id and t.ticket_kind = 'work_order'
  group by b.id
)
select b.id as bundle_id,
       b.tenant_id,
       case
         when (
           coalesce(array_length(br.reservation_statuses, 1), 0) +
           coalesce(array_length(bo.order_statuses, 1), 0) +
           coalesce(array_length(bt.ticket_statuses, 1), 0)
         ) = 0 then 'pending'
         when 'pending_approval' = any(coalesce(br.reservation_statuses, '{}')) or
              'submitted' = any(coalesce(bo.order_statuses, '{}'))
           then 'pending_approval'
         when (br.reservation_statuses is null or br.reservation_statuses <@ array['cancelled','released']) and
              (bo.order_statuses is null or bo.order_statuses <@ array['cancelled','fulfilled'])
           then case when 'fulfilled' = any(coalesce(bo.order_statuses, '{}')) then 'partially_cancelled' else 'cancelled' end
         when 'cancelled' = any(coalesce(br.reservation_statuses, '{}')) or
              'cancelled' = any(coalesce(bo.order_statuses, '{}'))
           then 'partially_cancelled'
         else 'confirmed'
       end as status_rollup,
       br.reservation_statuses,
       bo.order_statuses,
       bt.ticket_statuses
from public.booking_bundles b
left join bundle_reservations br on br.bundle_id = b.id
left join bundle_orders bo on bo.bundle_id = b.id
left join bundle_tickets bt on bt.bundle_id = b.id;

-- View inherits RLS from underlying tables; no separate policy needed.

-- Helper: bundle visibility check, used by ServiceCatalogModule + BookingBundlesModule.
-- The Nest-side BundleVisibilityService re-implements the same logic for richer
-- policy hooks; this SQL helper is the canonical fallback for read predicates
-- in views and triggers.
create or replace function public.bundle_is_visible_to_user(
  p_bundle_id uuid,
  p_user_id uuid,
  p_tenant_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_visible boolean;
  v_person_id uuid;
begin
  select person_id into v_person_id
  from public.users
  where id = p_user_id and tenant_id = p_tenant_id;

  select exists (
    select 1 from public.booking_bundles b
    where b.id = p_bundle_id
      and b.tenant_id = p_tenant_id
      and (
        -- Participant: requester / host
        (v_person_id is not null and (b.requester_person_id = v_person_id or b.host_person_id = v_person_id))
        -- Operator / admin via permissions
        or public.user_has_permission(p_user_id, p_tenant_id, 'rooms.read_all')
        or public.user_has_permission(p_user_id, p_tenant_id, 'rooms.admin')
      )
  ) into v_visible;
  return coalesce(v_visible, false);
end;
$$;

grant execute on function public.bundle_is_visible_to_user(uuid, uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
