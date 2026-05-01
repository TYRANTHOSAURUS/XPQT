-- Plandate on tickets
--
-- Adds the assignee-side commitment field: when the work is planned to start,
-- and (optionally) for how long. Distinct from:
--   • sla_resolution_due_at — the SLA / customer commitment (deadline)
--   • resolved_at           — when work actually completed
--
-- Settable by the parent-case team, the WO assignee (user), or the assigned
-- vendor. Read-visible to anyone who can read the ticket. The cap is enforced
-- in the API (see TicketVisibilityService.assertCanPlan); RLS still gates
-- tenant isolation as before.

alter table public.tickets
  add column if not exists planned_start_at timestamptz,
  add column if not exists planned_duration_minutes integer;

alter table public.tickets
  drop constraint if exists chk_tickets_planned_duration_positive;
alter table public.tickets
  add constraint chk_tickets_planned_duration_positive
  check (planned_duration_minutes is null or planned_duration_minutes > 0);

-- "What's planned this week?" — global board scan.
create index if not exists idx_tickets_planned
  on public.tickets (tenant_id, planned_start_at)
  where planned_start_at is not null;

-- Resource-calendar lanes per assignee/vendor/team — the planning board reads these.
create index if not exists idx_tickets_planned_assignee
  on public.tickets (tenant_id, assigned_user_id, planned_start_at)
  where planned_start_at is not null and assigned_user_id is not null;

create index if not exists idx_tickets_planned_vendor
  on public.tickets (tenant_id, assigned_vendor_id, planned_start_at)
  where planned_start_at is not null and assigned_vendor_id is not null;

create index if not exists idx_tickets_planned_team
  on public.tickets (tenant_id, assigned_team_id, planned_start_at)
  where planned_start_at is not null and assigned_team_id is not null;

comment on column public.tickets.planned_start_at is
  'Assignee-declared planned start time. Distinct from sla_resolution_due_at (deadline) and resolved_at (actual). Set via /tickets/:id/plan.';
comment on column public.tickets.planned_duration_minutes is
  'Optional planned duration. Resource calendar renders spans when set, points when null.';

notify pgrst, 'reload schema';
