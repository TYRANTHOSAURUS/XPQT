-- 00382_work_orders_plan_version.sql
--
-- P1-2 (handoff §3): optimistic-lock column on `work_orders` so two
-- dispatchers racing the same drag can't silently overwrite each other.
-- The "lock" is row-version on planning columns only — bumped by trigger,
-- never by application code. The PATCH endpoint compares the caller's
-- `plan_version` against the row's current value; mismatch → 409
-- `planning.version_conflict` (registered in @prequest/shared, rendered
-- via the existing reservation.version_conflict pattern).
--
-- Why a column + trigger (not If-Match):
--   - The Supabase admin client doesn't ergonomically attach If-Match
--     to its `.update` builder (we'd have to drop to raw HTTP).
--   - Column-driven bumps are auditable on the row itself; the trigger
--     fires inside the same transaction as the UPDATE, so the bump is
--     transactionally consistent with the planning-column write.
--   - Default of 1 keeps every existing row at a stable starting point;
--     the FE compares against the version it last read.
--
-- Bumped columns: planned_start_at, planned_duration_minutes,
-- assigned_team_id, assigned_user_id, assigned_vendor_id. Per handoff:
-- "any of `planned_start_at`, `planned_duration_minutes`, `planned_lane_id`
-- (or the equivalent assignment columns — verify against the actual
-- schema)". `work_orders` has no `planned_lane_id` — lane is derived
-- server-side from the assignment columns + dimension hydration
-- (work-order-planning.service.ts:166-171). The three assignment
-- columns are the right proxy for "lane changed", which is the other
-- racing-drag gesture (cross-lane drop) we need to lock.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION +
-- DROP TRIGGER IF EXISTS so re-runs are safe under the project's
-- destructive-default invariant (.claude/CLAUDE.md). The `update of`
-- clause scopes the trigger to the five relevant columns — UPDATEs that
-- touch other columns (status, priority, sla_id, title, tags) leave
-- plan_version unchanged.

alter table public.work_orders
  add column if not exists plan_version int not null default 1;

comment on column public.work_orders.plan_version is
  'Optimistic-lock version. Bumped by tg_work_orders_plan_version_bump on any update of planned_start_at, planned_duration_minutes, or the three assignment columns (assigned_team_id, assigned_user_id, assigned_vendor_id). Compared by PATCH /work-orders/:id; mismatch → 409 planning.version_conflict.';

create or replace function public.tg_work_orders_plan_version_bump()
returns trigger
language plpgsql
as $$
begin
  -- update-of-list at the trigger level already restricts firing to the
  -- five planning columns; the inner check distinguishes a no-op write
  -- (UPDATE … SET planned_start_at = planned_start_at) from a real
  -- change and avoids gratuitous version churn that would force the FE
  -- to refetch on every save. IS DISTINCT FROM treats NULLs as equal,
  -- which is what we want — clearing an already-null column is a no-op.
  if new.planned_start_at is distinct from old.planned_start_at
     or new.planned_duration_minutes is distinct from old.planned_duration_minutes
     or new.assigned_team_id is distinct from old.assigned_team_id
     or new.assigned_user_id is distinct from old.assigned_user_id
     or new.assigned_vendor_id is distinct from old.assigned_vendor_id
  then
    new.plan_version := coalesce(old.plan_version, 1) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_work_orders_plan_version_bump on public.work_orders;

create trigger tg_work_orders_plan_version_bump
  before update of
    planned_start_at,
    planned_duration_minutes,
    assigned_team_id,
    assigned_user_id,
    assigned_vendor_id
  on public.work_orders
  for each row
  execute function public.tg_work_orders_plan_version_bump();

comment on function public.tg_work_orders_plan_version_bump() is
  'Increments plan_version when any planning column actually changes. Scoped to UPDATE OF on the five tracked columns so other writes (status, priority, sla, title) leave the version unchanged.';
