-- Assets: fixed, personal, and pooled/loanable

create table public.asset_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  default_role text not null default 'fixed' check (default_role in ('fixed', 'personal', 'pooled')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.asset_types enable row level security;
create policy "tenant_isolation" on public.asset_types
  using (tenant_id = public.current_tenant_id());

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  asset_type_id uuid not null references public.asset_types(id),
  asset_role text not null check (asset_role in ('fixed', 'personal', 'pooled')),
  name text not null,
  tag text,
  serial_number text,
  status text not null default 'active' check (status in ('available', 'assigned', 'in_maintenance', 'retired', 'disposed')),
  assigned_person_id uuid references public.persons(id),
  assigned_space_id uuid references public.spaces(id),
  assignment_type text check (assignment_type in ('permanent', 'temporary')),
  assignment_start_at timestamptz,
  assignment_end_at timestamptz,
  linked_order_line_item_id uuid, -- FK added after orders table is created
  purchase_date date,
  lifecycle_state text not null default 'active' check (lifecycle_state in ('procured', 'active', 'maintenance', 'retired', 'disposed')),
  external_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.assets enable row level security;
create policy "tenant_isolation" on public.assets
  using (tenant_id = public.current_tenant_id());

create index idx_assets_tenant on public.assets (tenant_id);
create index idx_assets_tenant_type on public.assets (tenant_id, asset_type_id);
create index idx_assets_tenant_role on public.assets (tenant_id, asset_role);
create index idx_assets_assigned_person on public.assets (assigned_person_id);
create index idx_assets_assigned_space on public.assets (assigned_space_id);
create index idx_assets_pooled_available on public.assets (tenant_id, asset_type_id, status)
  where asset_role = 'pooled' and status = 'available';

create trigger set_assets_updated_at before update on public.assets
  for each row execute function public.set_updated_at();

-- Asset assignment history
create table public.asset_assignment_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  action text not null check (action in ('assigned', 'returned', 'transferred', 'retired')),
  from_person_id uuid references public.persons(id),
  to_person_id uuid references public.persons(id),
  from_space_id uuid references public.spaces(id),
  to_space_id uuid references public.spaces(id),
  reason text,
  performed_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);

alter table public.asset_assignment_history enable row level security;
create policy "tenant_isolation" on public.asset_assignment_history
  using (tenant_id = public.current_tenant_id());

create index idx_aah_asset on public.asset_assignment_history (asset_id);
create index idx_aah_tenant on public.asset_assignment_history (tenant_id);
