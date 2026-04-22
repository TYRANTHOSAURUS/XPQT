-- 00061_service_item_criteria.sql
-- Binds criteria sets to service items with mode:
--   visible_allow | visible_deny | request_allow | request_deny
-- Invariant: requestability ⊆ visibility (enforced in predicates).
-- Effective-dating at render time via active + starts_at/ends_at.
-- See docs/service-catalog-redesign.md §3.5

create table public.service_item_criteria (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  criteria_set_id uuid not null references public.criteria_sets(id),
  mode text not null check (mode in ('visible_allow','visible_deny','request_allow','request_deny')),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (service_item_id, criteria_set_id, mode),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);

alter table public.service_item_criteria enable row level security;
create policy "tenant_isolation" on public.service_item_criteria
  using (tenant_id = public.current_tenant_id());

create index idx_sic_bindings_tenant on public.service_item_criteria (tenant_id);
create index idx_sic_bindings_item on public.service_item_criteria (service_item_id);
create index idx_sic_bindings_mode on public.service_item_criteria (service_item_id, mode) where active = true;
