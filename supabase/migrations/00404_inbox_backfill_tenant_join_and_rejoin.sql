-- 00404 — inbox_backfill_on_team_member_insert hardening
--
-- Closes 2 IMPORTANTs from the 3-reviewer pass (codex + main + plan-coverage)
-- on B.4.A.5 notification dispatch. Both changes redefine the SAME function
-- introduced by 00402:102-131 — `public.inbox_backfill_on_team_member_insert`.
--
-- Fix #2 (codex) — tenant-validated JOIN to public.users.
--   00402's backfill SELECTs `new.user_id` directly from team_members without
--   verifying that the user's home tenant matches the team's tenant. If a
--   malformed team_members row exists (`team_members.tenant_id` ≠
--   `users.tenant_id` for the same user_id), the inbox row is written to the
--   WRONG tenant — a cross-tenant leak via an indirect path.
--
--   The sibling trigger `public.inbox_notify_on_approval_insert` (00402:36-94)
--   already uses tenant-validated JOIN — see 00402:66-68 (person path) and
--   00402:83-85 (team path). The backfill trigger missed this guard.
--
--   Fix: add `JOIN public.users u ON u.id = new.user_id AND u.tenant_id =
--   new.tenant_id`. If the guard fails (cross-tenant user_id), the SELECT
--   yields 0 rows and no inbox row is written. The projection still references
--   `new.user_id` (the JOIN is purely a guard — the resolved user_id is
--   identical when the guard passes).
--
-- Fix #3 (codex) — re-join resets unread state.
--   00402's backfill uses `on conflict (...) do nothing`. The team-member
--   DELETE trigger (00402:139-166) only deletes UNREAD rows on leave (read
--   rows stay for auditability). Scenario:
--     1. User A in team T. Approval raised → inbox row created (unread).
--     2. User A reads the inbox row (read_at set).
--     3. User A leaves team T. Read row stays (00402:162 read_at-IS-NULL
--        guard).
--     4. Approval still pending. User A rejoins team T. Backfill SELECT
--        yields a row, but ON CONFLICT DO NOTHING swallows it.
--   → User A has zero unread for a still-pending approval they can action.
--
--   Fix: ON CONFLICT DO UPDATE SET read_at = NULL, created_at = now() WHERE
--   inbox_notifications.read_at IS NOT NULL. The WHERE clause means:
--     - Existing row already unread (read_at IS NULL) → WHERE false → no
--       update; row stays as-is. (Avoids spuriously bumping created_at on
--       team-membership churn that doesn't change anything user-visible.)
--     - Existing row read (read_at IS NOT NULL) → WHERE true → read_at
--       nulled + created_at refreshed; user sees fresh unread on rejoin.
--
-- Sibling-trigger audit. The 00402 main fan-out
-- `inbox_notify_on_approval_insert` (lines 36-94) ALREADY uses the tenant-
-- validated JOIN pattern on both branches:
--   - person branch (66-68): `from public.users u where u.person_id = new
--     .approver_person_id and u.tenant_id = new.tenant_id`
--   - team branch (82-87): `from public.team_members tm join public.users
--     u on u.id = tm.user_id and u.tenant_id = new.tenant_id where tm
--     .team_id = new.approver_team_id and tm.tenant_id = new.tenant_id`
-- No fix needed there.
--
-- Function signature unchanged; `create or replace` swaps the body in place.
-- The existing trigger binding (`trg_inbox_backfill_on_team_member_insert`
-- on `public.team_members AFTER INSERT FOR EACH ROW`) continues to use the
-- redefined function automatically. For explicit safety + parity with 00402's
-- pattern, also re-run the drop trigger / create trigger DDL below.

create or replace function public.inbox_backfill_on_team_member_insert()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  -- Find every unresolved (pending) booking approval where the team is
  -- the assigned approver; mint one inbox row for the new team member.
  --
  -- The JOIN to public.users (Fix #2) enforces the tenant-validated user
  -- resolution that the sibling `inbox_notify_on_approval_insert` already
  -- has. If new.user_id's home tenant doesn't match new.tenant_id, the
  -- SELECT yields 0 rows and we no-op rather than write a cross-tenant
  -- inbox row.
  --
  -- The ON CONFLICT DO UPDATE clause (Fix #3) handles the read→leave→
  -- rejoin race: the WHERE-on-read_at-not-null gate means currently-unread
  -- rows are NOT touched (no spurious created_at churn), while previously-
  -- read rows get re-unread with a fresh created_at so the rejoiner sees
  -- a current unread notification for the still-pending approval.
  insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
  select a.tenant_id, new.user_id, 'booking.approval_required',
         jsonb_build_object(
           'booking_id',        a.target_entity_id,
           'chain_id',          a.approval_chain_id,
           'approver_team_id',  a.approver_team_id
         )
  from public.approvals a
  join public.users u
    on u.id = new.user_id
   and u.tenant_id = new.tenant_id
  where a.approver_team_id = new.team_id
    and a.tenant_id = new.tenant_id
    and a.target_entity_type = 'booking'
    and a.status = 'pending'
    and a.approval_chain_id is not null
  on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
    where (payload ? 'chain_id') do update
      set read_at    = null,
          created_at = now()
      where inbox_notifications.read_at is not null;

  return new;
end;
$$;

drop trigger if exists trg_inbox_backfill_on_team_member_insert on public.team_members;
create trigger trg_inbox_backfill_on_team_member_insert
  after insert on public.team_members
  for each row execute function public.inbox_backfill_on_team_member_insert();

comment on function public.inbox_backfill_on_team_member_insert is
  'B.4.A.5 Plan C2 + 00404 hardening: backfills inbox_notifications for users joining a team with open pending booking approvals. JOINs public.users to enforce tenant-validated user resolution (closes cross-tenant leak path for malformed team_members rows). ON CONFLICT DO UPDATE resets read_at = NULL + bumps created_at only for previously-read rows (handles read → leave → rejoin race), leaves unread rows untouched.';

notify pgrst, 'reload schema';
