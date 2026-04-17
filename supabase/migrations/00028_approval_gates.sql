-- 00028_approval_gates.sql
-- Approval gates: request types can require approval before routing.

-- Allow a new status_category on tickets for the "awaiting approval" state.
alter table public.tickets drop constraint if exists tickets_status_category_check;
alter table public.tickets add constraint tickets_status_category_check
  check (status_category in ('new', 'assigned', 'in_progress', 'waiting', 'pending_approval', 'resolved', 'closed'));

-- Configure approval requirements on the request type.
alter table public.request_types
  add column if not exists requires_approval boolean not null default false,
  add column if not exists approval_approver_team_id uuid references public.teams(id),
  add column if not exists approval_approver_person_id uuid references public.persons(id);
