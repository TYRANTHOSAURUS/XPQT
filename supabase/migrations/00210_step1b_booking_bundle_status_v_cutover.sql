-- Step 1b cutover #3: rewrite booking_bundle_status_v to read its
-- bundle_tickets CTE from public.work_orders instead of tickets-with-filter.
--
-- The bundle_tickets CTE was the only ticket-aware reference in the rollup.
-- Cutting it over to work_orders is a one-line change:
--   FROM:  left join public.tickets t on t.booking_bundle_id = b.id
--                                    and t.ticket_kind = 'work_order'
--   TO:    left join public.work_orders t on t.booking_bundle_id = b.id
--
-- The work_orders view already filters ticket_kind='work_order' internally,
-- so the rows produced are identical.
--
-- This view is used by the booking detail / me-bookings UIs to render a
-- bundle's overall status — high blast radius if it regresses, so we verify
-- row equivalence on remote post-migration before committing.
--
-- DROP + CREATE because we use the same column shape as 00185 — pure source
-- swap. View has no DB-level dependents (no other view, function, or trigger
-- references it).

drop view if exists public.booking_bundle_status_v;

create view public.booking_bundle_status_v as
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
  -- Step 1b cutover: was `left join public.tickets t on t.booking_bundle_id=b.id and t.ticket_kind='work_order'`.
  -- public.work_orders already filters ticket_kind='work_order' internally.
  left join public.work_orders t on t.booking_bundle_id = b.id
  group by b.id
)
select b.id as bundle_id,
       b.tenant_id,
       case
         -- 1. No linked entities yet.
         when (
           coalesce(array_length(br.reservation_statuses, 1), 0) +
           coalesce(array_length(bo.order_statuses, 1), 0) +
           coalesce(array_length(bt.ticket_statuses, 1), 0)
         ) = 0 then 'pending'

         -- 2. Anything awaiting approval.
         when 'pending_approval' = any(coalesce(br.reservation_statuses, '{}')) or
              'submitted' = any(coalesce(bo.order_statuses, '{}'))
           then 'pending_approval'

         -- 3. All sub-entities are terminal. Distinguish full-cancel from
         --    partial-activity. Any non-cancellation evidence (fulfilled,
         --    released, or any ticket existing at all — closed or resolved
         --    both count as "work was tracked") flips to partial.
         when (br.reservation_statuses is null or br.reservation_statuses <@ array['cancelled','released']) and
              (bo.order_statuses is null or bo.order_statuses <@ array['cancelled','fulfilled']) and
              (bt.ticket_statuses is null or bt.ticket_statuses <@ array['closed','resolved'])
           then case
                  when 'fulfilled' = any(coalesce(bo.order_statuses, '{}'))
                    or 'released' = any(coalesce(br.reservation_statuses, '{}'))
                    or (bt.ticket_statuses is not null
                        and array_length(bt.ticket_statuses, 1) > 0)
                  then 'partially_cancelled'
                  else 'cancelled'
                end

         -- 4. A cancellation in any root with non-terminal siblings.
         when 'cancelled' = any(coalesce(br.reservation_statuses, '{}')) or
              'cancelled' = any(coalesce(bo.order_statuses, '{}'))
           then 'partially_cancelled'

         -- 5. Open work-order alongside a terminal sibling.
         when bt.ticket_statuses is not null
              and exists (
                select 1
                from unnest(bt.ticket_statuses) as st(s)
                where st.s not in ('closed', 'resolved')
              )
              and (
                'cancelled' = any(coalesce(br.reservation_statuses, '{}'))
                or 'released' = any(coalesce(br.reservation_statuses, '{}'))
                or 'cancelled' = any(coalesce(bo.order_statuses, '{}'))
                or 'fulfilled' = any(coalesce(bo.order_statuses, '{}'))
              )
           then 'partially_cancelled'

         -- 6. Default: bundle is alive and proceeding normally.
         else 'confirmed'
       end as status_rollup,
       br.reservation_statuses,
       bo.order_statuses,
       bt.ticket_statuses
from public.booking_bundles b
left join bundle_reservations br on br.bundle_id = b.id
left join bundle_orders bo on bo.bundle_id = b.id
left join bundle_tickets bt on bt.bundle_id = b.id;

comment on view public.booking_bundle_status_v is
  'Bundle status rollup across reservations, orders, and work-order tickets. Step 1b (00210): work-order half sources from public.work_orders. See 00185 for the rollup state-machine specification — unchanged here, only the source.';

notify pgrst, 'reload schema';
