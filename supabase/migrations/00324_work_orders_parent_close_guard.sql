-- 00324_work_orders_parent_close_guard.sql
--
-- B.2.A §3.1 review fix C1 — close the parent/child terminal-status race
-- on the work_orders side.
--
-- Background:
--   00134 (ticket_parent_close_atomicity) shipped a two-direction guard:
--     Path A — closing a parent fails if any open child remains.
--     Path B — opening (or reopening) a child fails if the parent is
--              already terminal.
--   Both paths take the same advisory lock keyed on the parent ticket
--   id, so the close-vs-open race serialises through Postgres.
--
--   00233 (step1c10c destructive cutover, lines 117-150) dropped Path B
--   when the children moved out of `tickets` and into `work_orders`.
--   It re-created Path A on `tickets` (parent-close → check open WO
--   children) but never recreated Path B on the new `work_orders`
--   table. That left a window where:
--     TX A: select FOR UPDATE on the parent → 0 open children
--     TX B: insert child WO with parent_ticket_id = parent
--     TX A: update parent SET status_category = 'closed' → commit
--     TX B: commit child WO
--   Outcome: terminal parent with an open child WO; the rest of the
--   system (queue counts, SLA pause/resume, dispatch readiness) treats
--   that combination as undefined behaviour.
--
--   The §3.1 RPC `transition_entity_status` (00323:193-205) inherits
--   this race because it relies on FOR UPDATE on the parent — that
--   row lock does NOT block concurrent INSERT into work_orders, only
--   concurrent UPDATEs of the same parent row.
--
-- Fix:
--   Mirror Path B from 00134 on `work_orders`. BEFORE INSERT or UPDATE
--   of `parent_ticket_id` / `status_category` on `work_orders`, take
--   the same advisory lock the parent-close path will take, then read
--   the parent's status_category and reject if it is already terminal
--   AND the new child status is non-terminal (i.e. either inserting
--   under a closed parent or reopening a child of a closed parent).
--
--   The advisory lock keyed on `parent_ticket_id::text` is the same
--   key 00233's `enforce_ticket_parent_close_invariant` will acquire
--   when the parent moves to terminal — so the close-vs-open race
--   serialises across both tables via one shared advisory key.
--
-- Citations:
--   - 00134:38-83 — original Path B on the legacy single-table model.
--   - 00233:117-150 — Path A re-creation that left Path B dropped.
--   - 00323:193-205 — RPC's open-children check (inside the parent FOR
--     UPDATE, which doesn't block child INSERTs on its own).

-- ── 1. Re-add Path B on the parent-close advisory lock ───────────────
-- The trigger fires on:
--   * INSERT (any new child WO) — locks the parent and rejects if
--     parent is terminal and child is non-terminal.
--   * UPDATE OF status_category — child reopen (terminal → non-terminal)
--     re-checks the parent.
--   * UPDATE OF parent_ticket_id — re-parenting under a different
--     parent re-checks the new parent.
create or replace function public.enforce_work_order_parent_open_invariant()
returns trigger
language plpgsql
as $$
declare
  v_parent_status_category text;
  v_terminal               text[] := array['resolved', 'closed'];
begin
  -- Skip when there's no parent reference to check.
  if NEW.parent_ticket_id is null then
    return NEW;
  end if;

  -- Only enforce when the new child is in a non-terminal state. A
  -- child INSERT/UPDATE that lands directly in a terminal category
  -- (e.g. backfill of a historic completed WO) doesn't violate the
  -- invariant — a terminal child under a terminal parent is fine.
  if NEW.status_category = any(v_terminal) then
    return NEW;
  end if;

  -- Only check on:
  --   * any INSERT,
  --   * UPDATE that moves status_category out of terminal (reopen),
  --   * UPDATE that re-targets parent_ticket_id.
  if TG_OP = 'UPDATE'
     and OLD.parent_ticket_id is not distinct from NEW.parent_ticket_id
     and OLD.status_category   is not distinct from NEW.status_category
  then
    return NEW;
  end if;
  if TG_OP = 'UPDATE'
     and OLD.parent_ticket_id is not distinct from NEW.parent_ticket_id
     and not (OLD.status_category = any(v_terminal))
  then
    -- status_category changed but child wasn't reopening from terminal;
    -- nothing to enforce here.
    return NEW;
  end if;

  -- Same advisory key the case-side parent-close trigger acquires
  -- (00233:117-150 → enforce_ticket_parent_close_invariant fires before
  -- a parent close and serialises on hashtextextended(<parent_id>, 0)).
  -- Both directions race through this single key.
  perform pg_advisory_xact_lock(hashtextextended(NEW.parent_ticket_id::text, 0));

  select status_category
    into v_parent_status_category
    from public.tickets
   where id = NEW.parent_ticket_id
     and tenant_id = NEW.tenant_id;

  if v_parent_status_category is null then
    -- Parent missing or in a different tenant — defer to the FK +
    -- visibility checks rather than raising a parent_terminal error
    -- (which would be misleading).
    return NEW;
  end if;

  if v_parent_status_category = any(v_terminal) then
    raise exception
      'work_order.parent_terminal: parent_ticket_id=% is %',
      NEW.parent_ticket_id, v_parent_status_category
      using errcode = 'P0001';
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_work_order_parent_open_invariant on public.work_orders;
create trigger trg_work_order_parent_open_invariant
  before insert or update of parent_ticket_id, status_category
  on public.work_orders
  for each row execute function public.enforce_work_order_parent_open_invariant();

comment on function public.enforce_work_order_parent_open_invariant() is
  'Race-safe Path B for work_orders: rejects insert/reopen of a child WO under a parent ticket already in terminal status_category. Pairs with enforce_ticket_parent_close_invariant (00233) on the same advisory key. Restores the invariant 00134 originally provided before the 1c.10c cutover dropped it.';

notify pgrst, 'reload schema';
