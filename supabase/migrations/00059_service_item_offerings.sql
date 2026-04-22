-- 00059_service_item_offerings.sql
-- Where each service item is actually offered. Phase-1 scopes:
-- tenant | space | space_group. Country/BU/legal_entity deferred per codex §11.
-- Effective dating via starts_at/ends_at enforced at render time (no cron).
-- See docs/service-catalog-redesign.md §3.3

create table public.service_item_offerings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
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

alter table public.service_item_offerings enable row level security;
create policy "tenant_isolation" on public.service_item_offerings
  using (tenant_id = public.current_tenant_id());

create index idx_offerings_tenant on public.service_item_offerings (tenant_id);
create index idx_offerings_item on public.service_item_offerings (service_item_id);
create index idx_offerings_space on public.service_item_offerings (space_id) where space_id is not null;
create index idx_offerings_group on public.service_item_offerings (space_group_id) where space_group_id is not null;
