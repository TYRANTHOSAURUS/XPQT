-- 00087_request_type_audience_rules.sql
-- Phase A / service-catalog collapse (2026-04-23).
-- Request-type-native replacement for service_item_criteria. Answers only
-- "who can see / request this". Bindings to criteria_sets with four modes.
-- Effective-dating at render time via active + starts_at/ends_at.
-- Invariant: requestability ⊆ visibility — enforced in the predicate functions.
-- See docs/service-catalog-live.md §5.2.

create table public.request_type_audience_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  criteria_set_id uuid not null references public.criteria_sets(id),
  mode text not null check (mode in ('visible_allow','visible_deny','request_allow','request_deny')),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (request_type_id, criteria_set_id, mode),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

alter table public.request_type_audience_rules enable row level security;
create policy "tenant_isolation" on public.request_type_audience_rules
  using (tenant_id = public.current_tenant_id());

create index idx_rt_audience_tenant_rt_mode_active
  on public.request_type_audience_rules (tenant_id, request_type_id, mode, active);

-- Backfill from service_item_criteria via the bridge.
insert into public.request_type_audience_rules (
  tenant_id, request_type_id, criteria_set_id, mode,
  starts_at, ends_at, active, created_at
)
select c.tenant_id, b.request_type_id, c.criteria_set_id, c.mode,
       c.starts_at, c.ends_at, c.active, c.created_at
from public.service_item_criteria c
join public.request_type_service_item_bridge b on b.service_item_id = c.service_item_id
on conflict (request_type_id, criteria_set_id, mode) do nothing;

notify pgrst, 'reload schema';
