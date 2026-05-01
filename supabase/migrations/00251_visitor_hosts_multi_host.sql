-- 00251_visitor_hosts_multi_host.sql
-- Visitor Management v1 — multi-host junction table.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.3
--
-- The canonical primary host stays denormalised on visitors.primary_host_person_id.
-- This junction holds *all* hosts (primary included) for fan-out simplicity.
-- No is_primary flag — single source of truth on visitors row.
--
-- tenant_id is required defense-in-depth; a BEFORE INSERT/UPDATE trigger
-- raises if it does not match visitors.tenant_id, so a tenant-A actor
-- cannot link a tenant-A host onto a tenant-B visitor.

create table public.visitor_hosts (
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  person_id  uuid not null references public.persons(id),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  notified_at      timestamptz,
  acknowledged_at  timestamptz,
  primary key (visitor_id, person_id)
);

-- Defense-in-depth: tenant_id must match visitor's tenant.
create or replace function public.assert_visitor_host_tenant() returns trigger
  language plpgsql as $$
declare
  v_visitor_tenant uuid;
begin
  select tenant_id into v_visitor_tenant from public.visitors where id = new.visitor_id;
  if v_visitor_tenant is null then
    raise exception 'visitor_hosts.visitor_id % does not exist', new.visitor_id;
  end if;
  if new.tenant_id != v_visitor_tenant then
    raise exception 'visitor_hosts.tenant_id mismatch with visitors.tenant_id (host tenant=%, visitor tenant=%)',
      new.tenant_id, v_visitor_tenant;
  end if;
  return new;
end;
$$;

create trigger trg_visitor_hosts_tenant_check
  before insert or update on public.visitor_hosts
  for each row execute function public.assert_visitor_host_tenant();

alter table public.visitor_hosts enable row level security;

drop policy if exists tenant_isolation on public.visitor_hosts;
create policy "visitor_hosts_select" on public.visitor_hosts
  for select using (tenant_id = public.current_tenant_id());
create policy "visitor_hosts_insert" on public.visitor_hosts
  for insert with check (tenant_id = public.current_tenant_id());
create policy "visitor_hosts_update" on public.visitor_hosts
  for update
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "visitor_hosts_delete" on public.visitor_hosts
  for delete using (tenant_id = public.current_tenant_id());

revoke all on public.visitor_hosts from public, anon, authenticated;
grant select, insert, update, delete on public.visitor_hosts to service_role;

create index idx_vh_person on public.visitor_hosts (tenant_id, person_id, acknowledged_at);
create index idx_vh_visitor on public.visitor_hosts (visitor_id);

comment on table public.visitor_hosts is
  'Multi-host junction (primary host included for fan-out simplicity). Canonical primary lives on visitors.primary_host_person_id. See visitor-management-v1-design.md §4.3.';

notify pgrst, 'reload schema';
