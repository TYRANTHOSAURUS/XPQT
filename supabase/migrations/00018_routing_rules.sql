-- Routing rules: condition-based ticket assignment

create table public.routing_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  config_entity_id uuid references public.config_entities(id),
  name text not null,
  priority integer not null default 0, -- higher = evaluated first
  conditions jsonb not null default '[]'::jsonb, -- [{field, operator, value}]
  action_assign_team_id uuid references public.teams(id),
  action_assign_user_id uuid references public.users(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.routing_rules enable row level security;
create policy "tenant_isolation" on public.routing_rules
  using (tenant_id = public.current_tenant_id());

create index idx_rr_tenant on public.routing_rules (tenant_id);
create index idx_rr_tenant_active on public.routing_rules (tenant_id, priority desc) where active = true;

create trigger set_rr_updated_at before update on public.routing_rules
  for each row execute function public.set_updated_at();
