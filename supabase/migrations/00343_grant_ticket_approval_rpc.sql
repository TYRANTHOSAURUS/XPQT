-- B.2.A.Step10 — grant_ticket_approval RPC.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.5 (lines 2238-2326).
-- Replaces: §1.3 (TicketService.onApprovalDecision, ticket.service.ts:705-752)
--           + §1.19 (ApprovalService.respond ticket branch, approval.service.ts:486-561).
-- Sibling reference: supabase/migrations/00310_grant_booking_approval_rpc.sql
--   (booking-target mirror; same advisory-lock + FOR UPDATE-before-CAS
--   v8.1-I2 ordering).
--
-- ── Why this RPC ───────────────────────────────────────────────────────
--
-- The ticket-target approval branch today does:
--   1. SELECT approval (TS, separate tx)
--   2. UPDATE approval CAS (TS, separate tx)
--   3. INSERT domain_events (TS, separate tx)
--   4. UPDATE tickets status / status_category / closed_at (TS, sep. tx)
--   5. INSERT ticket_activities (TS, separate tx)
--   6. *(approve only)* re-load + run post-create automation (routing,
--      SLA, workflow) — each a separate tx.
--
-- If any step fails mid-sequence the approval is decided but the ticket
-- remains in `pending_approval`. Critical severity per §1.3 + §1.19.
-- This RPC collapses steps 1-5 + the post-create automation EMITS into
-- one Postgres transaction. The actual SLA timer start / routing
-- evaluation / workflow start are deferred to outbox handlers
-- (SlaTimerHandler / RoutingEvaluationHandler / WorkflowStartHandler per
-- §3.9.3) so the RPC stays small and only writes the entity + activity
-- + domain_event rows. Handler-contract uniformity v4 / I3.
--
-- ── Outbox-handler caveat ──────────────────────────────────────────────
--
-- §3.9.3 names the three handlers (SlaTimerHandler, RoutingEvaluationHandler,
-- WorkflowStartHandler) as the consumers of the events this RPC emits.
-- As of this migration, NONE of those handlers exist yet (only
-- SetupWorkOrderHandler is registered — see
-- apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts:50).
-- The emits are still correct to ship NOW because:
--   (a) The same pre-existing pattern is already in production via 00323
--       (transition_entity_status emits sla.timer_recompute_required) and
--       00325 (v2 same), with no handler registered. The outbox worker
--       dead-letters these events after retry exhaustion (apps/api/src/
--       modules/outbox/outbox.worker.ts:200-207, reason='no_handler_registered').
--   (b) The transactional boundary collapse is the headline fix; handler
--       wiring is a follow-up step that doesn't change this RPC's
--       contract.
-- This is surfaced explicitly in the Step 10 deliverable as a known gap.
-- Once §3.9.3 handlers ship, no change is required here — the events
-- already carry the right payload shape per §3.9.3 table.
--
-- ── Outcomes ───────────────────────────────────────────────────────────
--
-- Returns jsonb with `kind`:
--   - 'non_ticket_approved'  → defensive (caller routed a non-ticket
--                              approval to this RPC). Mirrors v8.1-I2
--                              of 00310.
--   - 'already_responded'    → race: another caller decided between TS
--                              read + this RPC's lock. Returns the prior
--                              status. No state changes.
--   - 'partial_approved'     → multi-step / parallel chain where peer
--                              approvals remain pending. CAS committed
--                              on this row; ticket stays in
--                              pending_approval; NO automation fires.
--   - 'resolved'             → final decision committed. Ticket flipped
--                              to (status='new', status_category='new')
--                              for approve OR (status='rejected',
--                              status_category='closed', closed_at=now())
--                              for reject. On approve, three outbox
--                              events emitted (sla / routing / workflow
--                              — each conditional on ticket carrying the
--                              relevant FK).
--
-- ── Locking + idempotency ──────────────────────────────────────────────
--
-- 1. Per-approval advisory lock keyed on
--    `hashtextextended(tenant || ':approval:' || approval_id, 0)` so
--    concurrent grants on the SAME approval row serialise. Mirrors 00310
--    step 1.
-- 2. command_operations gate keyed on (tenant_id, p_idempotency_key);
--    same-key + same-payload returns cached_result; same-key +
--    different-payload raises command_operations.payload_mismatch.
-- 3. FOR UPDATE on the approval row before CAS (v8.1-I2 ordering) —
--    state-machine validation runs BEFORE the mutation so a mistaken
--    caller passing a non-ticket approval id bails cleanly without
--    flipping the row.
--
-- ── Security ───────────────────────────────────────────────────────────
--
-- SECURITY INVOKER, service-role grant only. The TS caller
-- (ApprovalService.respond) authorises the user (callerCanRespond) before
-- invoking. Tenant policy on command_operations + approvals + tickets
-- gates RLS at the row level.
--
-- ── Citations ──────────────────────────────────────────────────────────
--   - 00012_approvals.sql:14 — status enum ('pending','approved',
--     'rejected','delegated','expired').
--   - 00011_tickets.sql:11 — status_category enum (includes
--     'pending_approval','closed','new').
--   - 00310_grant_booking_approval_rpc.sql:86-148 — advisory lock +
--     FOR UPDATE + state-machine guard ordering this RPC mirrors.
--   - 00316_command_operations_table.sql:32-42 — idempotency table schema.
--   - 00325_transition_entity_status_v2.sql:288-313 —
--     sla.timer_recompute_required emit pattern.
--   - apps/api/src/modules/ticket/ticket.service.ts:705-752 — TS branch
--     this RPC replaces.
--   - apps/api/src/modules/approval/approval.service.ts:486-561 — TS
--     respond() ticket branch this RPC replaces.

