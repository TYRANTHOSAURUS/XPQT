-- Step 1c.7: workflow_instances polymorphic FK (parallel to 1c.6 sla_timers).
--
-- workflow_instances.ticket_id FK to tickets today. Workflows can be
-- attached to either a case OR a work_order. Adds entity_kind + case_id +
-- work_order_id (additive). Backfills from tickets.ticket_kind.

alter table public.workflow_instances
  add column if not exists entity_kind text
    check (entity_kind in ('case', 'work_order')),
  add column if not exists case_id uuid references public.tickets(id) on delete cascade,
  add column if not exists work_order_id uuid references public.work_orders(id) on delete cascade;

update public.workflow_instances wi
set
  entity_kind = case t.ticket_kind when 'work_order' then 'work_order' else 'case' end,
  case_id = case when t.ticket_kind = 'case' then t.id else null end,
  work_order_id = case when t.ticket_kind = 'work_order' then t.id else null end
from public.tickets t
where t.id = wi.ticket_id
  and wi.entity_kind is null;

alter table public.workflow_instances
  add constraint workflow_instances_kind_matches_fk
  check (
    (entity_kind is null and case_id is null and work_order_id is null)
    or (entity_kind = 'case'       and case_id is not null and work_order_id is null)
    or (entity_kind = 'work_order' and case_id is null     and work_order_id is not null)
  );

create index if not exists idx_workflow_instances_case_id
  on public.workflow_instances (case_id) where case_id is not null;
create index if not exists idx_workflow_instances_work_order_id
  on public.workflow_instances (work_order_id) where work_order_id is not null;

do $$
declare v_case int; v_wo int; v_total int;
begin
  select count(*) into v_case from public.workflow_instances where entity_kind = 'case';
  select count(*) into v_wo from public.workflow_instances where entity_kind = 'work_order';
  select count(*) into v_total from public.workflow_instances;
  if v_case + v_wo != v_total then
    raise exception 'workflow_instances backfill incomplete: case=% wo=% total=%', v_case, v_wo, v_total;
  end if;
  raise notice 'workflow_instances backfill: case=% wo=% total=%', v_case, v_wo, v_total;
end $$;

notify pgrst, 'reload schema';
