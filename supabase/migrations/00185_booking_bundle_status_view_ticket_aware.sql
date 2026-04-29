-- 00185_booking_bundle_status_view_ticket_aware.sql
-- 00148 collected ticket_statuses but the CASE rollup never inspected them,
-- so an open work-order under a bundle could be hidden behind a confirmed
-- reservation + approved orders. This makes the rollup ticket-aware:
--
--   * 'cancelled' rollup now requires every work-order ticket to be terminal
--     (closed or resolved). A bundle with terminal reservations + orders +
--     a still-open work-order falls through to 'partially_cancelled' or
--     'confirmed' instead of being mislabelled.
--
--   * 'partially_cancelled' picks up these signals of partial activity:
--       - any 'fulfilled' order
--       - any 'released' reservation (room was let go, not strictly cancelled)
--       - any non-empty ticket bag (closed/resolved/in-flight) — work was
--         tracked at some point, so the bundle is not a clean full cancel.
--     This symmetrises closed vs resolved (codex 2026-04-29 review).
--
--   * Open work-order alongside any terminal sibling → 'partially_cancelled'.
--     'released' reservations now trigger this branch too (codex 2026-04-29).
--
-- Status names this view emits stay the same:
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

         -- 5. Open work-order alongside a terminal sibling (cancelled,
         --    released, or fulfilled). Means part of the bundle has wound
         --    down while work is still owed elsewhere.
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

notify pgrst, 'reload schema';
