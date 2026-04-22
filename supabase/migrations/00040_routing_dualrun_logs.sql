-- 00040_routing_dualrun_logs.sql
-- Workstream 0 / Artifact E:
-- Dual-run diff storage. Every time the Routing Evaluator runs in a mode other
-- than 'off', it writes one row here capturing legacy vs v2 outcomes so the
-- integration owner can verify < 0.1% diff rate before flipping to v2_only.
--
-- Hook: apps/api/src/modules/routing/routing-evaluator.service.ts (W0-5).
-- Mode: tenants.feature_flags.routing_v2_mode ('off'|'dualrun'|'shadow'|'v2_only').

create table if not exists public.routing_dualrun_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  evaluated_at timestamptz not null default now(),
  mode text not null check (mode in ('dualrun', 'shadow', 'v2_only')),
  hook text not null check (hook in ('case_owner', 'child_dispatch')),
  ticket_id uuid references public.tickets(id),
  request_type_id uuid references public.request_types(id),
  input jsonb not null,
  legacy_output jsonb,
  v2_output jsonb,
  target_match boolean,
  chosen_by_match boolean,
  diff_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.routing_dualrun_logs enable row level security;

create policy "tenant_isolation" on public.routing_dualrun_logs
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_routing_dualrun_tenant_evaluated
  on public.routing_dualrun_logs (tenant_id, evaluated_at desc);

create index if not exists idx_routing_dualrun_tenant_diff
  on public.routing_dualrun_logs (tenant_id, evaluated_at desc)
  where target_match is false or chosen_by_match is false;

create index if not exists idx_routing_dualrun_ticket
  on public.routing_dualrun_logs (ticket_id)
  where ticket_id is not null;

comment on table public.routing_dualrun_logs is
  'Routing Studio v2 dual-run diffs. One row per evaluation when routing_v2_mode != off. Used to verify v2 matches legacy before cutover.';
