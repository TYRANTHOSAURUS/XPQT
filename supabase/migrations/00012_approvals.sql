-- Approvals: single-step, sequential multi-step, parallel multi-step

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  target_entity_type text not null, -- 'ticket', 'reservation', 'order', etc.
  target_entity_id uuid not null,
  approval_chain_id uuid, -- groups steps in a multi-step approval
  step_number integer, -- position in sequential chain (1, 2, 3...)
  parallel_group text, -- groups approvers that must all approve in parallel
  approver_person_id uuid references public.persons(id),
  approver_team_id uuid references public.teams(id),
  delegated_to_person_id uuid references public.persons(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'delegated', 'expired')),
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  comments text,
  created_at timestamptz not null default now()
);

alter table public.approvals enable row level security;
create policy "tenant_isolation" on public.approvals
  using (tenant_id = public.current_tenant_id());

create index idx_approvals_tenant on public.approvals (tenant_id);
create index idx_approvals_target on public.approvals (target_entity_type, target_entity_id);
create index idx_approvals_approver on public.approvals (approver_person_id) where status = 'pending';
create index idx_approvals_chain on public.approvals (approval_chain_id) where approval_chain_id is not null;
create index idx_approvals_pending on public.approvals (tenant_id, status) where status = 'pending';
