-- 00048_person_location_grants.sql
-- Portal scope slice: explicit scope-root grants beyond default location.
-- Grants are site/building level; descendants follow via expand_space_closure.
-- See docs/portal-scope-slice.md §3.2

create table public.person_location_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid not null references public.persons(id) on delete cascade,
  space_id uuid not null references public.spaces(id),
  granted_by_user_id uuid references public.users(id),
  granted_at timestamptz not null default now(),
  note text,
  unique (person_id, space_id)
);

alter table public.person_location_grants enable row level security;
create policy "tenant_isolation" on public.person_location_grants
  using (tenant_id = public.current_tenant_id());

create index idx_plg_person on public.person_location_grants (person_id);
create index idx_plg_space  on public.person_location_grants (space_id);
create index idx_plg_tenant on public.person_location_grants (tenant_id);

create or replace function public.enforce_person_location_grant_integrity()
returns trigger language plpgsql as $$
declare v_space_type text; v_space_tenant uuid; v_person_tenant uuid; v_granter_tenant uuid;
begin
  select type, tenant_id into v_space_type, v_space_tenant
  from public.spaces where id = new.space_id;
  if v_space_type is null then
    raise exception 'grant space_id % does not exist', new.space_id;
  end if;
  if v_space_type not in ('site','building') then
    raise exception 'grant target must be site or building (got %)', v_space_type;
  end if;
  if v_space_tenant <> new.tenant_id then
    raise exception 'grant tenant mismatch: space.tenant=%, grant.tenant=%', v_space_tenant, new.tenant_id;
  end if;

  select tenant_id into v_person_tenant from public.persons where id = new.person_id;
  if v_person_tenant is null then
    raise exception 'grant person_id % does not exist', new.person_id;
  end if;
  if v_person_tenant <> new.tenant_id then
    raise exception 'grant tenant mismatch: person.tenant=%, grant.tenant=%', v_person_tenant, new.tenant_id;
  end if;

  if new.granted_by_user_id is not null then
    select tenant_id into v_granter_tenant from public.users where id = new.granted_by_user_id;
    if v_granter_tenant is null then
      raise exception 'grant granted_by_user_id % does not exist', new.granted_by_user_id;
    end if;
    if v_granter_tenant <> new.tenant_id then
      raise exception 'grant tenant mismatch: granter.tenant=%, grant.tenant=%', v_granter_tenant, new.tenant_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_plg_integrity
  before insert or update on public.person_location_grants
  for each row execute function public.enforce_person_location_grant_integrity();
