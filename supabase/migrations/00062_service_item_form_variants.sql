-- 00062_service_item_form_variants.sql
-- Per-audience form variants for a service item. At most one default (criteria_set_id IS NULL).
-- Match rule: active AND within starts_at/ends_at; priority desc, created_at asc; first match wins.
-- See docs/service-catalog-redesign.md §3.6

create table public.service_item_form_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  criteria_set_id uuid references public.criteria_sets(id),  -- NULL = default variant
  form_schema_id uuid not null references public.config_entities(id),
  priority int not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

alter table public.service_item_form_variants enable row level security;
create policy "tenant_isolation" on public.service_item_form_variants
  using (tenant_id = public.current_tenant_id());

create index idx_variants_tenant on public.service_item_form_variants (tenant_id);
create index idx_variants_item on public.service_item_form_variants (service_item_id) where active = true;

-- At most one default variant per service item
create unique index uniq_service_item_default_variant
  on public.service_item_form_variants (service_item_id)
  where criteria_set_id is null;
