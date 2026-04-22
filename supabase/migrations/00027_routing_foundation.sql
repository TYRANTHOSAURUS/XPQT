-- 00027_routing_foundation.sql
-- Routing foundation: fulfillment shape, asset/location team linkage, audit log

-- ── 1. Request type fulfillment shape ─────────────────────────
alter table public.request_types
  add column if not exists fulfillment_strategy text not null default 'fixed'
    check (fulfillment_strategy in ('asset', 'location', 'fixed', 'auto')),
  add column if not exists requires_asset boolean not null default false,
  add column if not exists asset_required boolean not null default false,
  add column if not exists asset_type_filter uuid[] not null default '{}',
  add column if not exists requires_location boolean not null default false,
  add column if not exists location_required boolean not null default false,
  add column if not exists default_team_id uuid references public.teams(id),
  add column if not exists default_vendor_id uuid references public.vendors(id);

-- ── 2. Asset-type class defaults ──────────────────────────────
alter table public.asset_types
  add column if not exists default_team_id uuid references public.teams(id),
  add column if not exists default_vendor_id uuid references public.vendors(id);

-- ── 3. Per-asset overrides (site-specific exceptions) ─────────
alter table public.assets
  add column if not exists override_team_id uuid references public.teams(id),
  add column if not exists override_vendor_id uuid references public.vendors(id);

-- ── 4. Location ↔ domain ↔ team mapping ───────────────────────
create table if not exists public.location_teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_id uuid not null references public.spaces(id) on delete cascade,
  domain text not null,
  team_id uuid references public.teams(id),
  vendor_id uuid references public.vendors(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id, domain),
  check (team_id is not null or vendor_id is not null)
);

alter table public.location_teams enable row level security;
create policy "tenant_isolation" on public.location_teams
  using (tenant_id = public.current_tenant_id());

create index idx_location_teams_tenant on public.location_teams (tenant_id);
create index idx_location_teams_space_domain on public.location_teams (space_id, domain);

create trigger set_location_teams_updated_at before update on public.location_teams
  for each row execute function public.set_updated_at();

-- ── 5. Tickets can be assigned to a vendor (not just team/user) ─
alter table public.tickets
  add column if not exists assigned_vendor_id uuid references public.vendors(id);

create index if not exists idx_tickets_assigned_vendor on public.tickets (assigned_vendor_id);

-- ── 6. Routing decision audit log ─────────────────────────────
create table if not exists public.routing_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  decided_at timestamptz not null default now(),
  strategy text not null,
  chosen_team_id uuid references public.teams(id),
  chosen_user_id uuid references public.users(id),
  chosen_vendor_id uuid references public.vendors(id),
  chosen_by text not null,
  rule_id uuid references public.routing_rules(id),
  trace jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.routing_decisions enable row level security;
create policy "tenant_isolation" on public.routing_decisions
  using (tenant_id = public.current_tenant_id());

create index idx_routing_decisions_tenant_ticket on public.routing_decisions (tenant_id, ticket_id);
create index idx_routing_decisions_chosen_by on public.routing_decisions (tenant_id, chosen_by);
