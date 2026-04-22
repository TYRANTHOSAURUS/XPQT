-- 00077_create_org_node_location_grants.sql
-- Location grants attached to an org node. Cascades to all descendants
-- of the node when the portal resolver walks ancestors. See spec §3.3.

create table public.org_node_location_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  space_id uuid not null references public.spaces(id),
  granted_by_user_id uuid references public.users(id),
  granted_at timestamptz not null default now(),
  note text,
  unique (org_node_id, space_id)
);

create index idx_ongl_node   on public.org_node_location_grants (org_node_id);
create index idx_ongl_space  on public.org_node_location_grants (space_id);
create index idx_ongl_tenant on public.org_node_location_grants (tenant_id);

alter table public.org_node_location_grants enable row level security;
create policy "tenant_isolation" on public.org_node_location_grants
  using (tenant_id = public.current_tenant_id());

create or replace function public.enforce_org_node_location_grant_integrity()
returns trigger language plpgsql as $$
declare v_space_type text; v_space_tenant uuid; v_node_tenant uuid; v_granter_tenant uuid;
begin
  select type, tenant_id into v_space_type, v_space_tenant
  from public.spaces where id = new.space_id;
  if v_space_type is null then
    raise exception 'org-node grant space_id % does not exist', new.space_id;
  end if;
  if v_space_type not in ('site','building') then
    raise exception 'org-node grant target must be site or building (got %)', v_space_type;
  end if;
  if v_space_tenant <> new.tenant_id then
    raise exception 'org-node grant tenant mismatch: space.tenant=%, grant.tenant=%',
      v_space_tenant, new.tenant_id;
  end if;

  select tenant_id into v_node_tenant from public.org_nodes where id = new.org_node_id;
  if v_node_tenant is null then
    raise exception 'org-node grant org_node_id % does not exist', new.org_node_id;
  end if;
  if v_node_tenant <> new.tenant_id then
    raise exception 'org-node grant tenant mismatch: node.tenant=%, grant.tenant=%',
      v_node_tenant, new.tenant_id;
  end if;

  if new.granted_by_user_id is not null then
    select tenant_id into v_granter_tenant from public.users where id = new.granted_by_user_id;
    if v_granter_tenant is null then
      raise exception 'org-node grant granted_by_user_id % does not exist', new.granted_by_user_id;
    end if;
    if v_granter_tenant <> new.tenant_id then
      raise exception 'org-node grant tenant mismatch: granter.tenant=%, grant.tenant=%',
        v_granter_tenant, new.tenant_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_ongl_integrity
  before insert or update on public.org_node_location_grants
  for each row execute function public.enforce_org_node_location_grant_integrity();
