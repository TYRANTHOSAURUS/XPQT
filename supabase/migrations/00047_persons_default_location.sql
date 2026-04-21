-- 00047_persons_default_location.sql
-- Portal scope slice (Contract 0): persons carry a default work location.
-- See docs/portal-scope-slice.md §3.1

alter table public.persons
  add column default_location_id uuid references public.spaces(id);

create index idx_persons_default_location on public.persons (default_location_id);

create or replace function public.enforce_person_default_location_type()
returns trigger language plpgsql as $$
declare v_type text; v_tenant uuid;
begin
  if new.default_location_id is null then return new; end if;
  select type, tenant_id into v_type, v_tenant
  from public.spaces where id = new.default_location_id;

  if v_type is null then
    raise exception 'persons.default_location_id % does not exist', new.default_location_id;
  end if;
  if v_type not in ('site','building') then
    raise exception 'persons.default_location_id must be site or building (got %)', v_type;
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: persons.tenant=%, space.tenant=%', new.tenant_id, v_tenant;
  end if;
  return new;
end;
$$;

create trigger trg_persons_default_location_type
  before insert or update of default_location_id on public.persons
  for each row execute function public.enforce_person_default_location_type();
