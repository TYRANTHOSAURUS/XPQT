-- B.2.A Step 10 reland v2 (post-review remediation).
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.5 (lines 2238-2350).
-- Supersedes: 00356_grant_ticket_approval_rpc.sql (CREATE OR REPLACE; same signature).
--
-- Two findings from the post-reland self full-review:
--
-- code-CRIT-1: aggregate_type='case' deviates from sibling ticket-domain
--   RPCs. 00350 v2 (create_ticket_with_automation) lines 611+630 and
--   00354 (reclassify_ticket) lines 482/526/547 use 'ticket' for the
--   same three event types (sla.timer_recompute_required,
--   routing.evaluation_required, workflow.start_required). The outbox
--   worker (apps/api/src/modules/outbox/outbox.worker.ts:201) dispatches
--   by event_type+event_version only, so events drain regardless of
--   aggregate_type — but any audit/dashboard/replay tool that filters
--   or groups by aggregate_type would split the same logical entity
--   ('ticket') into two bucket names. v2 changes all three emits from
--   'case' to 'ticket' to align with siblings. Same change in both the
--   final-resolution branch (00356:485-541) and the partial-approved
--   no-op return (no emits, so no change there).
--
-- plan-CRIT-1: `delegated` enum state is defensively guarded at the
--   state-machine guard (00356:286) AND at the chain count (line ~346),
--   but no current code path WRITES the 'delegated' status (grep
--   confirms: only schema 00012:14 + this RPC reference it; nothing
--   updates approvals.status to 'delegated'). The delegations table
--   (apps/api/src/modules/approval/approval.service.ts:192-227) is a
--   separate read-side mechanism for out-of-office routing. The guard
--   is structurally correct + future-proof, but the comment block at
--   00356:280-285 implied delegated was a runtime state. v2 corrects
--   the comment to reflect that the guard is defensive-only today and
--   becomes meaningful when a respond-via-delegate code path is added
--   (future work).
--
-- No behavior change beyond the aggregate_type rename (the comment is
-- documentation-only). The CAS + chain-count + outbox-emit-payload +
-- everything else from v1 is preserved verbatim.

