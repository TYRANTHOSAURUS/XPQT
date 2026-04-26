-- 00136_reservation_policy_snapshot_merge.sql
-- Atomically merge a JSON object into reservations.policy_snapshot.
--
-- Without this, the application code would have to:
--   1. SELECT the row
--   2. spread the snapshot in JS
--   3. UPDATE with the merged object
-- which is last-writer-wins and silently clobbers any concurrent updates
-- to the same column. The check-in reminder scanner ran exactly that
-- pattern; one cron tick stomping another's notification metadata is
-- harmless today but the same shape will bite when more fields land.
--
-- This RPC merges via the JSONB || operator at the DB layer, which is
-- atomic at the row level.

create or replace function public.reservation_merge_policy_snapshot(
  p_reservation_id uuid,
  p_patch jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  update public.reservations
     set policy_snapshot = coalesce(policy_snapshot, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb),
         updated_at = now()
   where id = p_reservation_id
     and tenant_id = public.current_tenant_id();
$$;

comment on function public.reservation_merge_policy_snapshot(uuid, jsonb) is
  'Atomically merges a JSONB patch into reservations.policy_snapshot. Use instead of select-modify-update to avoid last-writer-wins races.';

-- Grant execute to authenticated callers; tenant scope is enforced by
-- the function itself (current_tenant_id() must match the row).
grant execute on function public.reservation_merge_policy_snapshot(uuid, jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';
