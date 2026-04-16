-- Workflow definitions and runtime instances

create table public.workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  config_entity_id uuid references public.config_entities(id),
  name text not null,
  entity_type text not null default 'ticket',
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'published')),
  graph_definition jsonb not null default '{}'::jsonb, -- nodes + edges + per-node config
  created_by uuid references public.users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workflow_definitions enable row level security;
create policy "tenant_isolation" on public.workflow_definitions
  using (tenant_id = public.current_tenant_id());

create index idx_wd_tenant on public.workflow_definitions (tenant_id);

create trigger set_wd_updated_at before update on public.workflow_definitions
  for each row execute function public.set_updated_at();

-- Workflow instances: runtime state per ticket
create table public.workflow_instances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  workflow_definition_id uuid not null references public.workflow_definitions(id),
  workflow_version integer not null,
  ticket_id uuid not null, -- FK added after tickets table exists
  current_node_id text,
  status text not null default 'active' check (status in ('active', 'waiting', 'completed', 'failed')),
  waiting_for text, -- what the instance is paused on: approval, child_tasks, timer, event
  context jsonb not null default '{}'::jsonb, -- accumulated state and decisions
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.workflow_instances enable row level security;
create policy "tenant_isolation" on public.workflow_instances
  using (tenant_id = public.current_tenant_id());

create index idx_wi_tenant on public.workflow_instances (tenant_id);
create index idx_wi_ticket on public.workflow_instances (ticket_id);
create index idx_wi_status on public.workflow_instances (status) where status in ('active', 'waiting');
