-- Step 1c.6/7/8 follow-up: auto-derive polymorphic columns on insert.
--
-- The full-review of commit ffc6fc4 caught a critical drift bug:
--
--   sla.service.ts, routing.service.ts, workflow-engine.service.ts all
--   write only `ticket_id` to their respective tables. The polymorphic
--   columns added in 1c.6/7/8 (entity_kind, case_id, work_order_id) stay
--   NULL on every new row post-migration. The kind_matches_fk constraint
--   permits (null, null, null), so the writes succeed silently. By
--   1c.10c when the polymorphic columns become source-of-truth, every
--   row written between 1c.6 and 1c.10c is polymorphically blank.
--
-- Fix: BEFORE INSERT triggers that derive entity_kind + case_id +
-- work_order_id from ticket_id when the polymorphic columns are NULL.
-- Application code can keep writing only ticket_id; the trigger fills
-- the rest. After 1c.10c when ticket_id is dropped, application code
-- must write entity_kind directly — handled at that migration.

-- ── Shared derive function ────────────────────────────────────
create or replace function public.derive_polymorphic_entity_from_ticket_id()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  -- Only auto-derive if entity_kind is null AND ticket_id is set.
  -- If the writer already populated polymorphic columns, leave alone.
  if new.entity_kind is not null then
    return new;
  end if;
  if new.ticket_id is null then
    return new;
  end if;

  select case t.ticket_kind when 'work_order' then 'work_order' else 'case' end
    into v_kind
  from public.tickets t
  where t.id = new.ticket_id;

  if v_kind is null then
    -- Source ticket doesn't exist (deleted concurrently?). Don't fail
    -- the parent INSERT — leave columns null and let the kind_matches_fk
    -- constraint pass via the (null, null, null) branch.
    return new;
  end if;

  new.entity_kind := v_kind;
  if v_kind = 'case' then
    new.case_id := new.ticket_id;
  else
    new.work_order_id := new.ticket_id;
  end if;
  return new;
end;
$$;

comment on function public.derive_polymorphic_entity_from_ticket_id() is
  'Step 1c.6/7/8 follow-up (00230). BEFORE INSERT trigger that derives entity_kind + case_id/work_order_id from ticket_id when application code only sets ticket_id. Drops at 1c.10c when ticket_id is removed.';

-- ── sla_timers ────────────────────────────────────────────────
drop trigger if exists sla_timers_derive_polymorphic_trg on public.sla_timers;
create trigger sla_timers_derive_polymorphic_trg
before insert on public.sla_timers
for each row execute function public.derive_polymorphic_entity_from_ticket_id();

-- ── workflow_instances ────────────────────────────────────────
drop trigger if exists workflow_instances_derive_polymorphic_trg on public.workflow_instances;
create trigger workflow_instances_derive_polymorphic_trg
before insert on public.workflow_instances
for each row execute function public.derive_polymorphic_entity_from_ticket_id();

-- ── routing_decisions ─────────────────────────────────────────
drop trigger if exists routing_decisions_derive_polymorphic_trg on public.routing_decisions;
create trigger routing_decisions_derive_polymorphic_trg
before insert on public.routing_decisions
for each row execute function public.derive_polymorphic_entity_from_ticket_id();

notify pgrst, 'reload schema';
