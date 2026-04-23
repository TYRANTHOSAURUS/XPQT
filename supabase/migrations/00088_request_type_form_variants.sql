-- 00088_request_type_form_variants.sql
-- Phase A / service-catalog collapse (2026-04-23).
-- Request-type-native replacement for service_item_form_variants. At most one
-- default variant (criteria_set_id IS NULL) per request type. Match rule:
-- active + within starts_at/ends_at; order priority desc, created_at asc;
-- first variant whose criteria matches wins; default variant is the fallback.
-- See docs/service-catalog-live.md §5.3.

create table public.request_type_form_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  criteria_set_id uuid references public.criteria_sets(id),  -- NULL = default variant
  form_schema_id uuid not null references public.config_entities(id),
  priority int not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

alter table public.request_type_form_variants enable row level security;
create policy "tenant_isolation" on public.request_type_form_variants
  using (tenant_id = public.current_tenant_id());

create index idx_rt_variants_tenant_rt_active_priority
  on public.request_type_form_variants (tenant_id, request_type_id, active, priority desc);

-- At most one default variant per request type (partial unique index).
create unique index uniq_request_type_default_variant
  on public.request_type_form_variants (request_type_id)
  where criteria_set_id is null;

-- Backfill from service_item_form_variants via the bridge.
-- The partial unique index is safe because we preflight-verified no service_item
-- had more than one default variant before running Phase A.
insert into public.request_type_form_variants (
  tenant_id, request_type_id, criteria_set_id, form_schema_id,
  priority, starts_at, ends_at, active, created_at
)
select v.tenant_id, b.request_type_id, v.criteria_set_id, v.form_schema_id,
       v.priority, v.starts_at, v.ends_at, v.active, v.created_at
from public.service_item_form_variants v
join public.request_type_service_item_bridge b on b.service_item_id = v.service_item_id;

notify pgrst, 'reload schema';
