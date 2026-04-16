-- Domain events and audit events

-- Domain events: business transitions for reporting and analytics
create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  event_type text not null, -- ticket_created, ticket_assigned, ticket_status_changed, etc.
  entity_type text not null,
  entity_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  actor_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);

alter table public.domain_events enable row level security;
create policy "tenant_isolation" on public.domain_events
  using (tenant_id = public.current_tenant_id());

create index idx_de_tenant_type on public.domain_events (tenant_id, event_type);
create index idx_de_entity on public.domain_events (entity_type, entity_id);
create index idx_de_tenant_created on public.domain_events (tenant_id, created_at desc);

-- Audit events: security and admin actions
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  event_type text not null, -- config_published, role_changed, manual_override, etc.
  entity_type text,
  entity_id uuid,
  actor_user_id uuid references public.users(id),
  details jsonb not null default '{}'::jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);

alter table public.audit_events enable row level security;
create policy "tenant_isolation" on public.audit_events
  using (tenant_id = public.current_tenant_id());

create index idx_ae_tenant_type on public.audit_events (tenant_id, event_type);
create index idx_ae_tenant_created on public.audit_events (tenant_id, created_at desc);
