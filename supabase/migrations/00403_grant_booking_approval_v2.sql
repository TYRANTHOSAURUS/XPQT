-- Phase 1.5 — Visual approval workflow — sub-step 6.C.
-- Supersedes `public.grant_booking_approval` (00310) with chain_threshold-
-- aware resolve semantics + a per-booking ROW lock at the top of the body
-- (BLOCKER 2 closure) + an outbox.emit('approval.granted') signal on
-- kind='resolved' so WorkflowApprovalGrantedHandler (sub-step 6.D) can
-- resume() the parent workflow_instance.
--
-- Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
--   §2.6 (lines ~438-697) — the approval-grant signal + lock topology.
--   §6.C (lines ~1240-1273) — sub-step spec.
--   §1.9 (lines ~271-287) — 00310 lock topology + BLOCKER 2 verification.
--
-- Closures:
--   BLOCKER 2 — chain_threshold='any' double-resolve race. The pre-Phase-1.5
--     00310 RPC takes a per-approval advisory lock + per-booking advisory
--     lock AFTER the self-CAS. Two approvers grant 'approved' on different
--     sibling rows of the same chain_threshold='any' chain → both observe
--     the OTHER as still pending (the per-approval advisory locks are
--     different keys; the per-booking lock is post-CAS so doesn't help
--     pre-CAS observation) → both commit CAS, both expire-siblings,
--     both emit approval.granted. Double-emit.
--   Closure: acquire `SELECT id FROM public.bookings WHERE id=v_target_id
--     AND tenant_id=p_tenant_id FOR UPDATE` at the TOP of the body, BEFORE
--     the per-approval advisory lock. The booking-level row lock serialises
--     ALL contenders through one observation point. Under that lock, re-read
--     sibling state: if `chain_threshold='any'` AND an `approved` sibling
--     already exists, this row's grant is the LOSER — CAS self → 'approved'
--     for audit but RETURN kind='already_resolved' without expiring siblings
--     and without emitting approval.granted. The original winner already
--     did all of it.
--
-- Schema preconditions (from migration 00400):
--   approvals.chain_threshold      text NOT NULL DEFAULT 'all'
--                                  CHECK (chain_threshold IN ('all','any'))
--   approvals.workflow_instance_id uuid NULL REFERENCES workflow_instances
--   approvals.workflow_node_id     text NULL
--
-- Error codes (registered out-of-band by sub-step 6.A and the migration
--  itself doesn't throw via AppError — TS callers map P0001/P0002 to the
--  right code in the existing approval.service.ts error-mapping layer):
--   chain.threshold_invalid (422)        — defensive raise if a row's
--     chain_threshold somehow falls outside the CHECK set; should never
--     fire in production.
--
-- Companion: WorkflowApprovalGrantedHandler (sub-step 6.D) subscribes to
-- `approval.granted` on the outbox and calls
-- WorkflowEngineService.resume(workflow_instance_id, tenant_id, decision)
-- — the resume() atomic claim handles idempotency for concurrent emits.
--
-- Backward compat: callers that haven't migrated to chain_threshold see
-- 'all' (the column default) and the resolve semantics match 00310's
-- behaviour — count siblings, transition iff all done.

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
  v_approval              record;
  v_lock_key              bigint;
  v_target_id             uuid;
  v_chain_threshold       text;
  v_workflow_instance_id  uuid;
  v_workflow_node_id      text;
  v_approval_chain_id     uuid;
  v_approved_siblings_in_chain int := 0;
  v_new_status            text;
  v_unresolved_count      int;
  v_slot_count            int;
  v_pending_count         int;
  v_booking_changed       boolean := false;
  v_emit_summary          jsonb;
  v_result                jsonb;
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

  -- ── 0. Snapshot read of the approval row WITHOUT a lock. Plan §6.C step 0.
  -- Needed because the per-booking row lock at step 2 requires v_target_id,
  -- but we can't lock the booking row before knowing which booking the
  -- approval points at. This read is NON-MUTATING — if the row vanishes
  -- between this read and the FOR UPDATE at step 4, the CAS at step 5
  -- catches it (status check fails) and returns 'already_responded' cleanly.
  select id, target_entity_type, target_entity_id, parallel_group,
         approval_chain_id, comments, status, chain_threshold,
         workflow_instance_id, workflow_node_id
    into v_approval
    from public.approvals
   where id        = p_approval_id
     and tenant_id = p_tenant_id;

  if not found then
    raise exception 'approval.not_found id=% tenant=%', p_approval_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- Validate target_entity_type early — non-booking branches return cleanly
  -- without acquiring any locks or mutating any rows. Mirrors 00310 v8.1-I2.
  if v_approval.target_entity_type <> 'booking' then
    return jsonb_build_object(
      'kind',                'non_booking_approved',
      'approval_id',         p_approval_id,
      'target_entity_type',  v_approval.target_entity_type
    );
  end if;

  -- Validate state machine — idempotent retry on an already-responded row.
  if v_approval.status <> 'pending' then
    return jsonb_build_object(
      'kind',         'already_responded',
      'approval_id',  p_approval_id,
      'prior_status', v_approval.status
    );
  end if;

  v_target_id             := v_approval.target_entity_id;
  v_chain_threshold       := v_approval.chain_threshold;
  v_workflow_instance_id  := v_approval.workflow_instance_id;
  v_workflow_node_id      := v_approval.workflow_node_id;
  v_approval_chain_id     := v_approval.approval_chain_id;

  -- Defensive guard — the chain_threshold CHECK at 00400 block A enforces
  -- ('all','any'); a value outside the set means schema corruption.
  if v_chain_threshold not in ('all', 'any') then
    raise exception 'chain.threshold_invalid: approval=% has chain_threshold=%',
      p_approval_id, v_chain_threshold
      using errcode = 'P0001';
  end if;

  -- ── 1. Per-approval advisory lock — serialise concurrent grants on the
  -- SAME approval row. Different keys per approval; concurrent grants on
  -- DIFFERENT sibling rows of the same chain do NOT serialise here — they
  -- serialise on the per-booking ROW lock at step 2.
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':approval:' || p_approval_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. PER-BOOKING ROW LOCK (BLOCKER 2 closure). Serialises ALL
  -- contenders through one observation point — regardless of which approval
  -- row of the chain they're granting.
  --
  -- The 00310 RPC's per-booking advisory lock was acquired AFTER the
  -- self-CAS, which meant two approvers on a chain_threshold='any' chain
  -- could both CAS their own row before either took the booking lock — and
  -- when they did, neither saw the OTHER's CAS because of snapshot isolation
  -- pre-lock. Both then ran the resolve path. Double-emit, double-transition.
  --
  -- The fix: acquire `FOR UPDATE` on the bookings row BEFORE the self-CAS,
  -- AFTER the per-approval lock. Concurrent approvers from different chain
  -- rows now queue at the bookings row lock and observe each other's CAS
  -- updates under that lock.
  perform 1
    from public.bookings b
   where b.id        = v_target_id
     and b.tenant_id = p_tenant_id
   for update;

  -- ── 3. Re-observe sibling state UNDER the booking row lock. If
  -- chain_threshold='any' and at least one sibling is already 'approved',
  -- this row is the LOSER of the race — CAS self for audit but skip the
  -- resolve path entirely.
  if v_approval_chain_id is not null then
    select count(*) filter (where status = 'approved')
      into v_approved_siblings_in_chain
      from public.approvals
     where tenant_id         = p_tenant_id
       and approval_chain_id = v_approval_chain_id
       and id != p_approval_id;
  end if;

  -- ── 4. FOR UPDATE re-read of THIS approval row. The per-approval
  -- advisory lock + per-booking row lock above already serialise; this is
  -- the standard pre-CAS lock+validate that 00310 v8.1-I2 introduced.
  select id, target_entity_type, target_entity_id, parallel_group,
         approval_chain_id, comments, status, chain_threshold
    into v_approval
    from public.approvals
   where id        = p_approval_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    -- Vanished between step 0 and now — shouldn't be reachable under the
    -- advisory lock + booking row lock, but defensive.
    raise exception 'approval.not_found id=% tenant=% (mid-tx)', p_approval_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- Re-validate state — could have been responded to by a concurrent
  -- transaction that completed before our locks fired (unlikely under
  -- advisory + row locks but the CAS-with-status-guard is the canonical
  -- belt-and-suspenders).
  if v_approval.status <> 'pending' then
    return jsonb_build_object(
      'kind',         'already_responded',
      'approval_id',  p_approval_id,
      'prior_status', v_approval.status
    );
  end if;

  -- ── 5. CAS update on the self approval row. After step 4's FOR UPDATE +
  -- the locks above, this CAS is defensive — a status='pending' miss here
  -- would be a bug, not a race.
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
            hint = 'CAS update missed despite advisory + row locks — investigate concurrent path';
  end if;

  -- ── 6. NEW v4: chain_threshold='any' + sibling-already-approved
  -- short-circuit. The original winner already expired siblings, transitioned
  -- the booking, and emitted approval.granted. Our role is to CAS self
  -- (above) for audit + return kind='already_resolved' without re-doing any
  -- of the resolve work.
  --
  -- This branch ONLY fires for chain_threshold='any' chains. 'all' chains
  -- require every sibling to commit before resolving (existing 00310 logic
  -- at step 7 below). 'rejected' decisions skip this branch entirely
  -- (existing 00310 rejection path applies regardless of threshold).
  if v_chain_threshold = 'any'
     and p_decision = 'approved'
     and v_approved_siblings_in_chain > 0 then
    return jsonb_build_object(
      'kind',                  'already_resolved',
      'approval_id',           p_approval_id,
      'booking_id',            v_target_id,
      'approval_chain_id',     v_approval_chain_id,
      'approved_siblings_ct',  v_approved_siblings_in_chain
    );
  end if;

  -- ── 7. Resolve booking-level decision. Same logic as 00310 for the
  -- 'all'-threshold + rejection paths; the 'any' + first-to-approve path
  -- expires ALL pending siblings explicitly (in addition to the existing
  -- rejection expiry).
  if p_decision = 'rejected' then
    v_new_status := 'cancelled';

    -- Expire sibling pending approvals (mirrors 00310 :161-172).
    update public.approvals
       set status        = 'expired',
           responded_at  = now(),
           comments      = 'Sibling approval rejected; bundle no longer needs approval.'
     where tenant_id        = p_tenant_id
       and target_entity_id = v_target_id
       and status           = 'pending';
  elsif v_chain_threshold = 'any' then
    -- NEW v4: this row is the first 'approved' on a chain_threshold='any'
    -- chain. Expire ALL pending siblings explicitly — the threshold is
    -- satisfied by this single approval; they no longer need to respond.
    v_new_status := 'confirmed';

    update public.approvals
       set status        = 'expired',
           responded_at  = now(),
           comments      = 'Sibling approved (any-of-N); chain resolved.'
     where tenant_id         = p_tenant_id
       and approval_chain_id = v_approval_chain_id
       and id               != p_approval_id
       and status            = 'pending';
  else
    -- chain_threshold='all' + p_decision='approved'. Existing 00310 logic:
    -- count siblings; if any pending/rejected remain, partial_approved.
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

  -- ── 8. Transition booking_slots + bookings (mirrors 00310 :176-194).
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

  -- ── 9. Setup-WO emit on approval (mirrors 00310 :197-214).
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

  -- ── 10. Domain event for the approval decision (existing 00310 :217-231).
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

  -- ── 11. NEW v4: outbox.emit('approval.granted', ...) ONLY on kind=
  -- 'resolved'. WorkflowApprovalGrantedHandler (6.D) subscribes and calls
  -- WorkflowEngineService.resume(v_workflow_instance_id, tenant_id, decision)
  -- — the resume() atomic claim handles idempotency for concurrent emits.
  --
  -- workflow_instance_id is NULLABLE on approvals (legacy rows without a
  -- workflow_instance_id field — pre-Phase-1.5 createApprovalRows path).
  -- When NULL, we skip the outbox emit; legacy approvals fall back to the
  -- existing TS-side `onApprovalDecided` fan-out at approval.service.ts:847.
  if v_workflow_instance_id is not null then
    perform outbox.emit(
      'approval.granted',
      jsonb_build_object(
        'tenant_id',            p_tenant_id,
        'approval_id',          p_approval_id,
        'booking_id',           v_target_id,
        'final_decision',       p_decision,
        'workflow_instance_id', v_workflow_instance_id,
        'workflow_node_id',     v_workflow_node_id
      )
    );
  end if;

  v_result := jsonb_build_object(
    'kind',                 'resolved',
    'approval_id',          p_approval_id,
    'booking_id',           v_target_id,
    'final_decision',       p_decision,
    'new_status',           v_new_status,
    'slots_transitioned',   v_slot_count,
    'booking_transitioned', v_booking_changed,
    'setup_emit',           v_emit_summary,
    'workflow_emit',        v_workflow_instance_id is not null
  );

  return v_result;
end;
$$;

revoke execute on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) from public;
grant  execute on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) to service_role;

comment on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) is
  'Phase 1.5 v2 supersedes 00310: per-booking ROW lock at top of body
   (BLOCKER 2 closure for chain_threshold=any double-resolve race), branches
   on chain_threshold for ''any''-of-N resolve semantics, emits
   outbox.approval.granted on kind=resolved when workflow_instance_id is
   populated. Backward-compatible: NULL workflow_instance_id (legacy rows)
   skips the outbox emit; chain_threshold defaults to ''all'' so pre-Phase-1.5
   chains keep current semantics.';

notify pgrst, 'reload schema';