create or replace function public.grant_ticket_approval(
  p_approval_id     uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text,
  p_payload         jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing            public.command_operations;
  v_payload_hash        text;
  v_lock_key            bigint;
  v_decision            text;
  v_comments            text;
  v_actor_users_id      uuid;
  v_actor_person_id     uuid;
  v_approval            record;
  v_target_id           uuid;
  v_target_kind         text;
  v_chain_id            uuid;
  v_parallel_group      text;
  v_non_terminal_count  int;
  v_ticket              record;
  v_now                 timestamptz;
  v_ticket_status       text;
  v_ticket_status_cat   text;
  v_sla_emitted         boolean := false;
  v_workflow_emitted    boolean := false;
  v_routing_emitted     boolean := false;
  v_result_kind         text;
  v_result              jsonb;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'grant_ticket_approval: p_tenant_id required';
  end if;
  if p_approval_id is null then
    raise exception 'grant_ticket_approval: p_approval_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'grant_ticket_approval: p_idempotency_key required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'grant_ticket_approval.invalid_response: payload must be a JSON object'
      using errcode = 'P0001';
  end if;

  v_decision := lower(coalesce(p_payload->>'decision', ''));
  if v_decision not in ('approved', 'rejected') then
    raise exception 'grant_ticket_approval.invalid_response: decision must be ''approved'' or ''rejected'' (got %)', coalesce(p_payload->>'decision', '<null>')
      using errcode = 'P0001';
  end if;
  v_comments := nullif(trim(coalesce(p_payload->>'comments', '')), '');

  v_now := now();

  -- ── 1. Advisory lock ──────────────────────────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. command_operations idempotency gate ────────────────────────────
  v_payload_hash := md5(coalesce(p_payload::text, ''));

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

  -- ── 3. Resolve actor auth_uid → users.id ONCE ──────────────────────────
  -- F-CRIT-1 (mirror 00350 v2 pattern). domain_events.actor_user_id is
  -- FK'd to users.id (00019:11). p_actor_user_id is the auth_uid. Resolve
  -- once at the top, reuse for both the partial-branch emit and the
  -- terminal-branch emit. SYSTEM_ACTOR (null) flows through unchanged.
  if p_actor_user_id is not null then
    select u.id, u.person_id
      into v_actor_users_id, v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id and u.auth_uid = p_actor_user_id
     limit 1;
  end if;

  -- ── 4. SELECT approval FOR UPDATE ─────────────────────────────────────
  select id, tenant_id, target_entity_type, target_entity_id, status,
         approval_chain_id, parallel_group_id
    into v_approval
    from public.approvals
   where id = p_approval_id and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'grant_ticket_approval.approval_not_found: id=%', p_approval_id
      using errcode = 'P0001';
  end if;

  if v_approval.target_entity_type <> 'ticket' then
    raise exception 'grant_ticket_approval.invalid_target_entity_type: target_entity_type=%', v_approval.target_entity_type
      using errcode = 'P0001';
  end if;

  -- ── 5. State-machine guard ────────────────────────────────────────────
  --
  -- Today's approvals state-machine (00012:14) defines:
  --   pending     → non-terminal, can be granted.
  --   approved    → terminal.
  --   rejected    → terminal.
  --   delegated   → defensive guard only — no production code path
  --                 writes this state today. The delegations table at
  --                 approval.service.ts:192-227 surfaces a pending
  --                 approval through a delegate's queue WITHOUT mutating
  --                 the approvals.status. The 'delegated' guard becomes
  --                 meaningful when a future "respond-via-delegate" code
  --                 path is added that flips status to 'delegated' on
  --                 hand-off. Until then this branch is structural
  --                 future-proofing per spec §3.10 line 2615-2620
  --                 (chain count) but unreachable in the CAS pre-check.
  --   expired     → terminal (set by a separate cron/job).
  if v_approval.status <> 'pending' then
    -- 'approved', 'rejected', 'expired' → already_responded.
    -- 'delegated' → also already_responded (defensive — see comment above).
    v_result := jsonb_build_object(
      'kind',                    'already_responded',
      'approval_id',             p_approval_id,
      'ticket_id',               v_approval.target_entity_id,
      'ticket_status',           null,
      'ticket_status_category',  null,
      'sla_started',             false,
      'workflow_started',        false,
      'routing_evaluation_emitted', false
    );

    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

    return v_result;
  end if;

  -- ── 6. CAS update approvals ────────────────────────────────────────────
  update public.approvals
     set status = v_decision,
         responded_at = v_now,
         responded_by = v_actor_users_id,
         comments = v_comments
   where id = p_approval_id
     and tenant_id = p_tenant_id
     and status = 'pending';

  if not found then
    -- Lost the CAS — another grant raced past us between the SELECT and
    -- UPDATE. The advisory lock should make this unreachable; surface
    -- as cas_lost for forensics if it ever fires.
    raise exception 'grant_ticket_approval.cas_lost: id=%', p_approval_id
      using errcode = 'P0001';
  end if;

  v_target_id := v_approval.target_entity_id;
  v_chain_id := v_approval.approval_chain_id;
  v_parallel_group := v_approval.parallel_group_id;

  -- ── 7. Chain / parallel-group resolution count ──────────────────────────
  --
  -- Spec §3.10 line 2615-2620: 'delegated' counts as non-terminal alongside
  -- 'pending'. If the chain has any non-terminal rows (excluding self),
  -- return partial_approved without firing post-grant automation.
  --
  -- For rejected: the whole chain collapses to closed immediately; we
  -- don't wait for the rest of the chain to resolve.
  if v_decision = 'approved' and (v_chain_id is not null or v_parallel_group is not null) then
    select count(*)
      into v_non_terminal_count
      from public.approvals
     where tenant_id = p_tenant_id
       and target_entity_type = 'ticket'
       and target_entity_id = v_target_id
       and id <> p_approval_id
       and status in ('pending', 'delegated')
       and (
         (v_chain_id is not null and approval_chain_id = v_chain_id)
         or
         (v_parallel_group is not null and parallel_group_id = v_parallel_group)
       );

    if v_non_terminal_count > 0 then
      -- Chain not yet resolved. Emit partial_approved domain event for
      -- audit + return early.
      insert into public.domain_events
        (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
      values (
        p_tenant_id,
        'approval_partial_approved',
        'ticket',
        v_target_id,
        jsonb_build_object(
          'tenant_id',              p_tenant_id,
          'approval_id',            p_approval_id,
          'ticket_id',              v_target_id,
          'remaining_count',        v_non_terminal_count,
          'comments',               v_comments
        ),
        v_actor_users_id
      );

      v_result := jsonb_build_object(
        'kind',                    'partial_approved',
        'approval_id',             p_approval_id,
        'ticket_id',               v_target_id,
        'ticket_status',           null,
        'ticket_status_category',  null,
        'sla_started',             false,
        'workflow_started',        false,
        'routing_evaluation_emitted', false,
        'remaining_count',         v_non_terminal_count
      );

      update public.command_operations
         set outcome = 'success', cached_result = v_result, completed_at = now()
       where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

      return v_result;
    end if;
  end if;

  -- ── 8. SELECT target ticket FOR UPDATE ────────────────────────────────
  select id, tenant_id, status, status_category, ticket_type_id, workflow_id,
         sla_id, location_id, asset_id, priority, created_at
    into v_ticket
    from public.tickets
   where id = v_target_id and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'grant_ticket_approval.ticket_not_found: id=%', v_target_id
      using errcode = 'P0001';
  end if;

  v_target_kind := 'case';

  -- ── 9. UPDATE tickets row + emit ticket_activities + domain_events ────
  if v_decision = 'rejected' then
    update public.tickets
       set status = 'rejected',
           status_category = 'closed',
           closed_at = v_now,
           updated_at = v_now
     where id = v_target_id and tenant_id = p_tenant_id;
    v_ticket_status := 'rejected';
    v_ticket_status_cat := 'closed';
  else
    -- 'approved' → flip status to 'new' (entry into the active queue).
    update public.tickets
       set status = 'new',
           status_category = 'new',
           updated_at = v_now
     where id = v_target_id and tenant_id = p_tenant_id;
    v_ticket_status := 'new';
    v_ticket_status_cat := 'new';
  end if;

  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, content, metadata)
  values (
    p_tenant_id,
    v_target_id,
    'system_event',
    v_actor_person_id,
    case when v_comments is not null then 'internal' else 'system' end,
    v_comments,
    jsonb_build_object(
      'event',              case when v_decision = 'approved' then 'approval_approved' else 'approval_rejected' end,
      'approval_id',        p_approval_id,
      'decision',           v_decision,
      'actor_user_id',      p_actor_user_id
    )
  );

  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id,
    case when v_decision = 'approved' then 'ticket_approved' else 'ticket_rejected' end,
    'ticket',
    v_target_id,
    jsonb_build_object(
      'tenant_id',         p_tenant_id,
      'approval_id',       p_approval_id,
      'ticket_id',         v_target_id,
      'decision',          v_decision,
      'previous_status',   'pending_approval',
      'new_status',        v_ticket_status,
      'previous_status_category', 'pending_approval',
      'new_status_category', v_ticket_status_cat,
      'comments',          v_comments
    ),
    v_actor_users_id
  );

  -- ── 10. If approved + resolved → emit post-grant automation events ─────
  --
  -- code-CRIT-1 (v2): aggregate_type='ticket' to match siblings 00350 v2
  -- and 00354 — same logical entity, same bucket name. Audit/dashboard
  -- tools filtering by aggregate_type now see consistent classification.
  --
  -- Conditional emits: sla.timer_recompute_required fires only when the
  -- ticket has a populated sla_id (v8 / C3 source-of-truth — handler
  -- re-reads tickets.sla_id at fire time). workflow.start_required fires
  -- only when ticket.workflow_id is non-null. routing.evaluation_required
  -- always fires (the resolver runs even if it returns 'unassigned' to
  -- record the breadcrumb).
  if v_decision = 'approved' and v_ticket_status_cat = 'new' then
    if v_ticket.sla_id is not null then
      perform outbox.emit(
        p_tenant_id      => p_tenant_id,
        p_event_type     => 'sla.timer_recompute_required',
        p_aggregate_type => 'ticket',
        p_aggregate_id   => v_target_id,
        p_payload        => jsonb_build_object(
          'tenant_id',     p_tenant_id,
          'ticket_id',     v_target_id,
          'sla_policy_id', v_ticket.sla_id,
          'started_at',    v_now,  -- DRIFT 3: grant time, spec line 2279.
          'source',        'grant_ticket_approval'
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
      p_aggregate_type => 'ticket',
      p_aggregate_id   => v_target_id,
      p_payload        => jsonb_build_object(
        'tenant_id',       p_tenant_id,
        'ticket_id',       v_target_id,
        'request_type_id', v_ticket.ticket_type_id,
        'location_id',     v_ticket.location_id,
        'asset_id',        v_ticket.asset_id,
        'priority',        v_ticket.priority,
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
        p_aggregate_type => 'ticket',
        p_aggregate_id   => v_target_id,
        p_payload        => jsonb_build_object(
          'tenant_id',              p_tenant_id,
          'ticket_id',              v_target_id,
          'workflow_definition_id', v_ticket.workflow_id,
          'source',                 'grant_ticket_approval'
        ),
        p_idempotency_key => 'workflow.start_required:' || v_target_id::text || ':' || p_idempotency_key,
        p_event_version  => 1,
        p_available_at   => null
      );
      v_workflow_emitted := true;
    end if;
  end if;

  -- ── 11. Build cached result + mark command_operations success ─────────
  v_result_kind := case
    when v_decision = 'rejected' then 'rejected'
    else 'resolved'
  end;

  v_result := jsonb_build_object(
    'kind',                       v_result_kind,
    'approval_id',                p_approval_id,
    'ticket_id',                  v_target_id,
    'ticket_status',              v_ticket_status,
    'ticket_status_category',     v_ticket_status_cat,
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

revoke execute on function public.grant_ticket_approval(uuid, uuid, uuid, text, jsonb) from public;
grant  execute on function public.grant_ticket_approval(uuid, uuid, uuid, text, jsonb) to service_role;

comment on function public.grant_ticket_approval(uuid, uuid, uuid, text, jsonb) is
  'v2 (00357): aggregate_type=''ticket'' for the 3 outbox emits (matches siblings 00350 v2 + 00354 — same logical entity); reconciles the ''delegated'' enum comment to reflect that the guard is defensive-only today (no production writer of approvals.status=''delegated''). All other behaviour preserved from v1 (00356). Spec: docs/follow-ups/b2-survey-and-design.md §3.5.';

notify pgrst, 'reload schema';
