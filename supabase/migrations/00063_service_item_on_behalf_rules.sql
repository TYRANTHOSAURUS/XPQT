-- 00063_service_item_on_behalf_rules.sql
-- Actor/target split for on_behalf_policy='configured_list'.
-- Actor criteria: who may submit on behalf.
-- Target criteria: who they may submit for (the requested_for person).
-- See docs/service-catalog-redesign.md §3.7

create table public.service_item_on_behalf_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  role text not null check (role in ('actor','target')),
  criteria_set_id uuid not null references public.criteria_sets(id),
  created_at timestamptz not null default now(),
  unique (service_item_id, role, criteria_set_id)
);

alter table public.service_item_on_behalf_rules enable row level security;
create policy "tenant_isolation" on public.service_item_on_behalf_rules
  using (tenant_id = public.current_tenant_id());

create index idx_on_behalf_tenant on public.service_item_on_behalf_rules (tenant_id);
create index idx_on_behalf_item on public.service_item_on_behalf_rules (service_item_id);
