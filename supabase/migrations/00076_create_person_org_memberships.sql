-- 00076_create_person_org_memberships.sql
-- Person ↔ org-node join table. UI v1 surfaces a single primary membership
-- per person; the schema is ready for multi-membership without migration.
-- See spec §3.2

create table public.person_org_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid not null references public.persons(id) on delete cascade,
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  unique (person_id, org_node_id)
);

create index idx_pom_person on public.person_org_memberships (person_id);
create index idx_pom_node   on public.person_org_memberships (org_node_id);
create index idx_pom_tenant on public.person_org_memberships (tenant_id);

create unique index idx_pom_one_primary_per_person
  on public.person_org_memberships (person_id)
  where is_primary;

alter table public.person_org_memberships enable row level security;
create policy "tenant_isolation" on public.person_org_memberships
  using (tenant_id = public.current_tenant_id());

create or replace function public.enforce_person_org_membership_tenant()
returns trigger language plpgsql as $$
declare v_person_tenant uuid; v_node_tenant uuid;
begin
  select tenant_id into v_person_tenant from public.persons where id = new.person_id;
  if v_person_tenant is null then
    raise exception 'membership person_id % does not exist', new.person_id;
  end if;
  if v_person_tenant <> new.tenant_id then
    raise exception 'membership tenant mismatch: person.tenant=%, membership.tenant=%',
      v_person_tenant, new.tenant_id;
  end if;

  select tenant_id into v_node_tenant from public.org_nodes where id = new.org_node_id;
  if v_node_tenant is null then
    raise exception 'membership org_node_id % does not exist', new.org_node_id;
  end if;
  if v_node_tenant <> new.tenant_id then
    raise exception 'membership tenant mismatch: node.tenant=%, membership.tenant=%',
      v_node_tenant, new.tenant_id;
  end if;
  return new;
end;
$$;

create trigger trg_pom_tenant_match
  before insert or update on public.person_org_memberships
  for each row execute function public.enforce_person_org_membership_tenant();
