-- Workflow instance event log for execution history + runtime viewer

create table public.workflow_instance_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  workflow_instance_id uuid not null references public.workflow_instances(id) on delete cascade,
  event_type text not null check (event_type in (
    'node_entered', 'node_exited', 'decision_made',
    'instance_started', 'instance_completed', 'instance_failed',
    'instance_waiting', 'instance_resumed'
  )),
  node_id text,
  node_type text,
  decision text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.workflow_instance_events enable row level security;

create policy "tenant_isolation" on public.workflow_instance_events
  using (tenant_id = public.current_tenant_id());

create index idx_wie_instance_time
  on public.workflow_instance_events (workflow_instance_id, created_at);
create index idx_wie_tenant on public.workflow_instance_events (tenant_id);
