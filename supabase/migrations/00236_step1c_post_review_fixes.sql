-- Post-1c.10c codex review fixes (round 2). Three issues:
--
-- 1. (CRITICAL) 00234 was a no-op. The DO block filtered FK constraints
--    by `pg_get_constraintdef() like '%public.tickets%'` — but
--    pg_get_constraintdef OMITS the schema qualifier, so the LIKE
--    matched nothing. The FK on sla_threshold_crossings.ticket_id is
--    still ON DELETE CASCADE to tickets, exactly the bug 00234 was
--    supposed to fix. Drop by name now.
--
-- 2. (HIGH) The activities table has no entity-kind/entity-id integrity
--    guard. A writer could insert (entity_kind='case', entity_id=
--    work_order_uuid) with no constraint catching it. Add a BEFORE
--    INSERT/UPDATE trigger that asserts the id exists in the matching
--    table.
--
-- 3. (CONFIRMED MISS — same broken pattern in 00233 dropped the FKs
--    on sla_timers/routing_decisions/workflow_instances correctly
--    because the loop in 00233 used a different LIKE that did match.
--    But verify all four are gone.)

-- ── 1. Drop sla_threshold_crossings.ticket_id FK (by name) ────
alter table public.sla_threshold_crossings
  drop constraint if exists sla_threshold_crossings_ticket_id_fkey;

-- ── 2. Activities entity-kind/entity-id integrity guard ──────
create or replace function public.assert_activities_entity_kind_matches_id()
returns trigger
language plpgsql
as $$
begin
  -- The 'ticket' transitional umbrella value is allowed for legacy
  -- backfilled rows (00202) — no integrity check (could be either).
  if new.entity_kind = 'ticket' then return new; end if;

  if new.entity_kind = 'case' then
    if not exists (select 1 from public.tickets where id = new.entity_id) then
      raise exception 'activities: entity_kind=case but entity_id % not found in tickets', new.entity_id;
    end if;
    return new;
  end if;

  if new.entity_kind = 'work_order' then
    if not exists (select 1 from public.work_orders where id = new.entity_id) then
      raise exception 'activities: entity_kind=work_order but entity_id % not found in work_orders', new.entity_id;
    end if;
    return new;
  end if;

  -- Other kinds (booking, reservation, order, service_order) are accepted
  -- without an existence check — those tables haven't been wired up yet
  -- and would each need their own kind in this trigger when added.
  return new;
end;
$$;

drop trigger if exists trg_assert_activities_entity_kind_matches_id on public.activities;
create trigger trg_assert_activities_entity_kind_matches_id
before insert or update of entity_kind, entity_id on public.activities
for each row execute function public.assert_activities_entity_kind_matches_id();

comment on function public.assert_activities_entity_kind_matches_id() is
  'Step 1c (00236): entity_kind/entity_id integrity for the activities polymorphic table. Prevents (kind=case, id=wo_uuid) and similar lies. Allows transitional kind=''ticket'' without check (legacy backfill rows from 00202).';

notify pgrst, 'reload schema';
