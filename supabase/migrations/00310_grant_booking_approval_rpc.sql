-- B.0.B.2 — grant_booking_approval RPC.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §10.1 (NEW
-- in v7 — folds C2; v8.1 reorders lock+validate before CAS via I2).
--
-- Atomic approval grant for booking targets. One transaction for the approval
-- CAS update + booking_slots transition + bookings transition + sibling-
-- approval expiry-on-rejection + setup-WO outbox emit (or pending_setup_args
-- clear on rejection). Replaces the v6 lie of "five separate HTTP calls but
-- the throws bubble" (approval.service.ts:359-487 — five separate txs, none
-- of which roll the others back).
--
-- Notification fan-out + visitor-invite dispatch + ticket dispatch stay in
-- TS, fired AFTER the RPC commits — those are genuinely best-effort by
-- design (a vendor email outage shouldn't roll the approval back; the user
-- already saw the success in their queue). See spec §10.1 last paragraph
-- ("Notifications stay in TS — explicitly").
--
-- v8.1-I2 ordering fix: SELECT FOR UPDATE + validate target_entity_type +
-- validate state machine BEFORE the CAS UPDATE. v7 ran the CAS first, so a
-- mistaken caller passing a ticket/visitor_invite approval id would mark the
-- row 'approved' before the rejection. v8.1 bails out cleanly for non-
-- booking branches (returns kind=non_booking_approved) without mutating.
--
-- Inputs:
--   p_approval_id     — approval to grant.
--   p_tenant_id       — tenant scope (must match approval row).
--   p_actor_user_id   — for audit.
--   p_decision        — 'approved' | 'rejected'.
--   p_comments        — optional reviewer comment, persisted on the approval.
--   p_idempotency_key — caller-provided (X-Client-Request-Id-derived); used
--                        for the per-grant advisory lock + as the
--                        approve_booking_setup_trigger key.
--
-- Outputs (jsonb):
--   { kind: 'non_booking_approved' | 'already_responded' | 'partial_approved'
--           | 'resolved',
--     ...kind-specific fields }
--
-- Locking (§10.1 steps 1 + 4):
--   1. Per-approval advisory lock (tenant + ':approval:' + approval_id) so
--      concurrent grants on the SAME row serialise.
--   2. Per-booking advisory lock (tenant + ':booking_approval:' + booking_id)
--      taken AFTER the CAS update succeeds, so concurrent approvers grant
--      in series at the booking level (slot transitions don't race).
--
-- SECURITY INVOKER, service-role grant only. The TS caller
-- (ApprovalService.respond, B.0.D) authorises the user before invoking.

create or replace function public.grant_booking_approval(
  p_approval_id     uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_decision        text,
  p_comments        text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_approval         record;
  v_lock_key         bigint;
  v_target_id        uuid;
  v_new_status       text;             -- 'confirmed' | 'cancelled'
  v_unresolved_count int;
  v_slot_count       int;
  v_pending_count    int;
  v_booking_changed  boolean := false;
  v_emit_summary     jsonb;
  v_result           jsonb;
begin
  if p_tenant_id is null then
    raise exception 'grant_booking_approval: p_tenant_id required';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'grant_booking_approval: p_decision must be approved or rejected'
      using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'grant_booking_approval: p_idempotency_key required'
      using errcode = 'P0001';
  end if;

  -- ── 1. Per-approval advisory lock — serialise concurrent grants on the
  -- SAME approval row. Concurrent grants on DIFFERENT approval rows for the
  -- same booking serialise on the per-booking lock taken below.
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':approval:' || p_approval_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. Lock + read FIRST (v8.1-I2). Validate row existence,
  -- target_entity_type, and state machine BEFORE any mutation. The advisory
  -- lock above already serialises on the same row; the FOR UPDATE here gives
  -- us a full row to read and validate.
  select id, target_entity_type, target_entity_id, parallel_group,
         approval_chain_id, comments, status
    into v_approval
    from public.approvals
   where id        = p_approval_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'approval.not_found id=% tenant=%', p_approval_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- v8.1-I2: validate target_entity_type BEFORE any mutation. Bail out cleanly
  -- for non-booking branches; the caller routes those through the existing
  -- TS-orchestrated paths (see spec §11 open question 8).
  if v_approval.target_entity_type <> 'booking' then
    return jsonb_build_object(
      'kind',                'non_booking_approved',
      'approval_id',         p_approval_id,
      'target_entity_type',  v_approval.target_entity_type
    );
  end if;

  -- Validate state machine. If already responded (idempotent retry by the
  -- same caller, or a different caller's decision committed between the
  -- TS-side .single() read and this RPC), return cleanly.
  if v_approval.status <> 'pending' then
    return jsonb_build_object(
      'kind',         'already_responded',
      'approval_id',  p_approval_id,
      'prior_status', v_approval.status
    );
  end if;

  -- ── 3. NOW apply the CAS update. The advisory lock + FOR UPDATE above
  -- mean no concurrent grant can interleave between the validation and the
  -- mutation, so the CAS guard is defensive (a 'not found' here would be a
  -- bug, not a race).
  update public.approvals
     set status        = p_decision,
         responded_at  = now(),
         comments      = p_comments
   where id            = p_approval_id
     and tenant_id     = p_tenant_id
     and status        = 'pending';

  if not found then
    raise exception 'approval.cas_lost id=%', p_approval_id
      using errcode = 'P0001',
            hint = 'CAS update missed despite advisory lock + FOR UPDATE — investigate concurrent path';
  end if;

  v_target_id := v_approval.target_entity_id;

  -- ── 4. Per-booking advisory lock so concurrent approvers grant in series
  -- at the booking level (slot transitions + bundle cascade don't race).
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':booking_approval:' || v_target_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 5. Resolve booking-level decision. Same logic as
  -- ApprovalService.areAllTargetApprovalsApproved (approval.service.ts:645).
  if p_decision = 'rejected' then
    v_new_status := 'cancelled';

    -- Expire sibling pending approvals (mirrors bundle.service.ts:1428-1444).
    update public.approvals
       set status        = 'expired',
           responded_at  = now(),
           comments      = 'Sibling approval rejected; bundle no longer needs approval.'
     where tenant_id        = p_tenant_id
       and target_entity_id = v_target_id
       and status           = 'pending';
  else
    -- p_decision = 'approved'. Check siblings.
    select count(*) filter (where status in ('pending', 'rejected'))
      into v_unresolved_count
      from public.approvals
     where tenant_id        = p_tenant_id
       and target_entity_id = v_target_id;
    if v_unresolved_count > 0 then
      return jsonb_build_object(
        'kind',         'partial_approved',
        'approval_id',  p_approval_id,
        'remaining',    v_unresolved_count
      );
    end if;
    v_new_status := 'confirmed';
  end if;

  -- ── 6. Transition booking_slots + bookings (mirrors approval.service.ts
  -- :551-579). All in same tx now.
  update public.booking_slots
     set status = v_new_status,
         cancellation_grace_until = case when v_new_status = 'cancelled' then null
                                         else cancellation_grace_until end
   where booking_id = v_target_id
     and tenant_id  = p_tenant_id
     and status     = 'pending_approval';
  get diagnostics v_slot_count = row_count;

  update public.bookings
     set status = v_new_status
   where id        = v_target_id
     and tenant_id = p_tenant_id
     and status    = 'pending_approval';
  get diagnostics v_pending_count = row_count;
  v_booking_changed := v_pending_count > 0;

  -- ── 7. Setup-WO emit on approval. Inline-call the §7.9 RPC via SELECT —
  -- one tx, no separate round trip. The standalone approve_booking_setup_trigger
  -- RPC stays callable for admin/batch tooling. On rejection, clear
  -- pending_setup_trigger_args without emitting.
  if v_new_status = 'confirmed' then
    select public.approve_booking_setup_trigger(
      v_target_id, p_tenant_id, p_actor_user_id, p_idempotency_key
    ) into v_emit_summary;
  else
    update public.order_line_items oli
       set pending_setup_trigger_args = null
      from public.orders o
     where o.id = oli.order_id
       and o.booking_id = v_target_id
       and oli.tenant_id = p_tenant_id
       and oli.pending_setup_trigger_args is not null;
    v_emit_summary := jsonb_build_object('emitted_count', 0, 'reason', 'rejected');
  end if;

  -- ── 8. Domain event for the approval decision (mirrors
  -- ApprovalService.logDomainEvent at approval.service.ts:707).
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  ) values (
    p_tenant_id,
    'approval_' || p_decision,
    'approval',
    v_target_id,
    jsonb_build_object(
      'approval_id',     p_approval_id,
      'responded_by',    p_actor_user_id,
      'idempotency_key', p_idempotency_key
    )
  );

  v_result := jsonb_build_object(
    'kind',                 'resolved',
    'approval_id',          p_approval_id,
    'booking_id',           v_target_id,
    'final_decision',       p_decision,
    'new_status',           v_new_status,
    'slots_transitioned',   v_slot_count,
    'booking_transitioned', v_booking_changed,
    'setup_emit',           v_emit_summary
  );

  return v_result;
end;
$$;

revoke execute on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) from public;
grant  execute on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) to service_role;

comment on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) is
  'Atomic approval grant for booking targets. CAS update on approvals + transition booking_slots + bookings + emit setup_work_order outbox events (or clear pending_setup_trigger_args on rejection) — all in one transaction. Folds v7-C2 + v8.1-I2 of the outbox spec (§10.1). Expires sibling pending approvals on rejection (mirroring bundle.service.ts:1428-1444). Notifications + visitor-invite + ticket dispatch are NOT in this RPC — they stay in TS, fired post-RPC, because they are genuinely best-effort.';

notify pgrst, 'reload schema';
