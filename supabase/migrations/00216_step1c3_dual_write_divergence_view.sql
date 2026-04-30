-- Step 1c.3 monitoring: a view that counts divergence between
-- tickets-where-ticket_kind=work_order and work_orders_new.
--
-- During the dual-write soak (1c.3 → 1c.4), a daily cron should:
--   select * from public.work_orders_dual_write_divergence_v;
-- and alert if any row has divergence_count > 0.
--
-- Three classes of divergence are monitored:
--   1. counts_mismatch: tickets has N, work_orders_new has M, N != M
--   2. only_in_tickets: WO row in tickets that has no work_orders_new mirror
--   3. only_in_won:     work_orders_new row whose legacy_ticket_id no longer
--                       maps to a work_order row in tickets
--
-- The intent is: zero divergence ever. Any non-zero is a bug.

create or replace view public.work_orders_dual_write_divergence_v as
with
counts as (
  select 'counts_mismatch' as kind,
         abs(
           (select count(*) from public.tickets where ticket_kind = 'work_order')
           - (select count(*) from public.work_orders_new)
         ) as divergence_count
),
only_in_tickets as (
  select 'only_in_tickets' as kind,
         count(*) as divergence_count
  from public.tickets t
  where t.ticket_kind = 'work_order'
    and not exists (
      select 1 from public.work_orders_new won
       where won.legacy_ticket_id = t.id
    )
),
only_in_won as (
  select 'only_in_won' as kind,
         count(*) as divergence_count
  from public.work_orders_new won
  where won.legacy_ticket_id is not null
    and not exists (
      select 1 from public.tickets t
       where t.id = won.legacy_ticket_id
         and t.ticket_kind = 'work_order'
    )
)
select * from counts
union all
select * from only_in_tickets
union all
select * from only_in_won;

comment on view public.work_orders_dual_write_divergence_v is
  'Step 1c.3 dual-write monitoring. Each row reports a divergence-count by class. Daily cron should alert on any non-zero. Drops at phase 1c.10c when the dual-write window closes.';

revoke all on public.work_orders_dual_write_divergence_v from anon, authenticated, public;
grant select on public.work_orders_dual_write_divergence_v to service_role;

notify pgrst, 'reload schema';
