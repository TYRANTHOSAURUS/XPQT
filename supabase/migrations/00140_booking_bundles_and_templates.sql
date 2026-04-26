-- 00140_booking_bundles_and_templates.sql
-- Sub-project 2: orchestration parent + bundle templates + cost centers.
-- booking_bundles is created lazily on first-service-attach to a reservation;
-- never created for room-only bookings. Visibility anchored on location_id.

create table public.booking_bundles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  bundle_type text not null
    check (bundle_type in ('meeting','event','desk_day','parking','hospitality','other')),
  requester_person_id uuid not null references public.persons(id),
  host_person_id uuid references public.persons(id),
  -- primary_reservation_id FK lands in 00147 (the cycle migration). The
  -- column is nullable + unconstrained here so booking_bundles can be created
  -- before reservations.booking_bundle_id has its FK.
  primary_reservation_id uuid,
  location_id uuid not null references public.spaces(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text,
  source text not null
    check (source in ('portal','desk','api','calendar_sync','reception')),
  cost_center_id uuid,
  template_id uuid,
  -- For services-only bundles (sub-project 3+); v2 uses null when reservation owns calendar
  calendar_event_id text,
  calendar_provider text check (calendar_provider in ('outlook') or calendar_provider is null),
  calendar_etag text,
  calendar_last_synced_at timestamptz,
  policy_snapshot jsonb not null default '{}'::jsonb,
  config_release_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

alter table public.booking_bundles enable row level security;
create policy "tenant_isolation" on public.booking_bundles
  using (tenant_id = public.current_tenant_id());

create index idx_bundles_tenant on public.booking_bundles (tenant_id);
create index idx_bundles_location on public.booking_bundles (location_id);
create index idx_bundles_requester on public.booking_bundles (requester_person_id);
create index idx_bundles_host on public.booking_bundles (host_person_id) where host_person_id is not null;
create index idx_bundles_primary_reservation on public.booking_bundles (primary_reservation_id) where primary_reservation_id is not null;
create index idx_bundles_window on public.booking_bundles (tenant_id, start_at) where start_at >= '2026-01-01';

create trigger set_bundles_updated_at before update on public.booking_bundles
  for each row execute function public.set_updated_at();

-- Bundle templates ----------------------------------------------------------
create table public.bundle_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  icon text,                 -- lucide icon name; UI hint only
  active boolean not null default true,
  payload jsonb not null,    -- room_criteria, default_duration_minutes, services[], default_cost_center_id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bundle_templates enable row level security;
create policy "tenant_isolation" on public.bundle_templates
  using (tenant_id = public.current_tenant_id());

create index idx_bundle_templates_tenant on public.bundle_templates (tenant_id, active) where active = true;

create trigger set_bundle_templates_updated_at before update on public.bundle_templates
  for each row execute function public.set_updated_at();

-- Cost centers --------------------------------------------------------------
create table public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  name text not null,
  description text,
  default_approver_person_id uuid references public.persons(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

alter table public.cost_centers enable row level security;
create policy "tenant_isolation" on public.cost_centers
  using (tenant_id = public.current_tenant_id());

create index idx_cost_centers_tenant on public.cost_centers (tenant_id, active) where active = true;
create index idx_cost_centers_approver on public.cost_centers (default_approver_person_id) where default_approver_person_id is not null;

create trigger set_cost_centers_updated_at before update on public.cost_centers
  for each row execute function public.set_updated_at();

-- bundle.cost_center_id + template_id FKs are added now (no cycle issue here).
alter table public.booking_bundles
  add constraint fk_bundles_cost_center
    foreign key (cost_center_id) references public.cost_centers(id) on delete set null,
  add constraint fk_bundles_template
    foreign key (template_id) references public.bundle_templates(id) on delete set null;

notify pgrst, 'reload schema';