create or replace function public.grant_ticket_approval(
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
  v_existing               public.command_operations;
  v_payload_hash           text;
  v_lock_key               bigint;
  v_approval               record;
  v_ticket                 record;
  v_target_id              uuid;
  v_unresolved_count       int;
  v_actor_person_id        uuid;
  v_payload                jsonb;
  v_sla_emitted            boolean := false;
  v_workflow_emitted       boolean := false;
  v_routing_emitted        boolean := false;
  v_ticket_status          text;
  v_ticket_status_category text;
  v_result                 jsonb;
begin
  -- ── 0. Argument shape checks (mirror 00310:74-84 + 00325:74-87) ──────
  if p_tenant_id is null then
    raise exception 'grant_ticket_approval: p_tenant_id required';
  end if;
  if p_approval_id is null then
    raise exception 'grant_ticket_approval: p_approval_id required';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'grant_ticket_approval.invalid_response: p_decision must be approved or rejected'
      using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'grant_ticket_approval: p_idempotency_key required'
      using errcode = 'P0001';
  end if;

  -- ── 1. Per-approval advisory lock (mirror 00310:89-92) ──────────────
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':approval:' || p_approval_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. command_operations idempotency gate (mirror 00325:100-124) ───
  v_payload_hash := md5(coalesce(
    jsonb_build_object(
      'approval_id', p_approval_id,
      'tenant_id',   p_tenant_id,
      'decision',    p_decision,
      'comments',    p_comments
    )::text,
    ''
  ));

  select * into v_existing
    from public.command_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash <> v_payload_hash then
      raise exception 'command_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload';
    else
      raise exception 'command_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.command_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 3. Lock + read approval row (mirror 00310:98-108, v8.1-I2 order) ─
  select id, target_entity_type, target_entity_id, parallel_group,
         approval_chain_id, status
    into v_approval
    from public.approvals
   where id        = p_approval_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'grant_ticket_approval.approval_not_found: id=% tenant=%',
      p_approval_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 4. Target entity type guard (mirror 00310:114-120) ──────────────
  -- v8.1-I2: validate target_entity_type BEFORE any mutation. Bail out
  -- cleanly for non-ticket targets; the caller routes those through
  -- their own dispatcher (grant_booking_approval / TS visitor branch).
  if v_approval.target_entity_type <> 'ticket' then
    v_result := jsonb_build_object(
      'kind',               'non_ticket_approved',
      'approval_id',        p_approval_id,
      'target_entity_type', v_approval.target_entity_type
    );
    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return v_result;
  end if;

  v_target_id := v_approval.target_entity_id;

  -- ── 5. State-machine guard — already responded ──────────────────────
  if v_approval.status <> 'pending' then
    v_result := jsonb_build_object(
      'kind',         'already_responded',
      'approval_id',  p_approval_id,
      'ticket_id',    v_target_id,
      'prior_status', v_approval.status
    );
    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return v_result;
  end if;

  -- ── 6. CAS update on approvals row (mirror 00310:137-149) ───────────
  update public.approvals
     set status        = p_decision,
         responded_at  = now(),
         comments      = p_comments
   where id            = p_approval_id
     and tenant_id     = p_tenant_id
     and status        = 'pending';

  if not found then
    raise exception 'grant_ticket_approval.cas_lost: id=%', p_approval_id
      using errcode = 'P0001',
            hint = 'CAS update missed despite advisory lock + FOR UPDATE — investigate concurrent path';
  end if;

  -- ── 7. Chain / parallel-group resolution check (approve branch only) ─
  -- Mirrors §1.19's advanceChain + ApprovalService.isParallelGroupComplete
  -- semantics (approval.service.ts:751-777) but evaluated in one
  -- atomic step in SQL. Spec §3.5 step 7.
  --
  -- Pre-CAS we already know:
  --   * The current row has just transitioned pending → p_decision.
  --   * v_approval.parallel_group / v_approval.approval_chain_id come from
  --     the pre-CAS read.
  --
  -- For rejection: a single rejected step terminates the chain/group
  -- (spec line 2256-2257). We always proceed to flip the ticket to
  -- closed. For approval: if ANY peer in the same chain/group is still
  -- non-terminal (status='pending' or 'delegated' — see §3.10 step 3
  -- enum analysis), this is a 'partial_approved' outcome; ticket stays
  -- in pending_approval and no automation fires.
  if p_decision = 'approved'
     and (v_approval.approval_chain_id is not null or v_approval.parallel_group is not null)
  then
    select count(*)
      into v_unresolved_count
      from public.approvals
     where tenant_id        = p_tenant_id
       and target_entity_id = v_target_id
       and target_entity_type = 'ticket'
       and (
         (v_approval.approval_chain_id is not null
          and approval_chain_id = v_approval.approval_chain_id)
         or
         (v_approval.parallel_group is not null
          and parallel_group = v_approval.parallel_group)
       )
       and status in ('pending', 'delegated');

    if v_unresolved_count > 0 then
      -- Record a domain_events row so the partial decision is auditable
      -- even though the ticket doesn't move. Mirrors the TS-side
      -- logDomainEvent emission at approval.service.ts:503-506.
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
          'idempotency_key', p_idempotency_key,
          'partial',         true,
          'remaining',       v_unresolved_count
        )
      );

      v_result := jsonb_build_object(
        'kind',                    'partial_approved',
        'approval_id',             p_approval_id,
        'ticket_id',               v_target_id,
        'ticket_status',           null,
        'ticket_status_category',  'pending_approval',
        'sla_started',             false,
        'workflow_started',        false,
        'routing_evaluation_emitted', false,
        'remaining',               v_unresolved_count
      );

      update public.command_operations
         set outcome = 'success', cached_result = v_result, completed_at = now()
       where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
      return v_result;
    end if;
  end if;

  -- ── 8. Lock the target ticket row (FOR UPDATE, full projection) ─────
  -- Spec line 2266-2272: read effective workflow_id / sla_id / location_id /
  -- asset_id / created_at off the TICKET row, not request_types defaults.
  -- The ticket carries the effective values committed at create time by
  -- §3.11. Reading request_types here would silently start the wrong
  -- policy on scope-overridden tickets (v7 / C1 bug fix).
  select id, tenant_id, ticket_type_id, workflow_id, sla_id,
         location_id, asset_id, created_at, status, status_category
    into v_ticket
    from public.tickets
   where id        = v_target_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    -- Defense-in-depth: the approvals FK doesn't constrain target_entity_id
    -- to tickets, but in practice a ticket-approval row always references
    -- a real ticket. Hard-delete after the approval insert is the only
    -- way this fires.
    raise exception 'grant_ticket_approval.ticket_not_found: ticket=% tenant=%',
      v_target_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 9. Apply ticket state transition ────────────────────────────────
  -- Mirrors apps/api/src/modules/ticket/ticket.service.ts:715-733 — the
  -- branch on outcome flips status + status_category + closed_at.
  --
  -- We unconditionally apply the UPDATE even if the ticket's current
  -- status_category is already terminal (closed/resolved). The TS code at
  -- ticket.service.ts:708 has an early-return guard against
  -- `status_category !== 'pending_approval'` — i.e. it skips automation
  -- when the ticket has moved out of pending_approval already (e.g. the
  -- ticket was manually closed between approval-create and approval-grant).
  -- We preserve that by NOT firing automation when the ticket is no
  -- longer in pending_approval — and we don't move the ticket either (a
  -- closed ticket should stay closed).
  if v_ticket.status_category = 'pending_approval' then
    if p_decision = 'rejected' then
      update public.tickets
         set status          = 'rejected',
             status_category = 'closed',
             closed_at       = coalesce(closed_at, now()),
             updated_at      = now()
       where id        = v_target_id
         and tenant_id = p_tenant_id;
      v_ticket_status          := 'rejected';
      v_ticket_status_category := 'closed';
    else
      update public.tickets
         set status          = 'new',
             status_category = 'new',
             updated_at      = now()
       where id        = v_target_id
         and tenant_id = p_tenant_id;
      v_ticket_status          := 'new';
      v_ticket_status_category := 'new';
    end if;
  else
    -- Ticket already moved on (e.g. manually closed). Preserve current
    -- state. Mirrors ticket.service.ts:708 early return.
    v_ticket_status          := v_ticket.status;
    v_ticket_status_category := v_ticket.status_category;
  end if;

  -- ── 10. Post-grant automation emits (approve + fully-resolved only) ─
  -- Mirrors runPostCreateAutomation behavior at ticket.service.ts:754-918
  -- but routes through outbox events per spec §3.5 step 8 + §3.9.3
  -- handler contract. Three emits, each conditional:
  --   * sla.timer_recompute_required — if ticket.sla_id is non-null. The
  --     handler re-reads ticket.sla_id at fire time (v8 / C3); started_at
  --     in payload is grant time per v9 / P-I2 ("customer waited for
  --     approval, SLA clock starts when operator can act").
  --   * routing.evaluation_required — always (the handler decides what to
  --     do based on current assignment + routing rules). Deferred to
  --     post-commit because routing reads from many tables; doing it in
  --     PG would be a port project (spec §3.5 "Why outbox for routing").
  --   * workflow.start_required — if ticket.workflow_id is non-null AND
  --     the ticket actually transitioned to 'new' (skip if the ticket was
  --     already in a non-pending_approval terminal state).
  --
  -- Skipped on rejection (closed ticket = no further automation) and on
  -- ticket-already-terminal (preserved current state above).
  if p_decision = 'approved' and v_ticket_status_category = 'new' then
    if v_ticket.sla_id is not null then
      perform outbox.emit(
        p_tenant_id      => p_tenant_id,
        p_event_type     => 'sla.timer_recompute_required',
        p_aggregate_type => 'case',
        p_aggregate_id   => v_target_id,
        p_payload        => jsonb_build_object(
          'tenant_id',    p_tenant_id,
          'ticket_id',    v_target_id,
          'sla_policy_id', v_ticket.sla_id,
          'started_at',   now(),
          'source',       'grant_ticket_approval'
        ),
        p_idempotency_key => 'sla.timer_recompute_required:' || v_target_id::text || ':' || p_idempotency_key,
        p_event_version  => 1,
        p_available_at   => null
      );
      v_sla_emitted := true;
    end if;

    perform outbox.emit(
      p_tenant_id      => p_tenant_id,
      p_event_type     => 'routing.evaluation_required',
      p_aggregate_type => 'case',
      p_aggregate_id   => v_target_id,
      p_payload        => jsonb_build_object(
        'tenant_id',       p_tenant_id,
        'ticket_id',       v_target_id,
        'ticket_type_id',  v_ticket.ticket_type_id,
        'location_id',     v_ticket.location_id,
        'asset_id',        v_ticket.asset_id,
        'source',          'grant_ticket_approval'
      ),
      p_idempotency_key => 'routing.evaluation_required:' || v_target_id::text || ':' || p_idempotency_key,
      p_event_version  => 1,
      p_available_at   => null
    );
    v_routing_emitted := true;

    if v_ticket.workflow_id is not null then
      perform outbox.emit(
        p_tenant_id      => p_tenant_id,
        p_event_type     => 'workflow.start_required',
        p_aggregate_type => 'case',
        p_aggregate_id   => v_target_id,
        p_payload        => jsonb_build_object(
          'tenant_id',               p_tenant_id,
          'ticket_id',               v_target_id,
          'workflow_definition_id',  v_ticket.workflow_id,
          'source',                  'grant_ticket_approval'
        ),
        p_idempotency_key => 'workflow.start_required:' || v_target_id::text || ':' || p_idempotency_key,
        p_event_version  => 1,
        p_available_at   => null
      );
      v_workflow_emitted := true;
    end if;
  end if;

  -- ── 11. INSERT ticket_activities (mirror 00325:316-346) ─────────────
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
  values (
    p_tenant_id,
    v_target_id,
    'system_event',
    v_actor_person_id,
    'system',
    jsonb_build_object(
      'event',        'approval_' || p_decision,
      'approval_id',  p_approval_id,
      'comments',     p_comments
    )
  );

  -- ── 12. INSERT domain_events (mirror 00310:228-242) ─────────────────
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

  -- ── 13. Mark command_operations success + return ────────────────────
  v_result := jsonb_build_object(
    'kind',                       'resolved',
    'approval_id',                p_approval_id,
    'ticket_id',                  v_target_id,
    'final_decision',             p_decision,
    'ticket_status',              v_ticket_status,
    'ticket_status_category',     v_ticket_status_category,
    'sla_started',                v_sla_emitted,
    'workflow_started',           v_workflow_emitted,
    'routing_evaluation_emitted', v_routing_emitted
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.grant_ticket_approval(uuid, uuid, uuid, text, text, text) from public;
grant  execute on function public.grant_ticket_approval(uuid, uuid, uuid, text, text, text) to service_role;

comment on function public.grant_ticket_approval(uuid, uuid, uuid, text, text, text) is
  'B.2.A.Step10 §3.5 — atomic approval grant for ticket targets. CAS update on approvals + ticket transition (rejected→closed | approved→new) + ticket_activities + domain_events — all in one transaction. On approve + fully-resolved chain/group, emits sla.timer_recompute_required (if ticket.sla_id), routing.evaluation_required (always), workflow.start_required (if ticket.workflow_id) outbox events per §3.9.3 handler contract. Idempotent on (tenant_id, p_idempotency_key) via command_operations (00316); same-key + different-payload raises command_operations.payload_mismatch. Replaces §1.3 (TicketService.onApprovalDecision) + §1.19 (ApprovalService.respond ticket branch). Spec: docs/follow-ups/b2-survey-and-design.md §3.5.';

notify pgrst, 'reload schema';
