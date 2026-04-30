-- Step 1c.6 of docs/data-model-step1c-plan.md: sla_timers polymorphic FK.
--
-- Today: sla_timers.ticket_id FK to tickets. Both case timers and
-- work_order timers point at the tickets row.
--
-- Step 1c.6 adds polymorphic columns alongside ticket_id (additive, no
-- breaking change):
--   entity_kind text — 'case' | 'work_order'
--   case_id uuid     — FK to tickets when entity_kind='case'
--   work_order_id    — FK to work_orders when entity_kind='work_order'
--
-- Backfill from existing ticket_id + tickets.ticket_kind. Application code
-- continues using ticket_id for now; future phases switch to entity-aware
-- queries. ticket_id stays until 1c.10c when the bridge drops.

-- ── 1. Add polymorphic columns ───────────────────────────────
alter table public.sla_timers
  add column if not exists entity_kind text
    check (entity_kind in ('case', 'work_order')),
  add column if not exists case_id uuid references public.tickets(id) on delete cascade,
  add column if not exists work_order_id uuid references public.work_orders(id) on delete cascade;

-- ── 2. Backfill from existing ticket_id ──────────────────────
update public.sla_timers st
set
  entity_kind = case t.ticket_kind when 'work_order' then 'work_order' else 'case' end,
  case_id = case when t.ticket_kind = 'case' then t.id else null end,
  work_order_id = case when t.ticket_kind = 'work_order' then t.id else null end
from public.tickets t
where t.id = st.ticket_id
  and st.entity_kind is null;

-- ── 3. Integrity constraint: kind matches FK ──────────────────
alter table public.sla_timers
  add constraint sla_timers_kind_matches_fk
  check (
    (entity_kind is null and case_id is null and work_order_id is null)
    or (entity_kind = 'case'       and case_id is not null and work_order_id is null)
    or (entity_kind = 'work_order' and case_id is null     and work_order_id is not null)
  );

-- ── 4. Indexes for entity-aware lookups ──────────────────────
create index if not exists idx_sla_timers_case_id
  on public.sla_timers (case_id) where case_id is not null;
create index if not exists idx_sla_timers_work_order_id
  on public.sla_timers (work_order_id) where work_order_id is not null;

-- ── 5. Verification: pre-flight totals match ─────────────────
do $$
declare
  v_case_count int;
  v_wo_count int;
  v_total int;
begin
  select count(*) into v_case_count from public.sla_timers where entity_kind = 'case';
  select count(*) into v_wo_count from public.sla_timers where entity_kind = 'work_order';
  select count(*) into v_total from public.sla_timers;
  if v_case_count + v_wo_count != v_total then
    raise exception 'sla_timers backfill incomplete: case=% wo=% total=%',
      v_case_count, v_wo_count, v_total;
  end if;
  raise notice 'sla_timers backfill: case=% wo=% total=%', v_case_count, v_wo_count, v_total;
end $$;

notify pgrst, 'reload schema';
