-- People, Users, Roles, Teams — the identity layer

-- Persons: operational representation of any human actor
create table public.persons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  type text not null check (type in ('employee', 'visitor', 'contractor', 'vendor_contact', 'temporary_worker')),
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  division text,
  department text,
  cost_center text,
  manager_person_id uuid references public.persons(id),
  external_source text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.persons enable row level security;
create policy "tenant_isolation" on public.persons
  using (tenant_id = public.current_tenant_id());

create index idx_persons_tenant on public.persons (tenant_id);
create index idx_persons_tenant_email on public.persons (tenant_id, email);
create index idx_persons_tenant_department on public.persons (tenant_id, department);
create index idx_persons_manager on public.persons (manager_person_id);

create trigger set_persons_updated_at before update on public.persons
  for each row execute function public.set_updated_at();

-- Users: authenticated platform accounts (linked to Supabase Auth)
create table public.users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid references public.persons(id),
  auth_uid uuid unique, -- Supabase Auth user ID
  email text not null,
  username text,
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;
create policy "tenant_isolation" on public.users
  using (tenant_id = public.current_tenant_id());

create index idx_users_tenant on public.users (tenant_id);
create index idx_users_auth_uid on public.users (auth_uid);
create index idx_users_tenant_email on public.users (tenant_id, email);

create trigger set_users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- Roles: authorization profiles
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  permissions jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.roles enable row level security;
create policy "tenant_isolation" on public.roles
  using (tenant_id = public.current_tenant_id());

create index idx_roles_tenant on public.roles (tenant_id);

-- User role assignments: role + domain scope + location scope
create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  domain_scope text[], -- null/empty = all domains
  location_scope uuid[], -- null/empty = all locations (references spaces)
  read_only_cross_domain boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.user_role_assignments enable row level security;
create policy "tenant_isolation" on public.user_role_assignments
  using (tenant_id = public.current_tenant_id());

create index idx_ura_user on public.user_role_assignments (user_id);
create index idx_ura_tenant on public.user_role_assignments (tenant_id);

-- Teams / Assignment Groups
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  domain_scope text,
  location_scope uuid, -- references a space (site/building)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.teams enable row level security;
create policy "tenant_isolation" on public.teams
  using (tenant_id = public.current_tenant_id());

create index idx_teams_tenant on public.teams (tenant_id);

create trigger set_teams_updated_at before update on public.teams
  for each row execute function public.set_updated_at();

-- Team membership
create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);

alter table public.team_members enable row level security;
create policy "tenant_isolation" on public.team_members
  using (tenant_id = public.current_tenant_id());

create index idx_team_members_team on public.team_members (team_id);
create index idx_team_members_user on public.team_members (user_id);

-- Delegations: approval delegation when someone is out of office
create table public.delegations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  delegator_user_id uuid not null references public.users(id),
  delegate_user_id uuid not null references public.users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.delegations enable row level security;
create policy "tenant_isolation" on public.delegations
  using (tenant_id = public.current_tenant_id());

create index idx_delegations_delegator on public.delegations (delegator_user_id);
create index idx_delegations_tenant on public.delegations (tenant_id);
