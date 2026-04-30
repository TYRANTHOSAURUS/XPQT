-- Step 1c.5 of docs/data-model-step1c-plan.md: parent/child rollup on
-- work_orders.
--
-- 00030 installed rollup_parent_status_trg on `tickets` filtered by
-- ticket_kind='work_order'. Post-1c.4, work_order writes go to
-- public.work_orders. The rollup still works indirectly because the
-- reverse shadow trigger mirrors writes back to tickets which fires the
-- old rollup. But that adds a hop and depends on the bridge.
--
-- Cleanup: install a parallel rollup trigger on public.work_orders that
-- fires directly. The old trigger on tickets stays during the bridge —
-- when both fire on the same logical event (forward path), they hit the
-- same parent and the second is a no-op. Drops with the dual-write
-- infrastructure at 1c.10c.
--
-- Why parallel (not replace): if the bridge propagation order ever flips,
-- we want the rollup to run regardless of which side the write hit first.
-- Two firings on the same parent are idempotent (both write the same
-- status_category and the WHERE clause filters on "not already in this
-- state"). Belt and suspenders.

create or replace function public.rollup_parent_status_from_work_orders()
returns trigger
language plpgsql
as $$
declare
  any_in_progress boolean;
  any_open boolean;
begin
  if new.parent_ticket_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status_category is not distinct from old.status_category then
    return new;
  end if;

  -- Aggregate sibling work_orders status from public.work_orders (canonical).
  select
    bool_or(status_category = 'in_progress'),
    bool_or(status_category not in ('resolved', 'closed'))
  into any_in_progress, any_open
  from public.work_orders
  where parent_ticket_id = new.parent_ticket_id;

  any_in_progress := coalesce(any_in_progress, false);
  any_open        := coalesce(any_open, false);

  if any_in_progress then
    update public.tickets
    set status_category = 'in_progress'
    where id = new.parent_ticket_id
      and status_category not in ('in_progress', 'resolved', 'closed');
  elsif any_open then
    update public.tickets
    set status_category = 'assigned'
    where id = new.parent_ticket_id
      and status_category not in ('assigned', 'in_progress', 'resolved', 'closed');
  else
    update public.tickets
    set status_category = 'resolved',
        resolved_at = coalesce(resolved_at, now())
    where id = new.parent_ticket_id
      and status_category not in ('resolved', 'closed');
  end if;

  return new;
end;
$$;

drop trigger if exists rollup_parent_status_from_work_orders_trg on public.work_orders;
create trigger rollup_parent_status_from_work_orders_trg
  after insert or update of status_category on public.work_orders
  for each row
  when (new.parent_ticket_id is not null)
  execute function public.rollup_parent_status_from_work_orders();

comment on function public.rollup_parent_status_from_work_orders() is
  'Step 1c.5 (00226): rollup parent case status from work_orders direct. Parallel to 00030 rollup_parent_status which fires on tickets. Both can fire on the same logical event during the bridge; the WHERE clauses make the second firing a no-op.';

notify pgrst, 'reload schema';
