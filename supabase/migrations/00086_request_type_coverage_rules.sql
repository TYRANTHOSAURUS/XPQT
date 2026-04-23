-- 00086_request_type_coverage_rules.sql
-- Phase A / service-catalog collapse (2026-04-23).
-- Request-type-native replacement for service_item_offerings. Answers only
-- "where is this request type offered". Does not assign handlers.
-- See docs/service-catalog-live.md §5.1.

create table public.request_type_coverage_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  scope_kind text not null check (scope_kind in ('tenant','space','space_group')),
  space_id uuid references public.spaces(id),
  space_group_id uuid references public.space_groups(id),
  inherit_to_descendants boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (
    (scope_kind = 'tenant'       and space_id is null and space_group_id is null) or
    (scope_kind = 'space'        and space_id is not null and space_group_id is null) or
    (scope_kind = 'space_group'  and space_id is null and space_group_id is not null)
  ),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

alter table public.request_type_coverage_rules enable row level security;
create policy "tenant_isolation" on public.request_type_coverage_rules
  using (tenant_id = public.current_tenant_id());

-- Indexing per docs/service-catalog-live.md §12.3
create index idx_rt_coverage_tenant_rt_active
  on public.request_type_coverage_rules (tenant_id, request_type_id, active);
create index idx_rt_coverage_space
  on public.request_type_coverage_rules (tenant_id, scope_kind, space_id)
  where space_id is not null;
create index idx_rt_coverage_group
  on public.request_type_coverage_rules (tenant_id, scope_kind, space_group_id)
  where space_group_id is not null;

-- Backfill from service_item_offerings via the bridge. Every offering maps 1:1
-- because backfill (00068) + auto-pair trigger (00070) already ensure every
-- service_item has exactly one canonical request_type.
insert into public.request_type_coverage_rules (
  tenant_id, request_type_id, scope_kind, space_id, space_group_id,
  inherit_to_descendants, starts_at, ends_at, active, created_at
)
select o.tenant_id, b.request_type_id, o.scope_kind, o.space_id, o.space_group_id,
       o.inherit_to_descendants, o.starts_at, o.ends_at, o.active, o.created_at
from public.service_item_offerings o
join public.request_type_service_item_bridge b on b.service_item_id = o.service_item_id;

notify pgrst, 'reload schema';
