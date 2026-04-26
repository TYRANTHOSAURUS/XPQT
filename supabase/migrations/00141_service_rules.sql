-- 00141_service_rules.sql
-- Mirrors room_booking_rules row-for-row; uses the same predicate-engine
-- shape. target_kind extends to handle services.

create table public.service_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  target_kind text not null
    check (target_kind in ('catalog_item','menu','catalog_category','tenant')),
  target_id uuid,
  applies_when jsonb not null default '{}'::jsonb,
  effect text not null
    check (effect in ('deny','require_approval','allow_override','warn','allow')),
  approval_config jsonb,
  denial_message text,
  priority integer not null default 100,
  active boolean not null default true,
  template_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- target_id required for non-tenant scopes
  check (target_kind = 'tenant' or target_id is not null)
);

alter table public.service_rules enable row level security;
create policy "tenant_isolation" on public.service_rules
  using (tenant_id = public.current_tenant_id());

create index idx_service_rules_tenant_active on public.service_rules (tenant_id, active) where active = true;
create index idx_service_rules_target on public.service_rules (target_kind, target_id) where active = true;
create index idx_service_rules_priority on public.service_rules (priority desc, created_at) where active = true;

create trigger set_service_rules_updated_at before update on public.service_rules
  for each row execute function public.set_updated_at();

-- Versions: a snapshot row per save; mirrors room_booking_rule_versions
create table public.service_rule_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  rule_id uuid not null references public.service_rules(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid references public.users(id),
  unique (rule_id, version)
);

alter table public.service_rule_versions enable row level security;
create policy "tenant_isolation" on public.service_rule_versions
  using (tenant_id = public.current_tenant_id());

create index idx_service_rule_versions_rule on public.service_rule_versions (rule_id, version desc);

-- Simulation scenarios for the admin UI
create table public.service_rule_simulation_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  context jsonb not null,    -- ServiceEvaluationContext shape
  expected_outcome jsonb,    -- optional assertion ({effect, message?})
  created_at timestamptz not null default now()
);

alter table public.service_rule_simulation_scenarios enable row level security;
create policy "tenant_isolation" on public.service_rule_simulation_scenarios
  using (tenant_id = public.current_tenant_id());

-- Templates table (mirror of room_booking_rule_templates structure).
-- Read-only, tenant-agnostic — no RLS, no tenant_id.
create table public.service_rule_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  name text not null,
  description text not null,
  category text not null,                    -- 'approval' | 'availability' | 'capacity'
  effect_default text not null,
  applies_when_template jsonb not null,      -- predicate with {{params}}
  param_specs jsonb not null default '[]'::jsonb,
  approval_config_template jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Templates seed lands in 00149.

notify pgrst, 'reload schema';
