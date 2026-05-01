-- 00245_bundle_visibility_parity_with_ts.sql
--
-- Bring public.bundle_is_visible_to_user() into parity with
-- BundleVisibilityService.assertVisible (apps/api/src/modules/booking-bundles/
-- bundle-visibility.service.ts). The TS service is canonical and grants
-- two paths the SQL helper does NOT:
--
--   1. Approver path: a user with any approvals row pointing at this bundle
--      (TS bundle-visibility.service.ts:113-124, no status filter).
--   2. Work-order assignee path: a user whose user_id is the assigned_user_id
--      on a work_order linked to the bundle (TS lines 126-140, no status
--      filter, user-only — NOT team membership).
--
-- The SQL helper has zero call sites in the SQL layer today (no RLS policy,
-- view, trigger, or RPC invokes it). The visibility logic is enforced
-- exclusively by the TS service. So this migration does NOT fix a live
-- access-control bug — it brings the documented "canonical fallback"
-- function into parity so that future RLS policies / view predicates / a
-- future bundle_visible_ids RPC will not silently under-grant.
--
-- One defensive improvement over TS: the approvals EXISTS clause filters
-- target_entity_type = 'booking_bundle'. The TS service joins on UUID
-- equality alone; UUID collisions across entity types are vanishingly
-- unlikely but the type discriminator costs nothing and is correctness.
-- TS should be updated to match (separate task — flagged in handoff).
--
-- Open questions deliberately NOT addressed here (same in TS today):
--   - Should approver visibility expire when approval status moves to
--     'approved' / 'rejected' / 'expired'? Currently no.
--   - Should WO-assignee visibility expire when the work order closes?
--     Currently no.
-- Both are policy questions, not schema questions. Match TS exactly to
-- avoid introducing a new divergence in the opposite direction.
--
-- Signature is unchanged. No view / RLS / function depends on the prior
-- body, so plain CREATE OR REPLACE suffices (no DROP needed).

create or replace function public.bundle_is_visible_to_user(
  p_bundle_id uuid,
  p_user_id uuid,
  p_tenant_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_visible boolean;
  v_person_id uuid;
begin
  select person_id into v_person_id
  from public.users
  where id = p_user_id and tenant_id = p_tenant_id;

  select exists (
    select 1 from public.booking_bundles b
    where b.id = p_bundle_id
      and b.tenant_id = p_tenant_id
      and (
        -- Participant: requester / host
        (v_person_id is not null
         and (b.requester_person_id = v_person_id or b.host_person_id = v_person_id))

        -- Operator / admin via permissions
        or public.user_has_permission(p_user_id, p_tenant_id, 'rooms.read_all')
        or public.user_has_permission(p_user_id, p_tenant_id, 'rooms.admin')

        -- Approver: any approvals row pointing at this bundle. Mirrors
        -- bundle-visibility.service.ts:113-124. Defensive deviation from TS:
        -- target_entity_type='booking_bundle' filter. No status filter
        -- (TS doesn't filter either — covers historical approvers).
        or (v_person_id is not null and exists (
          select 1
            from public.approvals a
           where a.tenant_id = p_tenant_id
             and a.target_entity_id = p_bundle_id
             and a.target_entity_type = 'booking_bundle'
             and a.approver_person_id = v_person_id
        ))

        -- Work-order assignee: user assigned directly (NOT via team) to a
        -- work order linked to the bundle. Mirrors bundle-visibility
        -- .service.ts:126-140. work_orders is a real BASE TABLE post-1c.10c
        -- (CI assertion A3 enforces this). User-only by design — TS does
        -- NOT grant via team membership and neither do we.
        or exists (
          select 1
            from public.work_orders wo
           where wo.tenant_id = p_tenant_id
             and wo.booking_bundle_id = p_bundle_id
             and wo.assigned_user_id = p_user_id
        )
      )
  ) into v_visible;
  return coalesce(v_visible, false);
end;
$$;

grant execute on function public.bundle_is_visible_to_user(uuid, uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
