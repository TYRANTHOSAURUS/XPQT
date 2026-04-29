-- 00194_location_service_routing.sql
-- The matrix that answers "which internal team handles setup work at this
-- location for this service category, and what's the lead time + SLA?"
--
-- Used by the auto-creation flow in Slice 2 (Wave 2): when a service rule
-- says requires_internal_setup=true, we look up this matrix to find the
-- assignee, due date, and SLA for the auto-created internal work order.
--
-- Hierarchical fallback (most-specific wins):
--   1. (tenant_id, exact location_id, category) — building override
--   2. (tenant_id, parent location_id, category) — site / region inheritance
--      via spaces.parent_id walk
--   3. (tenant_id, NULL location_id, category)   — tenant-wide default
--
-- The walk is implemented in resolve_setup_routing() below; callers don't
-- need to compose the fallback themselves.

create table public.location_service_routing (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  -- NULL = tenant default (applies to any location not otherwise matched)
  location_id uuid references public.spaces(id) on delete cascade,
  service_category text not null check (service_category in (
    'catering', 'av_equipment', 'supplies', 'facilities_services',
    'cleaning', 'maintenance', 'transport', 'other'
  )),
  -- Who handles the internal setup work. NULL = no setup auto-created
  -- even when a rule says requires_internal_setup. Lets tenants disable
  -- per location/category without deleting the rule.
  internal_team_id uuid references public.teams(id) on delete set null,
  default_lead_time_minutes int not null default 30,
  sla_policy_id uuid references public.sla_policies(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.location_service_routing enable row level security;
create policy "tenant_isolation" on public.location_service_routing
  using (tenant_id = public.current_tenant_id());

-- Two partial unique indexes because Postgres treats NULL as not-equal-to-NULL
-- in standard unique constraints. We want:
--   * one row per (tenant, location, category) — the per-location override
--   * one row per (tenant, category)            — the tenant default
create unique index ux_lsr_per_location
  on public.location_service_routing (tenant_id, location_id, service_category)
  where location_id is not null;

create unique index ux_lsr_tenant_default
  on public.location_service_routing (tenant_id, service_category)
  where location_id is null;

-- Hot-path index for the resolver below.
create index idx_lsr_lookup
  on public.location_service_routing (tenant_id, service_category, location_id)
  where active = true;

create trigger set_lsr_updated_at before update on public.location_service_routing
  for each row execute function public.set_updated_at();

-- Hierarchical resolver. Walks the spaces tree from the input location up
-- to root, picking the most-specific routing row that matches. Falls back
-- to the tenant default (location_id IS NULL) if no override is found.
--
-- Returns 0 or 1 row. NULL location_id input means "no specific location"
-- — the function returns the tenant default (or nothing).
--
-- Why a SECURITY DEFINER function: callers from the API hot path don't
-- want to compose the hierarchical query themselves. The function
-- enforces (tenant_id = p_tenant_id) so it's safe.
create or replace function public.resolve_setup_routing(
  p_tenant_id uuid,
  p_location_id uuid,
  p_service_category text
) returns table (
  internal_team_id uuid,
  default_lead_time_minutes int,
  sla_policy_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive location_chain as (
    -- Start from the input location, walk up to root via spaces.parent_id.
    -- depth=0 = exact match, higher = ancestor.
    select s.id, s.parent_id, 0 as depth
    from public.spaces s
    where s.id = p_location_id
      and s.tenant_id = p_tenant_id
    union all
    select s.id, s.parent_id, lc.depth + 1
    from public.spaces s
    join location_chain lc on lc.parent_id = s.id
    where s.tenant_id = p_tenant_id
  ),
  matched as (
    -- Per-location overrides, ordered by specificity (depth 0 = most specific)
    select
      lsr.internal_team_id,
      lsr.default_lead_time_minutes,
      lsr.sla_policy_id,
      lc.depth as match_rank
    from public.location_service_routing lsr
    join location_chain lc on lc.id = lsr.location_id
    where lsr.tenant_id = p_tenant_id
      and lsr.service_category = p_service_category
      and lsr.active = true
    union all
    -- Tenant default (lowest priority — only fires if no per-location
    -- override matched). Rank far-large so it always loses to specific rows.
    select
      lsr.internal_team_id,
      lsr.default_lead_time_minutes,
      lsr.sla_policy_id,
      1000000 as match_rank
    from public.location_service_routing lsr
    where lsr.tenant_id = p_tenant_id
      and lsr.location_id is null
      and lsr.service_category = p_service_category
      and lsr.active = true
  )
  select internal_team_id, default_lead_time_minutes, sla_policy_id
  from matched
  order by match_rank asc
  limit 1;
$$;

grant execute on function public.resolve_setup_routing(uuid, uuid, text)
  to authenticated, service_role;

comment on function public.resolve_setup_routing(uuid, uuid, text) is
  'Hierarchical lookup for internal setup routing: per-location override → ancestor location → tenant default. Returns 0 or 1 row. Used by the auto-creation flow when a service rule emits requires_internal_setup.';

notify pgrst, 'reload schema';
