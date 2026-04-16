-- Tickets: the central operational engine

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ticket_type_id uuid references public.request_types(id),
  parent_ticket_id uuid references public.tickets(id),
  title text not null,
  description text,
  status text not null default 'new',
  status_category text not null default 'new' check (status_category in ('new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed')),
  waiting_reason text check (waiting_reason in ('requester', 'vendor', 'approval', 'scheduled_work', 'other')),
  interaction_mode text not null default 'internal' check (interaction_mode in ('internal', 'external')),
  priority text not null default 'medium',
  impact text,
  urgency text,
  requester_person_id uuid references public.persons(id),
  location_id uuid references public.spaces(id),
  asset_id uuid references public.assets(id),
  assigned_team_id uuid references public.teams(id),
  assigned_user_id uuid references public.users(id),
  workflow_id uuid references public.workflow_definitions(id),
  sla_id uuid references public.sla_policies(id),
  source_channel text default 'portal',
  tags text[] default '{}',
  watchers uuid[] default '{}', -- person IDs following this ticket
  cost numeric(12,2),
  satisfaction_rating smallint check (satisfaction_rating between 1 and 5),
  satisfaction_comment text,
  form_data jsonb, -- submitted form field values
  -- Computed SLA fields (updated by SLA engine, never calculated at query time)
  sla_response_due_at timestamptz,
  sla_resolution_due_at timestamptz,
  sla_response_breached_at timestamptz,
  sla_resolution_breached_at timestamptz,
  sla_at_risk boolean not null default false,
  sla_paused boolean not null default false,
  sla_paused_at timestamptz,
  sla_total_paused_minutes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  closed_at timestamptz
);

alter table public.tickets enable row level security;
create policy "tenant_isolation" on public.tickets
  using (tenant_id = public.current_tenant_id());

-- Critical composite indexes for service desk queue performance
create index idx_tickets_queue_primary on public.tickets (tenant_id, status_category, assigned_team_id, priority);
create index idx_tickets_queue_location on public.tickets (tenant_id, assigned_team_id, location_id, status_category);
create index idx_tickets_queue_sla on public.tickets (tenant_id, sla_at_risk, sla_resolution_due_at) where status_category not in ('resolved', 'closed');
create index idx_tickets_parent on public.tickets (parent_ticket_id) where parent_ticket_id is not null;
create index idx_tickets_requester on public.tickets (requester_person_id);
create index idx_tickets_assigned_user on public.tickets (assigned_user_id) where assigned_user_id is not null;
create index idx_tickets_tenant_created on public.tickets (tenant_id, created_at desc);

create trigger set_tickets_updated_at before update on public.tickets
  for each row execute function public.set_updated_at();

-- Add FK from workflow_instances to tickets
alter table public.workflow_instances
  add constraint fk_wi_ticket
  foreign key (ticket_id)
  references public.tickets(id);

-- Ticket activities: structured timeline
create table public.ticket_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  activity_type text not null check (activity_type in ('internal_note', 'external_comment', 'system_event')),
  author_person_id uuid references public.persons(id), -- null for system events
  visibility text not null check (visibility in ('internal', 'external', 'system')),
  content text,
  attachments jsonb default '[]'::jsonb, -- [{name, url, size, type}]
  metadata jsonb, -- structured data for system events (status change, assignment change, etc.)
  created_at timestamptz not null default now()
);

alter table public.ticket_activities enable row level security;
create policy "tenant_isolation" on public.ticket_activities
  using (tenant_id = public.current_tenant_id());

create index idx_ta_ticket on public.ticket_activities (ticket_id, created_at);
create index idx_ta_tenant on public.ticket_activities (tenant_id);

-- SLA timers: individual timer instances per ticket (supports multiple timers)
create table public.sla_timers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  sla_policy_id uuid not null references public.sla_policies(id),
  timer_type text not null check (timer_type in ('response', 'resolution')),
  target_minutes integer not null,
  started_at timestamptz not null default now(),
  due_at timestamptz not null,
  paused boolean not null default false,
  paused_at timestamptz,
  total_paused_minutes integer not null default 0,
  breached boolean not null default false,
  breached_at timestamptz,
  completed_at timestamptz,
  business_hours_calendar_id uuid references public.business_hours_calendars(id)
);

alter table public.sla_timers enable row level security;
create policy "tenant_isolation" on public.sla_timers
  using (tenant_id = public.current_tenant_id());

create index idx_sla_timers_ticket on public.sla_timers (ticket_id);
create index idx_sla_timers_due on public.sla_timers (due_at) where breached = false and completed_at is null;
