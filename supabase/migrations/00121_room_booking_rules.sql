-- 00121_room_booking_rules.sql
-- The D model: predicate-driven booking rules with template-first authoring.
-- Plugs into the existing predicate engine (criteria_sets / request_type_predicates).

create table if not exists public.room_booking_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  target_scope text not null check (target_scope in ('room','room_type','space_subtree','tenant')),
  target_id uuid,                                    -- null when target_scope='tenant'
  applies_when jsonb not null,                       -- predicate
  effect text not null check (effect in ('deny','require_approval','allow_override','warn')),
  approval_config jsonb,                             -- {required_approvers, threshold} when effect='require_approval'
  denial_message text,                               -- self-explaining text shown to users
  priority int not null default 100,
  template_id text,                                  -- which starter template (null if raw)
  template_params jsonb,                             -- params if compiled from template
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  updated_by uuid references public.users(id)
);

alter table public.room_booking_rules enable row level security;
drop policy if exists "tenant_isolation" on public.room_booking_rules;
create policy "tenant_isolation" on public.room_booking_rules
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_room_booking_rules_active_scope
  on public.room_booking_rules (tenant_id, active, target_scope, target_id, priority);

create trigger set_room_booking_rules_updated_at before update on public.room_booking_rules
  for each row execute function public.set_updated_at();

-- Rule version history (every save = one row)
create table if not exists public.room_booking_rule_versions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.room_booking_rules(id) on delete cascade,
  tenant_id uuid not null,
  version_number int not null,
  change_type text not null check (change_type in ('create','update','enable','disable','delete')),
  snapshot jsonb not null,                           -- full row at this version
  diff jsonb,                                        -- changes vs prior
  actor_user_id uuid references public.users(id),
  actor_at timestamptz not null default now(),
  unique (rule_id, version_number)
);

alter table public.room_booking_rule_versions enable row level security;
drop policy if exists "tenant_isolation" on public.room_booking_rule_versions;
create policy "tenant_isolation" on public.room_booking_rule_versions
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_room_booking_rule_versions_rule
  on public.room_booking_rule_versions (rule_id, version_number desc);

notify pgrst, 'reload schema';
