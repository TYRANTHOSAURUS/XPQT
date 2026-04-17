-- Inbound webhooks: public POST endpoint → creates a ticket → starts a workflow

create table public.workflow_webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  workflow_id uuid not null references public.workflow_definitions(id) on delete cascade,
  name text not null,
  token text not null unique,
  active boolean not null default true,
  ticket_defaults jsonb not null default '{}'::jsonb,
  field_mapping jsonb not null default '{}'::jsonb,
  last_received_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workflow_webhooks enable row level security;

create policy "tenant_isolation" on public.workflow_webhooks
  using (tenant_id = public.current_tenant_id());

create index idx_wwh_token on public.workflow_webhooks (token);
create index idx_wwh_workflow on public.workflow_webhooks (workflow_id);
create index idx_wwh_tenant on public.workflow_webhooks (tenant_id);

create trigger set_wwh_updated_at before update on public.workflow_webhooks
  for each row execute function public.set_updated_at();
