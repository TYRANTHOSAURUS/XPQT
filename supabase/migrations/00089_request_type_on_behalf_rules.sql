-- 00089_request_type_on_behalf_rules.sql
-- Phase A / service-catalog collapse (2026-04-23).
-- Request-type-native replacement for service_item_on_behalf_rules. Applies
-- when request_types.on_behalf_policy = 'configured_list'. Actor criteria say
-- who may submit on behalf; target criteria say who they may submit for.
-- See docs/service-catalog-live.md §5.4.

create table public.request_type_on_behalf_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  role text not null check (role in ('actor','target')),
  criteria_set_id uuid not null references public.criteria_sets(id),
  created_at timestamptz not null default now(),
  unique (request_type_id, role, criteria_set_id)
);

alter table public.request_type_on_behalf_rules enable row level security;
create policy "tenant_isolation" on public.request_type_on_behalf_rules
  using (tenant_id = public.current_tenant_id());

create index idx_rt_on_behalf_tenant_rt_role
  on public.request_type_on_behalf_rules (tenant_id, request_type_id, role);

-- Backfill from service_item_on_behalf_rules via the bridge.
insert into public.request_type_on_behalf_rules (
  tenant_id, request_type_id, role, criteria_set_id, created_at
)
select r.tenant_id, b.request_type_id, r.role, r.criteria_set_id, r.created_at
from public.service_item_on_behalf_rules r
join public.request_type_service_item_bridge b on b.service_item_id = r.service_item_id
on conflict (request_type_id, role, criteria_set_id) do nothing;

notify pgrst, 'reload schema';
