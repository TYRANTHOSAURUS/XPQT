-- 00049_request_type_location_granularity.sql
-- Portal scope slice: request types declare how deep the submitted location must be.
-- NOTE: requires_location + location_required already exist (00027). Not modified here.
-- See docs/portal-scope-slice.md §3.3

alter table public.request_types
  add column location_granularity text;

comment on column public.request_types.location_granularity is
  'When non-null, submitted location must have an ancestor (inclusive) with spaces.type = this value. Valid values mirror the spaces.type check constraint in 00004_spaces.sql.';

-- Hardcoded allowlist mirrored from 00004_spaces.sql. If a new space type is added,
-- update this list in the same migration that extends spaces.type. Reviewers catch
-- drift in PR via the explicit reference.
create or replace function public.enforce_request_type_granularity()
returns trigger language plpgsql as $$
declare
  v_allowed constant text[] := array[
    'site','building','floor','room','desk','meeting_room',
    'common_area','storage_room','technical_room','parking_space'
  ];  -- MUST match 00004_spaces.sql spaces.type check constraint.
begin
  if new.location_granularity is null then return new; end if;
  if not (new.location_granularity = any(v_allowed)) then
    raise exception 'location_granularity % is not a valid spaces.type value (allowed: %)',
      new.location_granularity, v_allowed;
  end if;
  return new;
end;
$$;

create trigger trg_request_type_granularity
  before insert or update of location_granularity on public.request_types
  for each row execute function public.enforce_request_type_granularity();
