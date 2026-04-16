-- Preventive maintenance schedules

create table public.maintenance_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  recurrence_rule jsonb not null, -- {frequency, interval, day_of_week, day_of_month, etc.}
  next_occurrence_at timestamptz not null,
  -- Ticket template fields
  ticket_request_type_id uuid references public.request_types(id),
  ticket_title text not null,
  ticket_description text,
  ticket_priority text not null default 'medium',
  ticket_assigned_team_id uuid references public.teams(id),
  ticket_location_id uuid references public.spaces(id),
  ticket_asset_id uuid references public.assets(id),
  ticket_interaction_mode text not null default 'internal' check (ticket_interaction_mode in ('internal', 'external')),
  active boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.maintenance_schedules enable row level security;
create policy "tenant_isolation" on public.maintenance_schedules
  using (tenant_id = public.current_tenant_id());

create index idx_ms_tenant on public.maintenance_schedules (tenant_id);
create index idx_ms_next on public.maintenance_schedules (next_occurrence_at) where active = true;

create trigger set_ms_updated_at before update on public.maintenance_schedules
  for each row execute function public.set_updated_at();
