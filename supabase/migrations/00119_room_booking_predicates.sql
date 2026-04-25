-- 00119_room_booking_predicates.sql
-- Predicate-engine helpers used by the room booking rules engine (D model).
-- Reuses public.business_hours_calendars (00006) for business-hours / holiday data.

create or replace function public.in_business_hours(
  at timestamptz,
  calendar_id uuid
) returns boolean
language plpgsql
stable
as $$
declare
  cal record;
  local_at timestamptz;
  dow text;
  hours jsonb;
  start_time time;
  end_time time;
  the_date date;
  holiday jsonb;
begin
  select * into cal from public.business_hours_calendars where id = calendar_id;
  if not found then return false; end if;

  local_at := at at time zone cal.time_zone;
  the_date := local_at::date;

  -- holiday check
  for holiday in select value from jsonb_array_elements(cal.holidays) loop
    if (holiday->>'date')::date = the_date then
      return false;
    end if;
  end loop;

  -- working_hours indexed by lowercase day-of-week english name
  dow := lower(trim(to_char(local_at, 'fmday')));
  hours := cal.working_hours -> dow;
  if hours is null or hours = 'null'::jsonb then return false; end if;

  start_time := (hours->>'start')::time;
  end_time   := (hours->>'end')::time;
  return local_at::time >= start_time and local_at::time < end_time;
end
$$;

-- Org-node subtree expansion (returns root + all descendants).
-- Used by D rules: `requester.org_node IN org_node_descendants(X)`.
create or replace function public.org_node_descendants(root_id uuid)
  returns setof uuid
  language sql
  stable
as $$
  with recursive tree as (
    select id from public.org_nodes where id = root_id
    union all
    select n.id from public.org_nodes n join tree t on n.parent_id = t.id
  )
  select id from tree;
$$;

-- Space subtree expansion (returns root + all descendants in spaces hierarchy).
-- Used to apply rules whose target_scope = 'space_subtree'.
create or replace function public.space_descendants(root_id uuid)
  returns setof uuid
  language sql
  stable
as $$
  with recursive tree as (
    select id from public.spaces where id = root_id
    union all
    select s.id from public.spaces s join tree t on s.parent_id = t.id
  )
  select id from tree;
$$;

notify pgrst, 'reload schema';
