-- 00113_space_wing_and_parent_rule.sql
-- Adds `wing` as a valid space type (between building and floor) and enforces
-- the parent→child taxonomy at the DB. Mirrors the client-side constraint in
-- packages/shared/src/space-types.ts. If you change one, change the other.

-- 1. Extend the type check constraint.
alter table public.spaces
  drop constraint spaces_type_check;

alter table public.spaces
  add constraint spaces_type_check check (type in (
    'site', 'building', 'wing', 'floor',
    'room', 'desk', 'meeting_room',
    'common_area', 'storage_room', 'technical_room', 'parking_space'
  ));

-- 2. Extend the location_granularity allowlist in request_types. This function
-- is defined in 00049_request_type_location_granularity.sql; its body
-- hardcodes the valid space types. We recreate it with `wing` added.
create or replace function public.enforce_request_type_granularity()
returns trigger
language plpgsql
as $$
declare
  valid_types text[] := array[
    'site', 'building', 'wing', 'floor',
    'room', 'desk', 'meeting_room',
    'common_area', 'storage_room', 'technical_room', 'parking_space'
  ];
begin
  if new.location_granularity is not null
     and not (new.location_granularity = any (valid_types)) then
    raise exception 'location_granularity % is not a valid spaces.type value (allowed: %)',
      new.location_granularity, valid_types;
  end if;
  return new;
end;
$$;

-- 3. Parent→child taxonomy. Returns true if `child_type` may be a child of
-- `parent_type` (or of null, meaning root).
create or replace function public.is_valid_space_parent(
  parent_type text,
  child_type text
) returns boolean
language sql
immutable
as $$
  select case
    when parent_type is null then child_type = 'site'
    when parent_type = 'site' then child_type in ('building', 'common_area', 'parking_space')
    when parent_type = 'building' then child_type in ('wing', 'floor', 'common_area')
    when parent_type = 'wing' then child_type in ('floor')
    when parent_type = 'floor' then child_type in (
      'room', 'meeting_room', 'common_area', 'storage_room', 'technical_room'
    )
    when parent_type = 'room' then child_type = 'desk'
    else false
  end;
$$;

-- 4. Trigger: enforce the rule on insert/update, and prevent cycles on update.
create or replace function public.enforce_space_parent_rule()
returns trigger
language plpgsql
as $$
declare
  parent_type text;
  cursor_id uuid;
begin
  if new.parent_id is null then
    parent_type := null;
  else
    select type into parent_type
    from public.spaces
    where id = new.parent_id and tenant_id = new.tenant_id;

    if parent_type is null then
      raise exception 'parent_id % not found in tenant', new.parent_id;
    end if;
  end if;

  if not public.is_valid_space_parent(parent_type, new.type) then
    raise exception 'space type % cannot be a child of %',
      new.type, coalesce(parent_type, '(root)');
  end if;

  -- Cycle check: walk up from new.parent_id; fail if we encounter new.id.
  if tg_op = 'UPDATE' and new.parent_id is not null then
    cursor_id := new.parent_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'moving space % under % would create a cycle', new.id, new.parent_id;
      end if;
      select parent_id into cursor_id from public.spaces where id = cursor_id;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_space_parent_rule on public.spaces;
create trigger enforce_space_parent_rule
  before insert or update of parent_id, type on public.spaces
  for each row execute function public.enforce_space_parent_rule();

-- 5. Notify PostgREST so schema cache reloads.
notify pgrst, 'reload schema';
