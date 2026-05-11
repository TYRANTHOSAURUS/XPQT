-- B.2.A.Step10 RELAND — grant_ticket_approval RPC.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.5 (lines 2238-2350).
-- Replaces: §1.3 (TicketService.onApprovalDecision, ticket.service.ts:851-898)
--           + §1.19 (ApprovalService.respond ticket branch,
--             approval.service.ts:466-560).
--
-- Sibling references:
--   - supabase/migrations/00310_grant_booking_approval_rpc.sql
--     (booking-target mirror; same advisory-lock + FOR UPDATE-before-CAS
--     v8.1-I2 ordering).
--   - supabase/migrations/00350_create_ticket_with_automation_v2.sql:499-512
--     (F-CRIT-1 actor auth_uid → users.id resolution pattern).
--   - supabase/migrations/00352_start_sla_timers_v2.sql (p_started_at
--     contract — the post-grant emit must carry started_at = now() so
--     the SlaTimerHandler doesn't re-stamp it at handler-fire time).
--   - supabase/migrations/00354_reclassify_ticket_rpc.sql:219-230 (v10/C2
--     enum gap — non-terminal approval set = {'pending','delegated'}).
--
-- ── Why this RPC ───────────────────────────────────────────────────────
--
-- The ticket-target approval branch today does (post-revert of 3834b702):
--   1. SELECT approval (TS, separate tx)
--   2. UPDATE approval CAS (TS, separate tx)
--   3. INSERT domain_events (TS, separate tx)
--   4. UPDATE tickets status / status_category / closed_at (TS, sep. tx)
--   5. INSERT ticket_activities (TS, separate tx)
--   6. *(approve only)* re-load + run post-create automation (routing,
--      SLA, workflow) — each a separate tx in TicketService.runPostCreateAutomation.
--
-- If any step fails mid-sequence the approval is decided but the ticket
-- remains in `pending_approval`. Critical severity per §1.3 + §1.19.
-- This RPC collapses steps 1-5 + the post-create automation EMITS into
-- one Postgres transaction. SLA timer start, routing evaluation, and
-- workflow start are deferred to outbox handlers (SlaTimerHandler /
-- RoutingEvaluationHandler / WorkflowStartHandler per §3.9.3 — all three
-- shipped in Step 11 / Step 12 so events drain cleanly now).
--
-- ── Reland-specific contract drifts addressed (vs reverted 3834b702) ───
--
-- DRIFT 1: Approval enum gap (v10 / C2). Spec §3.10 step 3 added
-- `delegated` to the non-terminal approval set. The reverted RPC at
-- 3834b702:226 filtered `status <> 'pending'` only. This version
-- extends both the CAS pre-check AND the chain/group resolution count to
-- include `delegated` — so a delegated peer keeps the chain open.
--
-- DRIFT 2: F-CRIT-1 actor resolution. Post-Step-12, `p_actor_user_id` is
-- the Supabase auth UID (`users.auth_uid`); `domain_events.actor_user_id`
-- is FK to `users.id` (00019:11). The reverted RPC inserted
-- `p_actor_user_id` directly into `domain_events.actor_user_id`,
-- triggering 23503 on real authenticated callers (Step 12 harness
-- scenario 6 documents this). This version resolves auth_uid → users.id
-- ONCE near the top and reuses `v_actor_users_id` for both partial-decision
-- and final-decision domain_events INSERTs.
--
-- DRIFT 3: F-CRIT-2 / S12-I2 started_at semantics. Post-Step-12, the
-- `sla.timer_recompute_required` outbox event's payload carries
-- `started_at`, and `SlaTimerHandler` passes that value through to
-- `start_sla_timers(p_started_at)` (00352 v2) which persists it
-- verbatim. Spec §3.5 line 2279 says the SLA clock on the grant path
-- starts when the operator can act — i.e. `started_at = now()` at
-- emit time (= grant time). This version sets `started_at = now()`
-- explicitly on the emit payload (was implicit-via-handler-default in
-- the reverted version).
--
-- DRIFT 4: AppError detail leak. The TS-layer's `mapRpcErrorToAppError`
-- helper post-Step-12 strips the SQL `raise tail` from registered
-- codes (CODEX-B-1 fix in 00352-adjacent TS work). No SQL changes
-- needed here for that — kept the same `<namespace>.<specifier>:
-- <tail>` shape as 00350/00354 since the helper handles stripping.
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
--                              approvals remain non-terminal
--                              ({'pending','delegated'} — drift 1). CAS
--                              committed on this row; ticket stays in
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
--   - 00019_events_audit.sql:11 — domain_events.actor_user_id FK to users.id.
--   - 00310_grant_booking_approval_rpc.sql:86-148 — advisory lock +
--     FOR UPDATE + state-machine guard ordering this RPC mirrors.
--   - 00316_command_operations_table.sql:32-42 — idempotency table schema.
--   - 00350_create_ticket_with_automation_v2.sql:499-512 — F-CRIT-1
--     actor auth_uid → users.id resolution pattern (DRIFT 2 reference).
--   - 00352_start_sla_timers_v2.sql:57,69-72 — p_started_at contract
--     the post-grant emit honours (DRIFT 3 reference).
--   - 00354_reclassify_ticket_rpc.sql:219-230 — `status in
--     ('pending','delegated')` enum gap (DRIFT 1 reference).
--   - apps/api/src/modules/ticket/ticket.service.ts:851-898 — TS branch
--     this RPC replaces (onApprovalDecision).
--   - apps/api/src/modules/approval/approval.service.ts:466-562 — TS
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
  v_actor_users_id         uuid;  -- DRIFT 2: resolved users.id (PK) for domain_events FK.
  v_actor_person_id        uuid;
  v_sla_emitted            boolean := false;
  v_workflow_emitted       boolean := false;
  v_routing_emitted        boolean := false;
  v_ticket_status          text;
  v_ticket_status_category text;
  v_result                 jsonb;
begin
  -- ── 0. Argument shape checks (mirror 00310:74-84 + 00350:74-87) ──────
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

  -- ── 3. DRIFT 2: Resolve actor auth_uid → users.id ONCE ──────────────
  -- p_actor_user_id is the Supabase auth UID (users.auth_uid).
  -- domain_events.actor_user_id is FK to users.id (00019:11). Resolve
  -- once here; reuse v_actor_users_id for the domain_events INSERTs in
  -- the partial-decision branch (step 7) AND the final-decision branch
  -- (step 12). v_actor_person_id is used for ticket_activities
  -- (00011:74 — author_person_id FK to persons.id).
  --
  -- Pattern reference: 00350:499-512 (F-CRIT-1 from Step 12).
  if p_actor_user_id is not null then
    select u.id, u.person_id
      into v_actor_users_id, v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 4. Lock + read approval row (mirror 00310:98-108, v8.1-I2 order) ─
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

  -- ── 5. Target entity type guard (mirror 00310:114-120) ──────────────
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

  -- ── 6. State-machine guard — already responded ──────────────────────
  --
  -- DRIFT 1 (v10 / C2): non-terminal set is {'pending','delegated'}.
  -- Any other status ('approved','rejected','expired') is terminal and
  -- means another path already decided this row — surface as
  -- 'already_responded' without re-running the CAS (which would either
  -- silently no-op or, worse, miss).
  --
  -- Note: even though we only allow CAS to flip a row currently in
  -- 'pending', the 'delegated' status is also non-terminal from the
  -- chain's perspective — the delegate produces a separate approvals
  -- row with their own decision. So a caller landing here with a
  -- 'delegated' source row is calling the wrong RPC arm (or against
  -- the wrong row id); 'already_responded' is the right surface.
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

  -- ── 7. CAS update on approvals row (mirror 00310:137-149) ───────────
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

  -- ── 8. Chain / parallel-group resolution check (approve branch only) ─
  -- Mirrors §1.19's advanceChain + ApprovalService.isParallelGroupComplete
  -- semantics (approval.service.ts:751-777) but evaluated in one
  -- atomic step in SQL. Spec §3.5 step 7.
  --
  -- DRIFT 1 (v10 / C2): non-terminal set includes BOTH 'pending' and
  -- 'delegated'. A delegated peer means a delegate is still processing
  -- (the delegate's separate approval row will resolve later) — the
  -- chain is incomplete until both the source AND the delegate decide.
  -- The reverted 3834b702 only counted 'pending' here, which would
  -- silently close the chain when a peer was delegated, firing
  -- automation prematurely. Symmetric with 00354:219-230.
  --
  -- For rejection: a single rejected step terminates the chain/group
  -- (spec line 2256-2257). We always proceed to flip the ticket to
  -- closed.
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
       and status in ('pending', 'delegated');  -- DRIFT 1.

    if v_unresolved_count > 0 then
      -- Record a domain_events row so the partial decision is auditable
      -- even though the ticket doesn't move. Mirrors the TS-side
      -- logDomainEvent emission at approval.service.ts:503-506.
      --
      -- DRIFT 2: actor_user_id = v_actor_users_id (resolved users.id PK),
      -- NOT p_actor_user_id (auth_uid). FK to users.id; the reverted
      -- 3834b702 wrote auth_uid here directly → 23503.
      insert into public.domain_events (
        tenant_id, event_type, entity_type, entity_id, payload, actor_user_id
      ) values (
        p_tenant_id,
        'approval_' || p_decision,
        'approval',
        v_target_id,
        jsonb_build_object(
          'approval_id',     p_approval_id,
          'idempotency_key', p_idempotency_key,
          'partial',         true,
          'remaining',       v_unresolved_count
        ),
        v_actor_users_id
      );

      v_result := jsonb_build_object(
        'kind',                       'partial_approved',
        'approval_id',                p_approval_id,
        'ticket_id',                  v_target_id,
        'ticket_status',              null,
        'ticket_status_category',     'pending_approval',
        'sla_started',                false,
        'workflow_started',           false,
        'routing_evaluation_emitted', false,
        'remaining',                  v_unresolved_count
      );

      update public.command_operations
         set outcome = 'success', cached_result = v_result, completed_at = now()
       where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
      return v_result;
    end if;
  end if;

  -- ── 9. Lock the target ticket row (FOR UPDATE, full projection) ─────
  -- Spec lines 2266-2272: read effective workflow_id / sla_id /
  -- location_id / asset_id / created_at off the TICKET row, not
  -- request_types defaults. The ticket carries the effective values
  -- committed at create time by §3.11. Reading request_types here would
  -- silently start the wrong policy on scope-overridden tickets (v7 / C1
  -- bug fix).
  select id, tenant_id, ticket_type_id, workflow_id, sla_id,
         location_id, asset_id, created_at, status, status_category, priority
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

  -- ── 10. Apply ticket state transition ───────────────────────────────
  -- Mirrors apps/api/src/modules/ticket/ticket.service.ts:851-898 — the
  -- branch on outcome flips status + status_category + closed_at.
  --
  -- We unconditionally apply the UPDATE only when the ticket is still in
  -- pending_approval. The legacy TS code at ticket.service.ts:854 had an
  -- early-return guard against `status_category !== 'pending_approval'`
  -- — i.e. it skipped automation when the ticket had moved out of
  -- pending_approval already (e.g. the ticket was manually closed
  -- between approval-create and approval-grant). We preserve that by
  -- NOT firing automation when the ticket is no longer in
  -- pending_approval — and we don't move the ticket either (a closed
  -- ticket should stay closed).
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
    -- state. Mirrors ticket.service.ts:854 early return.
    v_ticket_status          := v_ticket.status;
    v_ticket_status_category := v_ticket.status_category;
  end if;

  -- ── 11. Post-grant automation emits (approve + fully-resolved only) ─
  -- Mirrors runPostCreateAutomation behavior at ticket.service.ts:900-1071
  -- but routes through outbox events per spec §3.5 step 8 + §3.9.3
  -- handler contract. Three emits, each conditional:
  --   * sla.timer_recompute_required — if ticket.sla_id is non-null. The
  --     handler re-reads ticket.sla_id at fire time (v8 / C3); started_at
  --     in payload is grant time per spec line 2279 ("customer waited
  --     for approval, SLA clock starts when operator can act").
  --   * routing.evaluation_required — always (the handler decides what
  --     to do based on current assignment + routing rules). Deferred to
  --     post-commit because routing reads from many tables; porting all
  --     of it to PG would be a project.
  --   * workflow.start_required — if ticket.workflow_id is non-null AND
  --     the ticket actually transitioned to 'new' (skip if the ticket
  --     was already in a non-pending_approval terminal state).
  --
  -- Skipped on rejection (closed ticket = no further automation) and on
  -- ticket-already-terminal (preserved current state above).
  --
  -- DRIFT 3: started_at = now() is set EXPLICITLY in the sla payload so
  -- the post-Step-12 SlaTimerHandler / 00352 v2 start_sla_timers
  -- contract receives the grant-time clock anchor. The handler reads
  -- payload.started_at and threads it into start_sla_timers(p_started_at)
  -- which persists THAT value (NOT now() at handler-fire time). Without
  -- this, a lagged outbox worker would skew the at-risk percentage on
  -- the timer.
  if p_decision = 'approved' and v_ticket_status_category = 'new' then
    if v_ticket.sla_id is not null then
      perform outbox.emit(
        p_tenant_id      => p_tenant_id,
        p_event_type     => 'sla.timer_recompute_required',
        p_aggregate_type => 'case',
        p_aggregate_id   => v_target_id,
        p_payload        => jsonb_build_object(
          'tenant_id',     p_tenant_id,
          'ticket_id',     v_target_id,
          'sla_policy_id', v_ticket.sla_id,
          'started_at',    now(),  -- DRIFT 3: grant time, spec line 2279.
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
      p_aggregate_type => 'case',
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
        p_aggregate_type => 'case',
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

  -- ── 12. INSERT ticket_activities (mirror 00325:316-346) ─────────────
  -- author_person_id = v_actor_person_id (00011:74 — FK to persons.id).
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

  -- ── 13. INSERT domain_events (mirror 00310:228-242) ─────────────────
  -- DRIFT 2: actor_user_id = v_actor_users_id (resolved users.id PK),
  -- NOT p_actor_user_id (auth_uid).
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload, actor_user_id
  ) values (
    p_tenant_id,
    'approval_' || p_decision,
    'approval',
    v_target_id,
    jsonb_build_object(
      'approval_id',     p_approval_id,
      'idempotency_key', p_idempotency_key
    ),
    v_actor_users_id
  );

  -- ── 14. Mark command_operations success + return ────────────────────
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
  'B.2.A.Step10 RELAND §3.5 — atomic approval grant for ticket targets. CAS update on approvals + ticket transition (rejected→closed | approved→new) + ticket_activities + domain_events — all in one transaction. On approve + fully-resolved chain/group, emits sla.timer_recompute_required (if ticket.sla_id) with started_at=now() per spec line 2279, routing.evaluation_required (always), workflow.start_required (if ticket.workflow_id) outbox events per §3.9.3 handler contract. Idempotent on (tenant_id, p_idempotency_key) via command_operations (00316); same-key + different-payload raises command_operations.payload_mismatch. DRIFT 1 (v10/C2): non-terminal approval set = {pending, delegated}. DRIFT 2 (Step12 F-CRIT-1): resolves p_actor_user_id (auth_uid) to users.id PK before INSERTing into domain_events.actor_user_id. DRIFT 3 (Step12 S12-I2): post-grant sla emit carries started_at=now() honored by 00352 v2 start_sla_timers. Replaces §1.3 (TicketService.onApprovalDecision) + §1.19 (ApprovalService.respond ticket branch). Spec: docs/follow-ups/b2-survey-and-design.md §3.5.';

notify pgrst, 'reload schema';
