-- Slice C — PM generator §4: completion hook.
--
-- Spec: ai/slice-c-plan.md §4 (lines 253-285).
--
-- Fires inside the transaction that 00325 transition_entity_status uses
-- to stamp resolved_at on work_orders (00325:236-255). The trigger
-- updates the WO's maintenance_plans row with the resolved_at as the
-- last_completed_at, defending cross-tenant via the WHERE-clause
-- tenant_id match (composite FK from 00387 already guarantees the
-- pair, this is belt + braces).
--
-- Deadlock surface (ai/slice-c-plan.md §4 lines 283-286): generator
-- locks plan FOR UPDATE then inserts WO (plans → work_orders order);
-- this trigger updates plan after WO update (work_orders → plans
-- order). Two concurrent transactions in opposite lock order *could*
-- deadlock, but the generator's lock-then-write is fast (one plan row,
-- one WO insert). Acceptable for v1; revisit if monitoring shows
-- contention.

create or replace function public.tg_pm_plan_last_completed_at() returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if new.maintenance_plan_id is not null
     and new.resolved_at is not null
     and (old.resolved_at is null or old.resolved_at <> new.resolved_at)
  then
    update public.maintenance_plans
       set last_completed_at = new.resolved_at,
           updated_at        = now()
     where id        = new.maintenance_plan_id
       and tenant_id = new.tenant_id;
  end if;
  return new;
end;
$$;

create trigger tg_pm_plan_last_completed_at
  after update of resolved_at on public.work_orders
  for each row
  execute function public.tg_pm_plan_last_completed_at();

comment on function public.tg_pm_plan_last_completed_at() is
  'Slice C §4 — stamps maintenance_plans.last_completed_at when a PM-origin work order transitions into resolved status. Fires AFTER UPDATE OF resolved_at on work_orders.';

notify pgrst, 'reload schema';
