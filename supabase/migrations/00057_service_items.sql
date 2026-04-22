-- 00057_service_items.sql
-- Service Catalog Redesign phase 1: portal-facing service items.
-- Separates the portal card (name/description/icon/on_behalf_policy/category)
-- from the internal fulfillment behavior that lives on request_types.
-- See docs/service-catalog-redesign.md §3.1

create table public.service_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  key text not null,
  name text not null,
  description text,
  icon text,
  search_terms text[] not null default '{}',
  kb_link text,
  disruption_banner text,
  on_behalf_policy text not null default 'self_only'
    check (on_behalf_policy in ('self_only','any_person','direct_reports','configured_list')),
  fulfillment_type_id uuid not null,  -- FK enforced at service layer (v3 design §3.7); hard FK in phase 5
  display_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

alter table public.service_items enable row level security;
create policy "tenant_isolation" on public.service_items
  using (tenant_id = public.current_tenant_id());

create index idx_service_items_tenant on public.service_items (tenant_id);
create index idx_service_items_fulfillment on public.service_items (fulfillment_type_id);
create index idx_service_items_active on public.service_items (tenant_id, active) where active = true;

create trigger set_service_items_updated_at before update on public.service_items
  for each row execute function public.set_updated_at();
