-- 00253_visitor_status_state_machine.sql
-- Visitor Management v1 — defense-in-depth status transition trigger.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §5
--
-- VisitorService.transitionStatus is the only application code path that
-- writes visitors.status. This trigger catches any bypass — direct SQL,
-- a migration that edits status, a future code path that forgets the
-- service. Allowed transitions per the spec §5 matrix:
--
--   pending_approval → expected | denied | cancelled
--   expected         → arrived  | no_show | cancelled | denied
--   arrived          → in_meeting | checked_out
--   in_meeting       → checked_out
--
-- All terminal states (checked_out / no_show / cancelled / denied) reject
-- further status changes. Same-value updates (status NOT changed) pass
-- through unchanged.

create or replace function public.assert_visitor_status_transition() returns trigger
  language plpgsql as $$
begin
  -- No-op when status is not actually changing.
  if old.status is not distinct from new.status then
    return new;
  end if;

  if not exists (
    select 1 from (values
      ('pending_approval','expected'),
      ('pending_approval','denied'),
      ('pending_approval','cancelled'),
      ('expected','arrived'),
      ('expected','no_show'),
      ('expected','cancelled'),
      ('expected','denied'),
      ('arrived','in_meeting'),
      ('arrived','checked_out'),
      ('in_meeting','checked_out')
    ) as t(from_s, to_s)
    where t.from_s = old.status and t.to_s = new.status
  ) then
    raise exception 'invalid visitor status transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_visitor_status_transition on public.visitors;
create trigger trg_visitor_status_transition
  before update of status on public.visitors
  for each row execute function public.assert_visitor_status_transition();

comment on function public.assert_visitor_status_transition() is
  'Defense-in-depth visitor status FSM. App layer (VisitorService.transitionStatus) is the canonical write path; this trigger blocks bypass writes that violate the §5 transition matrix.';

notify pgrst, 'reload schema';
