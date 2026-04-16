-- Service catalog categories and request types

create table public.service_catalog_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  icon text,
  display_order integer not null default 0,
  parent_category_id uuid references public.service_catalog_categories(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.service_catalog_categories enable row level security;
create policy "tenant_isolation" on public.service_catalog_categories
  using (tenant_id = public.current_tenant_id());

create index idx_scc_tenant on public.service_catalog_categories (tenant_id);

create trigger set_scc_updated_at before update on public.service_catalog_categories
  for each row execute function public.set_updated_at();

-- Request types / ticket types
create table public.request_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  config_entity_id uuid references public.config_entities(id),
  name text not null,
  domain text, -- 'fm', 'it', 'visitor', 'catering', 'workplace', 'security', etc.
  form_schema_id uuid, -- references a config_entity of type form_schema
  workflow_definition_id uuid references public.workflow_definitions(id),
  default_assignment_policy_id uuid, -- references a config_entity of type routing_rule
  sla_policy_id uuid references public.sla_policies(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.request_types enable row level security;
create policy "tenant_isolation" on public.request_types
  using (tenant_id = public.current_tenant_id());

create index idx_rt_tenant on public.request_types (tenant_id);
create index idx_rt_tenant_domain on public.request_types (tenant_id, domain);

create trigger set_rt_updated_at before update on public.request_types
  for each row execute function public.set_updated_at();

-- Junction: request type ↔ service catalog category (many-to-many)
create table public.request_type_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  category_id uuid not null references public.service_catalog_categories(id) on delete cascade,
  unique (request_type_id, category_id)
);

alter table public.request_type_categories enable row level security;
create policy "tenant_isolation" on public.request_type_categories
  using (tenant_id = public.current_tenant_id());
