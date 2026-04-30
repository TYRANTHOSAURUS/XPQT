-- 00198_claim_deferred_setup_args.sql
-- Atomic claim of deferred setup-work-order TriggerArgs, used by
-- BundleService.onApprovalDecided. Closes the truly-concurrent-grant race:
-- two approvers granting on the same bundle at the same instant (multiple
-- API instances OR overlapping requests) could both pass the
-- `areAllTargetApprovalsApproved` check, both read the same set of OLIs
-- with non-null `pending_setup_trigger_args`, and both fire the trigger,
-- producing duplicate work orders.
--
-- This function uses `FOR UPDATE` locking to ensure only one caller can
-- claim the args for a given OLI. The second caller blocks on the row
-- lock until the first completes, then sees `pending_setup_trigger_args
-- IS NULL` and returns nothing — no double-fire.
--
-- Posture:
--   * SECURITY DEFINER so service-role calls bypass RLS without leaking
--     RLS bypass to authenticated users.
--   * `set search_path = public` to neutralise search-path-injection
--     attacks against SECURITY DEFINER functions.
--   * Returns the OLD args value (captured before the UPDATE NULLs it),
--     so callers don't need a separate read-then-clear cycle.
--   * Service-role only — see the GRANT below.

create or replace function public.claim_deferred_setup_trigger_args(
  p_tenant_id uuid,
  p_order_ids uuid[]
) returns table(oli_id uuid, args jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  for rec in
    select id, pending_setup_trigger_args
    from public.order_line_items
    where order_id = any(p_order_ids)
      and tenant_id = p_tenant_id
      and pending_setup_trigger_args is not null
    for update
  loop
    update public.order_line_items
    set pending_setup_trigger_args = null
    where id = rec.id;

    oli_id := rec.id;
    args := rec.pending_setup_trigger_args;
    return next;
  end loop;
end;
$$;

revoke execute on function public.claim_deferred_setup_trigger_args(uuid, uuid[]) from public, authenticated;
grant  execute on function public.claim_deferred_setup_trigger_args(uuid, uuid[]) to service_role;

comment on function public.claim_deferred_setup_trigger_args(uuid, uuid[]) is
  'Atomically claim and clear pending_setup_trigger_args for OLIs on the given orders. Uses SELECT FOR UPDATE so concurrent callers cannot both fire the deferred setup-work-order trigger for the same OLI. Returns one row per claimed OLI with the OLD args value. Service-role only.';
