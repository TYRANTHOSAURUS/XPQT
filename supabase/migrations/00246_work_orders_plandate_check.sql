-- Plandate positivity check on work_orders
--
-- The `planned_start_at` + `planned_duration_minutes` columns were added to
-- work_orders by 00213 (step 1c.1) so the new base table mirrored the same
-- columns 00206 added on tickets. The CHECK constraint that 00206 added on
-- tickets to keep duration positive was NOT carried over to work_orders —
-- silent gap discovered while wiring `WorkOrderService.setPlan`.
--
-- This migration adds the missing constraint so the post-1c.10c work_orders
-- table has the same shape guarantee tickets had pre-1c.10c. Anything that
-- routes plan writes through WorkOrderService is also validated in TS, but
-- we want the DB-level invariant for direct writers (cron jobs, admin SQL,
-- backfills, future replication) too.

alter table public.work_orders
  drop constraint if exists chk_work_orders_planned_duration_positive;
alter table public.work_orders
  add constraint chk_work_orders_planned_duration_positive
  check (planned_duration_minutes is null or planned_duration_minutes > 0);

-- Post-state assertion. Per CLAUDE.md / handoff: never ship a migration
-- without an inline check that the change actually took effect.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from pg_constraint
   where conname = 'chk_work_orders_planned_duration_positive'
     and conrelid = 'public.work_orders'::regclass;
  if v_count <> 1 then
    raise exception
      '00246: chk_work_orders_planned_duration_positive missing on public.work_orders (found % rows)',
      v_count;
  end if;
end $$;

notify pgrst, 'reload schema';
