-- 00090_request_type_scope_overrides.sql
-- Phase A / service-catalog collapse (2026-04-23).
-- Net new. Request-type-specific override layer on top of generic routing:
-- changes the effective handler / workflow / case SLA / child dispatch policy /
-- executor SLA at a tenant, space, or space_group scope. Exists because generic
-- routing tables are too broad when an exception applies to one request type
-- but not another in the same domain. See docs/service-catalog-live.md §5.5.

create table public.request_type_scope_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  scope_kind text not null check (scope_kind in ('tenant','space','space_group')),
  space_id uuid references public.spaces(id),
  space_group_id uuid references public.space_groups(id),
  inherit_to_descendants boolean not null default true,
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,

  -- Optional override fields (all nullable; null = inherit from request_types default).
  handler_kind text check (handler_kind in ('team','vendor','user','none')),
  handler_team_id uuid references public.teams(id),
  handler_vendor_id uuid references public.vendors(id),
  workflow_definition_id uuid references public.workflow_definitions(id),
  case_sla_policy_id uuid references public.sla_policies(id),
  case_owner_policy_entity_id uuid references public.config_entities(id),
  child_dispatch_policy_entity_id uuid references public.config_entities(id),
  executor_sla_policy_id uuid references public.sla_policies(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (
    (scope_kind = 'tenant'       and space_id is null and space_group_id is null) or
    (scope_kind = 'space'        and space_id is not null and space_group_id is null) or
    (scope_kind = 'space_group'  and space_id is null and space_group_id is not null)
  ),
  check (starts_at is null or ends_at is null or starts_at < ends_at),
  -- Exactly one handler target (when handler_kind is team/vendor/user)
  check (
    (handler_kind is null) or
    (handler_kind = 'none'   and handler_team_id is null and handler_vendor_id is null) or
    (handler_kind = 'team'   and handler_team_id is not null and handler_vendor_id is null) or
    (handler_kind = 'vendor' and handler_vendor_id is not null and handler_team_id is null) or
    (handler_kind = 'user'   and handler_team_id is null and handler_vendor_id is null)
  )
);

alter table public.request_type_scope_overrides enable row level security;
create policy "tenant_isolation" on public.request_type_scope_overrides
  using (tenant_id = public.current_tenant_id());

-- Indexing per docs/service-catalog-live.md §12.3
create index idx_rt_overrides_tenant_rt_active
  on public.request_type_scope_overrides (tenant_id, request_type_id, active, scope_kind);
create index idx_rt_overrides_space
  on public.request_type_scope_overrides (tenant_id, space_id)
  where space_id is not null;
create index idx_rt_overrides_group
  on public.request_type_scope_overrides (tenant_id, space_group_id)
  where space_group_id is not null;

create trigger set_rt_scope_overrides_updated_at
  before update on public.request_type_scope_overrides
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
