-- Round 3 codex fixes for post-1c.10c work.
--
-- 1. activities entity_kind='ticket' transitional value bypassed the
--    integrity trigger from 00236 (no existence check). New writers
--    sending entity_kind='ticket' would silently get accepted with
--    arbitrary entity_id. Tighten: 'ticket' is allowed only for legacy
--    backfill rows (source_table='ticket_activities').

create or replace function public.assert_activities_entity_kind_matches_id()
returns trigger
language plpgsql
as $$
begin
  -- 'ticket' transitional value is permitted ONLY for legacy backfill
  -- rows whose source_table indicates the legacy bridge. New writers
  -- sending entity_kind='ticket' with no source_table get rejected.
  if new.entity_kind = 'ticket' then
    if new.source_table is null or new.source_table != 'ticket_activities' then
      raise exception 'activities: entity_kind=''ticket'' is only valid for legacy backfill rows from ticket_activities';
    end if;
    return new;
  end if;

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

  return new;
end;
$$;

comment on function public.assert_activities_entity_kind_matches_id() is
  'Step 1c (00236+00237): entity_kind/entity_id integrity. ''ticket'' kind only valid for legacy backfill rows; ''case''/''work_order'' must match an existing row in their respective tables.';

notify pgrst, 'reload schema';
