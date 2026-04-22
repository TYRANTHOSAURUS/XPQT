-- 00058_service_item_categories.sql
-- M2M between service_items and service_catalog_categories. Mirrors
-- request_type_categories (00010) so one service item can appear in multiple
-- portal categories (e.g., 'Facilities' + 'Most requested').
-- See docs/service-catalog-redesign.md §3.2

create table public.service_item_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  category_id uuid not null references public.service_catalog_categories(id) on delete cascade,
  display_order int not null default 0,
  unique (service_item_id, category_id)
);

alter table public.service_item_categories enable row level security;
create policy "tenant_isolation" on public.service_item_categories
  using (tenant_id = public.current_tenant_id());

create index idx_sic_tenant on public.service_item_categories (tenant_id);
create index idx_sic_item on public.service_item_categories (service_item_id);
create index idx_sic_category on public.service_item_categories (category_id);
