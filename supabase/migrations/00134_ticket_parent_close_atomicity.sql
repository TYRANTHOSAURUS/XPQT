-- 00134_ticket_parent_close_atomicity.sql
-- Closes the parent-close vs. child-open race on tickets, mirroring the
-- pattern used in 00082 for org_nodes.
--
-- The application-layer guard in TicketService.update() does:
--   1. SELECT open children of the case
--   2. UPDATE the case to closed/resolved if none
--
-- Under READ COMMITTED isolation a concurrent transaction can INSERT or
-- UPDATE a child between (1) and (2), and both transactions commit clean —
-- leaving a closed parent with open children, which the rest of the system
-- (queue counts, SLA, dispatch) treats as undefined behaviour.
--
-- Fix: a BEFORE INSERT/UPDATE trigger on tickets that, when relevant, takes
-- a transaction-scoped advisory lock keyed off the *parent* ticket id and
-- enforces the invariant from inside the database. Two complementary
-- guards:
--   • Closing a case → reject if any child is in an open status_category.
--   • Opening a child (or moving it back from terminal) → reject if the
--     parent has already moved to a terminal status_category.
--
-- Both code paths take the same advisory lock, so they serialise on the
-- parent's id and the in-flight transactions can never both win.

create or replace function public.enforce_ticket_parent_close_invariant()
returns trigger language plpgsql as $$
declare
  v_parent_status text;
  v_open_count int;
  v_lock_key uuid;
begin
  -- ── Path A: a case is being moved to a terminal status_category ──────
  -- Only run on transitions; row-rewrites that keep status_category
  -- unchanged shouldn't pay the lock cost.
  if NEW.ticket_kind = 'case'
     and NEW.status_category in ('resolved', 'closed')
     and (TG_OP = 'INSERT' or OLD.status_category is distinct from NEW.status_category)
  then
    perform pg_advisory_xact_lock(hashtextextended(NEW.id::text, 0));

    select count(*) into v_open_count
      from public.tickets
     where parent_ticket_id = NEW.id
       and tenant_id = NEW.tenant_id
       and status_category not in ('resolved', 'closed');

    if v_open_count > 0 then
      raise exception
        'cannot move case % to % while % child ticket(s) remain open',
        NEW.id, NEW.status_category, v_open_count
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── Path B: a child work order is being inserted/reopened under a
  -- parent that's already terminal. Without this guard the race we close
  -- in Path A reappears in the opposite direction.
  if NEW.parent_ticket_id is not null
     and NEW.status_category not in ('resolved', 'closed')
     and (
       TG_OP = 'INSERT'
       or OLD.parent_ticket_id is distinct from NEW.parent_ticket_id
       or (
         OLD.status_category in ('resolved', 'closed')
         and NEW.status_category not in ('resolved', 'closed')
       )
     )
  then
    v_lock_key := NEW.parent_ticket_id;
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key::text, 0));

    select status_category into v_parent_status
      from public.tickets
     where id = NEW.parent_ticket_id
       and tenant_id = NEW.tenant_id;

    if v_parent_status in ('resolved', 'closed') then
      raise exception
        'cannot place child ticket under parent % which is already %',
        NEW.parent_ticket_id, v_parent_status
        using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_ticket_parent_close_invariant on public.tickets;
create trigger trg_ticket_parent_close_invariant
  before insert or update on public.tickets
  for each row execute function public.enforce_ticket_parent_close_invariant();

comment on function public.enforce_ticket_parent_close_invariant() is
  'Race-safe enforcement of the case/child status invariant. See 00134.';
