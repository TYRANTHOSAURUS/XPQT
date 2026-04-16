-- SLA policies (referenced by request types, linked to tickets)

create table public.sla_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  config_entity_id uuid references public.config_entities(id),
  name text not null,
  response_time_minutes integer, -- target response time in minutes
  resolution_time_minutes integer, -- target resolution time in minutes
  business_hours_calendar_id uuid references public.business_hours_calendars(id),
  pause_on_waiting_reasons text[] default '{"requester", "vendor", "scheduled_work"}',
  escalation_thresholds jsonb default '[]'::jsonb, -- [{at_percent, action, notify}]
  notification_rules jsonb default '[]'::jsonb, -- [{event, template_id, recipients}]
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sla_policies enable row level security;
create policy "tenant_isolation" on public.sla_policies
  using (tenant_id = public.current_tenant_id());

create index idx_sla_tenant on public.sla_policies (tenant_id);

create trigger set_sla_updated_at before update on public.sla_policies
  for each row execute function public.set_updated_at();
