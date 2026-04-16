-- Business hours calendars for SLA calculations and workflow timers

create table public.business_hours_calendars (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  time_zone text not null default 'UTC',
  working_hours jsonb not null default '{
    "monday": {"start": "08:00", "end": "17:00"},
    "tuesday": {"start": "08:00", "end": "17:00"},
    "wednesday": {"start": "08:00", "end": "17:00"},
    "thursday": {"start": "08:00", "end": "17:00"},
    "friday": {"start": "08:00", "end": "17:00"},
    "saturday": null,
    "sunday": null
  }'::jsonb,
  holidays jsonb not null default '[]'::jsonb, -- [{date, name, recurring}]
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.business_hours_calendars enable row level security;
create policy "tenant_isolation" on public.business_hours_calendars
  using (tenant_id = public.current_tenant_id());

create index idx_bhc_tenant on public.business_hours_calendars (tenant_id);

create trigger set_bhc_updated_at before update on public.business_hours_calendars
  for each row execute function public.set_updated_at();
