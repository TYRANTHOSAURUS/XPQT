-- 00066_tickets_requested_for.sql
-- Requester vs requested-for split. requester_person_id stays meaning "who
-- submitted" (auth-bound on portal path). requested_for_person_id is who the
-- service is for — defaults to requester when self-submitting.
-- See docs/service-catalog-redesign.md §3.10

alter table public.tickets
  add column if not exists requested_for_person_id uuid references public.persons(id);

create index if not exists idx_tickets_requested_for on public.tickets (requested_for_person_id)
  where requested_for_person_id is not null;

comment on column public.tickets.requester_person_id is
  'Who submitted the ticket (auth-bound on portal path).';
comment on column public.tickets.requested_for_person_id is
  'Who the service is for. Equals requester_person_id when the submitter acts for themselves. Null legacy rows treated as equal to requester_person_id by readers.';
