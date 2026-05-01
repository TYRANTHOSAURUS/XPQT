-- Step 1c.10c prep (Commit B): make the polymorphic auto-derive trigger
-- robust to both pre- and post-cutover schemas.
--
-- 00230's derive trigger queries tickets.ticket_kind to determine whether
-- ticket_id refers to a case or a work_order. Post-1c.10c, ticket_kind is
-- dropped from tickets, and tickets is case-only. The trigger would error
-- on the missing column.
--
-- Rewrite to use existence-check across BOTH tables:
--   - if ticket_id exists in public.tickets   → entity_kind='case'
--   - if ticket_id exists in public.work_orders → entity_kind='work_order'
--   - neither (deleted concurrently) → leave polymorphic null
--
-- This works pre-cutover (case ids in tickets, wo ids in work_orders thanks
-- to UUID reuse) AND post-cutover (tickets is case-only, work_orders is
-- wo-only). No reliance on ticket_kind.

create or replace function public.derive_polymorphic_entity_from_ticket_id()
returns trigger
language plpgsql
as $$
begin
  if new.entity_kind is not null then
    return new;
  end if;
  if new.ticket_id is null then
    return new;
  end if;

  -- Check tickets first (cases). After 1c.10c tickets is case-only.
  if exists (select 1 from public.tickets where id = new.ticket_id) then
    new.entity_kind := 'case';
    new.case_id := new.ticket_id;
    return new;
  end if;

  -- Fall back to work_orders. Post-1c.10c the wo rows live only here.
  if exists (select 1 from public.work_orders where id = new.ticket_id) then
    new.entity_kind := 'work_order';
    new.work_order_id := new.ticket_id;
    return new;
  end if;

  -- ticket_id points nowhere (concurrent delete?). Leave polymorphic null;
  -- the kind_matches_fk constraint accepts (null, null, null).
  return new;
end;
$$;

comment on function public.derive_polymorphic_entity_from_ticket_id() is
  'Step 1c.6/7/8 follow-up (00230) + 1c.10c prep (00232). Existence-check across tickets and work_orders — robust to ticket_kind being dropped at 1c.10c. BEFORE INSERT trigger on sla_timers, workflow_instances, routing_decisions.';

notify pgrst, 'reload schema';
