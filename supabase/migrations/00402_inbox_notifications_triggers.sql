-- 00402 — inbox_notifications triggers (Plan C1 + C2 from /full-review of B.4.A.5)
--
-- Plan C1: decouple inbox INSERT from the producer (RPCs vs. Phase 1.5
--   workflow engine). The trigger fires on every approvals row insert,
--   so engine-driven approvals also get notified.
--
-- Plan C2: handle team-membership churn — backfill inbox rows for users
--   who join the team after the approval was raised; remove stale unread
--   rows when a user leaves the team.
--
-- The existing manual INSERT in 00394 + 00395 stays in place; the trigger
-- uses ON CONFLICT DO NOTHING against 00391's partial unique index so both
-- paths are mutually idempotent.
--
-- v1 scope: only target_entity_type = 'booking' (other approval entity
-- types don't have notification substrate yet — adding them later is a
-- pure data path; this migration's contract is "if there's a notification
-- substrate for target type X, the trigger emits for X").
--
-- Citations:
-- - supabase/migrations/00012 — public.approvals schema (target_entity_type
--   check covers booking|order|ticket|visitor_invite; status default
--   'pending'; approver_person_id FK persons; approver_team_id FK teams).
-- - supabase/migrations/00391_inbox_notifications.sql — table + partial
--   unique index `uq_inbox_notifications_chain` on
--   (tenant_id, user_id, event_kind, (payload->>'chain_id'))
--   WHERE (payload ? 'chain_id') — the ON CONFLICT target here.
-- - supabase/migrations/00394_edit_booking_rpc_v5.sql:822-851 — canonical
--   inbox fan-out shape (person path: JOIN public.users on person_id;
--   team path: JOIN team_members + users on user_id; both tenant-scoped).
--   The trigger mirrors this byte-for-byte so ON CONFLICT keys match.
-- - supabase/migrations/00003 — public.team_members(team_id, user_id)
--   UNIQUE; FK users(id) ON DELETE CASCADE.

-- ─── Trigger 1: approvals AFTER INSERT — Plan C1 ─────────────────────────
create or replace function public.inbox_notify_on_approval_insert()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  -- v1 scope: only target_entity_type = 'booking' has notification substrate.
  -- Only fire on initial pending insertions; delegations come through later
  -- UPDATEs (not handled here).
  if new.target_entity_type <> 'booking' or new.status <> 'pending' then
    return new;
  end if;

  -- Without chain_id we can't dedup via the partial unique index. Plan v2
  -- and the existing RPC inbox INSERTs both require chain_id. Silently
  -- skip rather than write a non-dedupable row.
  if new.approval_chain_id is null then
    return new;
  end if;

  if new.approver_person_id is not null then
    -- Mirror 00394:822-833 — JOIN persons → users (tenant-scoped both sides).
    insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
    select new.tenant_id, u.id, 'booking.approval_required',
           jsonb_build_object(
             'booking_id',          new.target_entity_id,
             'chain_id',            new.approval_chain_id,
             'approver_person_id',  new.approver_person_id
           )
    from public.users u
    where u.person_id = new.approver_person_id
      and u.tenant_id = new.tenant_id
    on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
      where (payload ? 'chain_id') do nothing;

  elsif new.approver_team_id is not null then
    -- Mirror 00394:836-850 — JOIN team_members + users (tenant-scoped both
    -- sides via 00003's tm.tenant_id + u.tenant_id).
    insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
    select new.tenant_id, u.id, 'booking.approval_required',
           jsonb_build_object(
             'booking_id',        new.target_entity_id,
             'chain_id',          new.approval_chain_id,
             'approver_team_id',  new.approver_team_id
           )
    from public.team_members tm
    join public.users u
      on u.id = tm.user_id
     and u.tenant_id = new.tenant_id
    where tm.team_id = new.approver_team_id
      and tm.tenant_id = new.tenant_id
    on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
      where (payload ? 'chain_id') do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_inbox_notify_on_approval_insert on public.approvals;
create trigger trg_inbox_notify_on_approval_insert
  after insert on public.approvals
  for each row execute function public.inbox_notify_on_approval_insert();

-- ─── Trigger 2: team_members AFTER INSERT — Plan C2 backfill ─────────────
create or replace function public.inbox_backfill_on_team_member_insert()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  -- Find every unresolved (pending) booking approval where the team is
  -- the assigned approver; mint one inbox row for the new team member.
  -- ON CONFLICT covers the (rare) case where the person was added,
  -- removed, re-added — keeps idempotency tight.
  insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
  select a.tenant_id, new.user_id, 'booking.approval_required',
         jsonb_build_object(
           'booking_id',        a.target_entity_id,
           'chain_id',          a.approval_chain_id,
           'approver_team_id',  a.approver_team_id
         )
  from public.approvals a
  where a.approver_team_id = new.team_id
    and a.tenant_id = new.tenant_id
    and a.target_entity_type = 'booking'
    and a.status = 'pending'
    and a.approval_chain_id is not null
  on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
    where (payload ? 'chain_id') do nothing;

  return new;
end;
$$;

drop trigger if exists trg_inbox_backfill_on_team_member_insert on public.team_members;
create trigger trg_inbox_backfill_on_team_member_insert
  after insert on public.team_members
  for each row execute function public.inbox_backfill_on_team_member_insert();

-- ─── Trigger 3: team_members AFTER DELETE — Plan C2 cleanup ──────────────
create or replace function public.inbox_cleanup_on_team_member_delete()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  -- When a user leaves a team, remove their UNREAD inbox rows for any
  -- still-unresolved booking approvals where THIS team was the approver.
  -- Read rows stay — auditability + the user already saw them.
  -- Status-still-pending check prevents removing legitimate rows for an
  -- approval that the team has already actioned on a sibling row.
  delete from public.inbox_notifications i
  using public.approvals a
  where a.approver_team_id = old.team_id
    and a.tenant_id = old.tenant_id
    and a.target_entity_type = 'booking'
    and a.status = 'pending'
    and i.tenant_id = old.tenant_id
    and i.user_id = old.user_id
    and i.event_kind = 'booking.approval_required'
    and i.payload->>'chain_id' = a.approval_chain_id::text
    and i.payload->>'approver_team_id' = a.approver_team_id::text
    and i.read_at is null;

  return old;
end;
$$;

drop trigger if exists trg_inbox_cleanup_on_team_member_delete on public.team_members;
create trigger trg_inbox_cleanup_on_team_member_delete
  after delete on public.team_members
  for each row execute function public.inbox_cleanup_on_team_member_delete();

comment on function public.inbox_notify_on_approval_insert is
  'B.4.A.5 Plan C1: emits inbox_notifications rows for booking approvals on INSERT. Mirrors 00394 + 00395 inline fan-out byte-for-byte; ON CONFLICT DO NOTHING via uq_inbox_notifications_chain (00391) makes RPC-path + engine-path mutually idempotent. v1 scope: target_entity_type=booking only.';

comment on function public.inbox_backfill_on_team_member_insert is
  'B.4.A.5 Plan C2: backfills inbox_notifications rows for users joining a team that has open pending booking approvals. Same ON CONFLICT idempotency.';

comment on function public.inbox_cleanup_on_team_member_delete is
  'B.4.A.5 Plan C2: removes UNREAD inbox_notifications rows for users leaving a team with open pending booking approvals. Read rows stay for auditability.';
