-- 00075_create_org_nodes.sql
-- Org-node tree: tenant-scoped, self-referential, requester-side hierarchy.
-- See docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md §3.1

create table public.org_nodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  parent_id uuid references public.org_nodes(id) on delete restrict,
  name text not null,
  code text,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, parent_id, name)
);

create index idx_org_nodes_tenant on public.org_nodes (tenant_id);
create index idx_org_nodes_parent on public.org_nodes (parent_id);

alter table public.org_nodes enable row level security;
create policy "tenant_isolation" on public.org_nodes
  using (tenant_id = public.current_tenant_id());

-- Tenant-match trigger: parent must be in the same tenant.
create or replace function public.enforce_org_node_tenant_match()
returns trigger language plpgsql as $$
declare v_parent_tenant uuid;
begin
  if new.parent_id is not null then
    select tenant_id into v_parent_tenant from public.org_nodes where id = new.parent_id;
    if v_parent_tenant is null then
      raise exception 'org_node parent_id % does not exist', new.parent_id;
    end if;
    if v_parent_tenant <> new.tenant_id then
      raise exception 'org_node tenant mismatch: parent.tenant=%, child.tenant=%',
        v_parent_tenant, new.tenant_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_org_nodes_tenant_match
  before insert or update on public.org_nodes
  for each row execute function public.enforce_org_node_tenant_match();

-- Cycle-prevention trigger: parent_id cannot be self or any descendant.
create or replace function public.enforce_org_node_no_cycle()
returns trigger language plpgsql as $$
declare v_cursor uuid; v_depth int := 0;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'org_node cannot be its own parent';
  end if;
  v_cursor := new.parent_id;
  while v_cursor is not null and v_depth < 50 loop
    if v_cursor = new.id then
      raise exception 'org_node cycle detected via parent chain';
    end if;
    select parent_id into v_cursor from public.org_nodes where id = v_cursor;
    v_depth := v_depth + 1;
  end loop;
  if v_depth >= 50 then
    raise exception 'org_node tree exceeds max depth of 50';
  end if;
  return new;
end;
$$;

create trigger trg_org_nodes_no_cycle
  before insert or update on public.org_nodes
  for each row execute function public.enforce_org_node_no_cycle();

-- updated_at maintenance
create or replace function public.touch_org_node_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_org_nodes_touch_updated_at
  before update on public.org_nodes
  for each row execute function public.touch_org_node_updated_at();
