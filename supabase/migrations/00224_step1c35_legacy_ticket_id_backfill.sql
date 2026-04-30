-- Step 1c.3.5 follow-up: BEFORE INSERT trigger to backfill legacy_ticket_id.
--
-- 00223 added pg_trigger_depth() > 1 guard to the forward trigger to fix
-- the per-column IS DISTINCT FROM gap. But that broke the legacy_ticket_id
-- backfill chain that previously worked via:
--   reverse INSERT tickets → forward fires → ON CONFLICT DO UPDATE sets
--   legacy_ticket_id via coalesce
--
-- Now forward skips at depth=2, so legacy_ticket_id stays NULL on native
-- writes. The divergence view's `won_missing_legacy` class would start
-- showing non-zero counts, defeating the purpose of the signal.
--
-- Fix: BEFORE INSERT trigger on work_orders that sets legacy_ticket_id =
-- id when null. This runs at depth=1 (it's a BEFORE on the INSERT itself,
-- not nested), and ensures the invariant "every work_orders row has
-- legacy_ticket_id set" holds across both bridge directions.
--
-- Caught by stress test R1: expected legacy_ticket_id backfill, got NULL.

create or replace function public.work_orders_backfill_legacy_ticket_id()
returns trigger
language plpgsql
as $$
begin
  -- Conceptually: legacy_ticket_id == id always (since work_orders.id
  -- == tickets.id by design — UUID reuse from 1c.2 backfill). Set it
  -- explicitly so the divergence view's `won_missing_legacy` class stays
  -- a real signal post-1c.4.
  if new.legacy_ticket_id is null then
    new.legacy_ticket_id := new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists work_orders_backfill_legacy_ticket_id_trg on public.work_orders;
create trigger work_orders_backfill_legacy_ticket_id_trg
before insert on public.work_orders
for each row execute function public.work_orders_backfill_legacy_ticket_id();

comment on function public.work_orders_backfill_legacy_ticket_id() is
  'Step 1c.3.5 (00224) — auto-set legacy_ticket_id = id on INSERT when null. Required because depth-based loop guard (00223) breaks the prior on-conflict backfill chain. Drops at phase 1c.10c with the legacy_ticket_id column.';

notify pgrst, 'reload schema';
