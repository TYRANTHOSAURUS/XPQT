-- Step 1c.8: routing_decisions polymorphic FK.
--
-- routing_decisions.ticket_id FK to tickets. Both case routing decisions
-- (parent intake) and work_order dispatch decisions live in this table.
-- Add polymorphic columns + backfill.

alter table public.routing_decisions
  add column if not exists entity_kind text
    check (entity_kind in ('case', 'work_order')),
  add column if not exists case_id uuid references public.tickets(id) on delete cascade,
  add column if not exists work_order_id uuid references public.work_orders(id) on delete cascade;

update public.routing_decisions rd
set
  entity_kind = case t.ticket_kind when 'work_order' then 'work_order' else 'case' end,
  case_id = case when t.ticket_kind = 'case' then t.id else null end,
  work_order_id = case when t.ticket_kind = 'work_order' then t.id else null end
from public.tickets t
where t.id = rd.ticket_id
  and rd.entity_kind is null;

alter table public.routing_decisions
  add constraint routing_decisions_kind_matches_fk
  check (
    (entity_kind is null and case_id is null and work_order_id is null)
    or (entity_kind = 'case'       and case_id is not null and work_order_id is null)
    or (entity_kind = 'work_order' and case_id is null     and work_order_id is not null)
  );

create index if not exists idx_routing_decisions_case_id
  on public.routing_decisions (case_id) where case_id is not null;
create index if not exists idx_routing_decisions_work_order_id
  on public.routing_decisions (work_order_id) where work_order_id is not null;

do $$
declare v_case int; v_wo int; v_total int; v_null int;
begin
  select count(*) into v_case from public.routing_decisions where entity_kind = 'case';
  select count(*) into v_wo from public.routing_decisions where entity_kind = 'work_order';
  select count(*) into v_null from public.routing_decisions where entity_kind is null;
  select count(*) into v_total from public.routing_decisions;
  if v_case + v_wo + v_null != v_total then
    raise exception 'routing_decisions backfill mismatch: case=% wo=% null=% total=%', v_case, v_wo, v_null, v_total;
  end if;
  -- Some routing_decisions may have ticket_id=null or pointing at deleted tickets.
  -- Those keep entity_kind=null. Acceptable.
  raise notice 'routing_decisions backfill: case=% wo=% null=% total=%', v_case, v_wo, v_null, v_total;
end $$;

notify pgrst, 'reload schema';
