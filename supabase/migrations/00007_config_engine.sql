-- Configuration engine: unified draft/publish/version lifecycle for all config types

create table public.config_entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  config_type text not null check (config_type in (
    'request_type', 'form_schema', 'workflow', 'sla_policy',
    'routing_rule', 'notification_template', 'branding', 'terminology',
    'booking_rule', 'approval_rule', 'assignment_policy'
  )),
  slug text not null,
  display_name text not null,
  current_published_version_id uuid, -- FK added after config_versions exists
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, config_type, slug)
);

alter table public.config_entities enable row level security;
create policy "tenant_isolation" on public.config_entities
  using (tenant_id = public.current_tenant_id());

create index idx_ce_tenant_type on public.config_entities (tenant_id, config_type);

create trigger set_ce_updated_at before update on public.config_entities
  for each row execute function public.set_updated_at();

create table public.config_versions (
  id uuid primary key default gen_random_uuid(),
  config_entity_id uuid not null references public.config_entities(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  version_number integer not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  definition jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id),
  published_by uuid references public.users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (config_entity_id, version_number)
);

alter table public.config_versions enable row level security;
create policy "tenant_isolation" on public.config_versions
  using (tenant_id = public.current_tenant_id());

create index idx_cv_entity on public.config_versions (config_entity_id);
create index idx_cv_tenant on public.config_versions (tenant_id);

-- Add FK from config_entities to config_versions
alter table public.config_entities
  add constraint fk_ce_published_version
  foreign key (current_published_version_id)
  references public.config_versions(id);
