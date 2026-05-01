-- 00270_visitor_status_insert_validation_and_service_marker.sql
-- Visitor Management v1 — full-review fixes I1 + I2.
--
-- Spec ref: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §5
-- Plan ref: docs/superpowers/plans/2026-05-01-visitor-management-v1.md
--
-- Two defense-in-depth gates on `visitors.status`, on top of migration 00253:
--
-- (I2) FSM trigger now fires on INSERT too.
--   00253 only validated UPDATE OF status. INSERT could write any string
--   that satisfied the CHECK constraint — including terminal states like
--   'checked_out' or 'no_show'. This trigger restricts the set of *initial*
--   statuses to the §5 incoming edges:
--     ('pending_approval', 'expected', 'cancelled', 'denied').
--   ('expected' is allowed because InvitationService writes it directly
--    when the visitor type does not require approval.
--    'cancelled' and 'denied' are intentionally allowed for the rare path
--    where a record is created already-terminated by a future cascade
--    backfill or DSR replay; the §5 matrix has no transition INTO them
--    other than from upstream states, but we don't want a bug to fail
--    closed if a future feature inserts a tombstone row.)
--   The previous UPDATE branch is preserved unchanged — same matrix as 00253.
--
-- (I1) Single-write-path enforcement on UPDATE OF status.
--   Even with the FSM matrix, ANY service can write `UPDATE visitors SET
--   status = 'cancelled'` directly, bypassing VisitorService.transitionStatus.
--   That service is the only place we run idempotency checks, audit
--   inserts, downstream domain_event emits, and pass-state side-effects.
--   A bypass that satisfies the matrix still skips all of that.
--
--   Pattern: VisitorService.transitionStatus issues `SET LOCAL
--   visitors.transition_marker = 'true'` inside its tx. The trigger reads
--   `current_setting('visitors.transition_marker', true)`. `true` second
--   arg means "missing setting returns NULL instead of erroring", so the
--   trigger raises only when the setting was never set in the current
--   transaction. Other transactions / contexts (admin SQL, an unwary
--   service that calls UPDATE directly) hit the exception.
--
--   The matrix check still runs first — i.e., a same-status no-op (NEW =
--   OLD) passes through without checking the marker, so admin-issued
--   non-status UPDATEs (`set logged_at = ...`) are unaffected (`UPDATE OF
--   status` only fires when status is in the column list of the UPDATE).
--
-- Local-setting semantics:
--   `set local <name> = '<value>'` sets the value for the current tx only;
--   COMMIT/ROLLBACK clears it. `set_config(name, value, true)` is the
--   functional equivalent and is what Postgres recommends for non-DDL
--   contexts. We accept either; the trigger only checks `is null`, so the
--   value itself is opaque.

-- ─── (I2) drop + recreate combined trigger (INSERT + UPDATE) ──────────────────

create or replace function public.assert_visitor_status_transition() returns trigger
  language plpgsql as $$
declare
  v_marker text;
begin
  if (tg_op = 'INSERT') then
    -- Restrict initial status to §5 incoming-edge states. The matrix has
    -- no transition INTO 'arrived' / 'in_meeting' / 'checked_out' / 'no_show'
    -- from outside ('expected' is the only on-ramp); seed-data and DSR
    -- replays should never insert a row already past 'expected'.
    if new.status not in ('pending_approval', 'expected', 'cancelled', 'denied') then
      raise exception 'invalid initial visitor status on insert: %', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE branch — preserve the original §5 matrix from migration 00253.

  -- No-op when status is not actually changing.
  if old.status is not distinct from new.status then
    return new;
  end if;

  -- (I1) single-write-path enforcement. The marker is set by
  -- VisitorService.transitionStatus inside its transaction. Any other
  -- caller writing `UPDATE visitors SET status = ...` directly hits this
  -- exception. We check before the matrix so the error message points at
  -- the real defect (bypass) rather than masquerading as a state
  -- violation.
  v_marker := current_setting('visitors.transition_marker', true);
  if v_marker is null or v_marker = '' then
    raise exception
      'visitors.status writes must go through VisitorService.transitionStatus (%->%)',
      old.status, new.status
      using errcode = 'check_violation';
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
  before insert or update of status on public.visitors
  for each row execute function public.assert_visitor_status_transition();

comment on function public.assert_visitor_status_transition() is
  'Defense-in-depth visitor status FSM. INSERT branch restricts initial status to §5 incoming-edge values. UPDATE branch checks the visitors.transition_marker session setting (set by VisitorService.transitionStatus) AND the §5 transition matrix — bypass writes raise even if they satisfy the matrix.';

notify pgrst, 'reload schema';
