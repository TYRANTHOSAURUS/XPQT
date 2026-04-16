-- Notifications: delivery records and user preferences

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  notification_type text not null,
  target_channel text not null check (target_channel in ('email', 'in_app')),
  recipient_person_id uuid references public.persons(id),
  recipient_team_id uuid references public.teams(id),
  template_id uuid references public.config_entities(id),
  related_entity_type text,
  related_entity_id uuid,
  subject text,
  body text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'read')),
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;
create policy "tenant_isolation" on public.notifications
  using (tenant_id = public.current_tenant_id());

create index idx_notifications_recipient on public.notifications (recipient_person_id, status);
create index idx_notifications_tenant on public.notifications (tenant_id);
create index idx_notifications_pending on public.notifications (status) where status = 'pending';

-- User notification preferences
create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id),
  event_type text not null, -- e.g. 'ticket_assigned', 'approval_requested', etc.
  email_enabled boolean not null default true,
  in_app_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, event_type)
);

alter table public.notification_preferences enable row level security;
create policy "tenant_isolation" on public.notification_preferences
  using (tenant_id = public.current_tenant_id());

create index idx_np_user on public.notification_preferences (user_id);
