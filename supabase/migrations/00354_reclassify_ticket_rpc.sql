-- B.2.A.Step11 commit 2 — reclassify_ticket RPC (§3.10).
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.10 (lines 2579-2790).
-- Replaces: §1.22 — `ReclassifyService.execute` + its inline TS side-
--   effect sequence (sla startTimers → workflow startForTicket →
--   routing recordDecision) + the legacy 8-arg `reclassify_ticket`
--   RPC (00044 / 00046) which closed children + stopped timers as
--   part of the same call. The B.2 contract is narrower: reclassify
--   only writes the parent + cancels active workflow_instances; SLA
--   timer repoint + workflow start + routing eval are deferred to
--   their respective outbox handlers.
--
-- ── Why this RPC ───────────────────────────────────────────────────────
--
-- Pre-Step 11 reclassify did:
--   1. RPC writes parent + cancels child WOs + stops timers (00046)
--   2. TS updates sla_id + calls SlaService.startTimers (separate tx)
--   3. TS calls workflowEngine.startForTicket (separate tx)
--   4. TS calls routingService.recordDecision (separate tx)
--
-- If any of 2-4 fails the parent has a fresh request_type but stale
-- SLA / no workflow / no routing breadcrumb — exactly the partial-
-- write hazard B.2 was set up to retire.
--
-- This RPC collapses the parent + workflow-cancel writes + the OUTBOX
-- EMITS for sla / workflow / routing into one PG tx. The actual SLA
-- timer start / workflow node creation / routing evaluation happens
-- in the outbox handlers (SlaTimerRepointHandler + WorkflowStartHandler
-- + RoutingEvaluationHandler, all registered in commit c9e2572a).
--
-- ── Signature ───────────────────────────────────────────────────────────
--
-- New signature drops the pre-routed assignee triple (the resolver runs
-- in the RoutingEvaluationHandler post-RPC). Adds `p_automation_plan`
-- (TS-resolved effective config) + `p_idempotency_key` (outer
-- command_operations key).
--
--   reclassify_ticket(
--     p_ticket_id        uuid,
--     p_tenant_id        uuid,
--     p_actor_user_id    uuid,
--     p_idempotency_key  text,
--     p_payload          jsonb,
--     p_automation_plan  jsonb
--   ) returns jsonb -- { ticket: row, follow_ups: [event types emitted] }
--
-- p_payload = { new_request_type_id: uuid, reason?: string,
--               new_location_id?: uuid }.
-- p_automation_plan = { effective_location_id, scope_override_id,
--                       effective_workflow_definition_id,
--                       effective_sla_policy_id,
--                       _resolution_at }.
--
-- ── Concurrent-edit narrowing (v10 / C4; codex-S12-I1 v3 pattern) ──────
--
-- Mirrors 00351's tightening: on semantic mismatch, check ONLY the
-- specific override row PG derived from (or the TS-named row when PG
-- derives no override). Unrelated overrides on the same request_type
-- never trip the gate.
--
-- ── Drop pre-Step 11 8-arg signature ───────────────────────────────────
--
-- 00046 left an 8-arg public.reclassify_ticket. Drop it explicitly so
-- the new 6-arg shape is the unambiguous PostgREST default.

drop function if exists public.reclassify_ticket(uuid, uuid, uuid, text, uuid, uuid, uuid, uuid);

create or replace function public.reclassify_ticket(
  p_ticket_id        uuid,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_payload          jsonb,
  p_automation_plan  jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox, pg_catalog
as $$
declare
  v_existing             public.command_operations;
  v_payload_hash         text;
  v_lock_key             bigint;

  -- Loaded ticket (FOR UPDATE)
  v_ticket               record;

  -- p_payload fields
  v_new_request_type_id  uuid;
  v_reason               text;
  v_new_location_id      uuid;

  -- p_automation_plan fields
  v_plan_effective_location_id      uuid;
  v_plan_scope_override_id          uuid;
  v_plan_workflow_definition_id     uuid;
  v_plan_sla_policy_id              uuid;
  v_plan_resolution_at              timestamptz;

  -- request_types (FOR SHARE) — new type
  v_new_request_type     record;

  -- PG-side re-derived
  v_derived_location_id            uuid;
  v_derived_override               jsonb;
  v_derived_override_id            uuid;
  v_derived_workflow_definition_id uuid;
  v_derived_sla_policy_id          uuid;
  v_concurrent_override_edit       boolean := false;
  v_winning_override_updated_at    timestamptz;

  -- Actor resolution (F-CRIT-1 pattern from 00351)
  v_actor_users_id       uuid;
  v_actor_person_id      uuid;

  -- Output
  v_ticket_row           public.tickets;
  v_follow_ups           text[] := '{}';
  v_result               jsonb;
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'reclassify_ticket: p_tenant_id required';
  end if;
  if p_ticket_id is null then
    raise exception 'reclassify_ticket: p_ticket_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'reclassify_ticket: p_idempotency_key required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'reclassify_ticket.input_invalid: p_payload must be a jsonb object'
      using errcode = 'P0001';
  end if;
  if p_automation_plan is null or jsonb_typeof(p_automation_plan) <> 'object' then
    raise exception 'reclassify_ticket.input_invalid: p_automation_plan must be a jsonb object'
      using errcode = 'P0001';
  end if;

  v_new_request_type_id := nullif(p_payload->>'new_request_type_id', '')::uuid;
  v_reason              := nullif(p_payload->>'reason', '');
  v_new_location_id     := nullif(p_payload->>'new_location_id', '')::uuid;

  if v_new_request_type_id is null then
    raise exception 'reclassify_ticket.input_invalid: p_payload.new_request_type_id required'
      using errcode = 'P0001';
  end if;

  v_plan_effective_location_id  := nullif(p_automation_plan->>'effective_location_id', '')::uuid;
  v_plan_scope_override_id      := nullif(p_automation_plan->>'scope_override_id', '')::uuid;
  v_plan_workflow_definition_id := nullif(p_automation_plan->>'effective_workflow_definition_id', '')::uuid;
  v_plan_sla_policy_id          := nullif(p_automation_plan->>'effective_sla_policy_id', '')::uuid;
  v_plan_resolution_at          := nullif(p_automation_plan->>'_resolution_at', '')::timestamptz;

  -- ── 1. Advisory lock + command_operations idempotency gate (00316) ─────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  v_payload_hash := md5(
    coalesce(p_payload::text, '') || '|' || coalesce(p_automation_plan::text, '')
  );

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

  -- ── 2. SELECT current ticket FOR UPDATE ────────────────────────────────
  --
  -- Captures (ticket_type_id, location_id, asset_id, workflow_id,
  -- sla_id, status_category). The current workflow_id + sla_id are the
  -- OLD effective values committed at create or the previous reclassify.
  select
    id,
    ticket_type_id,
    location_id,
    asset_id,
    workflow_id,
    sla_id,
    status,
    status_category
    into v_ticket
    from public.tickets
   where id = p_ticket_id and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'reclassify_ticket.ticket_not_found: id=% tenant=%', p_ticket_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  if v_ticket.ticket_type_id = v_new_request_type_id then
    raise exception 'reclassify_ticket.target_same: new request type equals current'
      using errcode = '22023';
  end if;

  -- ── 3. Reject if non-terminal approvals exist (v9 / C-P-C3; v10 / C2 enum gap) ──
  --
  -- Closes the "approver authorized plan A, last grant landed on plan B"
  -- hazard. Terminal states ('approved', 'rejected', 'expired') don't
  -- block; non-terminal states ('pending', 'delegated') do — 'delegated'
  -- is "pending, just routed elsewhere" semantically.
  if exists (
    select 1 from public.approvals
    where target_entity_type = 'ticket'
      and target_entity_id   = p_ticket_id
      and tenant_id          = p_tenant_id
      and status in ('pending', 'delegated')
  ) then
    raise exception 'reclassify_ticket.reclassify_during_approval: resolve open approvals first'
      using errcode = '22023',
            hint = 'Resolve all pending or delegated approvals on this ticket before reclassifying.';
  end if;

  -- ── 4. Validate new_request_type_id is tenant-owned + active ──────────
  perform public.validate_entity_in_tenant(p_tenant_id, 'request_type', v_new_request_type_id);

  if v_new_location_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'space', v_new_location_id);
  end if;
  if v_plan_effective_location_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'space', v_plan_effective_location_id);
  end if;
  if v_plan_scope_override_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'scope_override', v_plan_scope_override_id);
  end if;
  if v_plan_workflow_definition_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'workflow_definition', v_plan_workflow_definition_id);
  end if;
  if v_plan_sla_policy_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'sla_policy', v_plan_sla_policy_id);
  end if;

  select rt.active, rt.workflow_definition_id, rt.sla_policy_id
    into v_new_request_type
    from public.request_types rt
   where rt.id = v_new_request_type_id and rt.tenant_id = p_tenant_id
   for share;

  if not found or not coalesce(v_new_request_type.active, false) then
    raise exception 'reclassify_ticket.new_request_type_invalid: id=% inactive_or_missing', v_new_request_type_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Compute NEW effective config in PG (mirror §3.11 step 4) ──────
  --
  -- 5a. Effective location: explicit new_location_id wins, else ticket
  --     location, else asset's assigned_space_id. Mirrors
  --     scope-override-resolver.service.ts:111-125.
  v_derived_location_id := coalesce(
    coalesce(v_new_location_id, v_ticket.location_id),
    case when v_ticket.asset_id is not null then (
      select assigned_space_id from public.assets
       where id = v_ticket.asset_id and tenant_id = p_tenant_id
    ) else null end
  );

  -- 5b. Effective workflow + SLA via existing PG function (00096).
  v_derived_override := public.request_type_effective_scope_override(
    p_tenant_id, v_new_request_type_id, v_derived_location_id
  );
  v_derived_override_id := nullif(v_derived_override->>'id', '')::uuid;
  v_derived_workflow_definition_id := coalesce(
    nullif(v_derived_override->>'workflow_definition_id', '')::uuid,
    v_new_request_type.workflow_definition_id
  );
  v_derived_sla_policy_id := coalesce(
    nullif(v_derived_override->>'case_sla_policy_id', '')::uuid,
    v_new_request_type.sla_policy_id
  );

  -- 5c. Effective location MUST match plan (concurrent-edit doesn't
  --     soften this — location resolution is asset-driven; override
  --     edits can't affect it). Spec line 2685-2687.
  if v_derived_location_id is distinct from v_plan_effective_location_id then
    raise exception 'automation_plan.effective_location_mismatch: derived=% plan=%',
      coalesce(v_derived_location_id::text, '<null>'),
      coalesce(v_plan_effective_location_id::text, '<null>')
      using errcode = 'P0001';
  end if;

  -- 5d. Concurrent-edit detection (v10 / C4; codex-S12-I1 v3 narrowing).
  --
  --     Symmetric with 00351 lines 348-388 — narrow check on the SPECIFIC
  --     override row PG derived from (or the TS-named row when PG derives
  --     no override). Unrelated overrides on the same request_type never
  --     trip the gate.
  if v_plan_resolution_at is not null
     and (v_derived_workflow_definition_id is distinct from v_plan_workflow_definition_id
          or v_derived_sla_policy_id        is distinct from v_plan_sla_policy_id
          or v_derived_override_id          is distinct from v_plan_scope_override_id) then
    if v_derived_override is not null then
      -- (a) Check ONLY the row PG derived from.
      select updated_at into v_winning_override_updated_at
        from public.request_type_scope_overrides
       where id = (v_derived_override->>'id')::uuid
         and tenant_id = p_tenant_id;
      if v_winning_override_updated_at is not null
         and v_winning_override_updated_at > v_plan_resolution_at then
        v_concurrent_override_edit := true;
      end if;
    elsif v_plan_scope_override_id is not null then
      -- (b) PG derived no override, TS plan named one. Check the TS-named
      --     row: edited OR deleted post-_resolution_at → concurrent edit.
      select updated_at into v_winning_override_updated_at
        from public.request_type_scope_overrides
       where id = v_plan_scope_override_id
         and tenant_id = p_tenant_id;
      if v_winning_override_updated_at is null
         or v_winning_override_updated_at > v_plan_resolution_at then
        v_concurrent_override_edit := true;
      end if;
    end if;
  end if;

  -- 5e. Reject genuine semantic drift (not a concurrent edit). Spec
  --     lines 2688-2700.
  if v_derived_workflow_definition_id is distinct from v_plan_workflow_definition_id
     and not v_concurrent_override_edit then
    raise exception 'automation_plan.semantic_mismatch: workflow derived=% plan=%',
      coalesce(v_derived_workflow_definition_id::text, '<null>'),
      coalesce(v_plan_workflow_definition_id::text, '<null>')
      using errcode = 'P0001';
  end if;
  if v_derived_sla_policy_id is distinct from v_plan_sla_policy_id
     and not v_concurrent_override_edit then
    raise exception 'automation_plan.semantic_mismatch: sla derived=% plan=%',
      coalesce(v_derived_sla_policy_id::text, '<null>'),
      coalesce(v_plan_sla_policy_id::text, '<null>')
      using errcode = 'P0001';
  end if;
  if v_derived_override_id is distinct from v_plan_scope_override_id
     and not v_concurrent_override_edit then
    raise exception 'automation_plan.scope_override_mismatch: derived=% plan=%',
      coalesce(v_derived_override_id::text, '<null>'),
      coalesce(v_plan_scope_override_id::text, '<null>')
      using errcode = 'P0001';
  end if;

  -- ── 6. Resolve actor IDs ──────────────────────────────────────────────
  --
  -- F-CRIT-1 (mirroring 00351): p_actor_user_id is the Supabase auth UID
  -- (users.auth_uid). domain_events.actor_user_id is FK to users.id (PK).
  -- Resolve once here; reuse for activity + domain_events.
  if p_actor_user_id is not null then
    select u.id, u.person_id
      into v_actor_users_id, v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 7. UPDATE tickets ──────────────────────────────────────────────────
  --
  -- Writes the request-type column, effective workflow + SLA, resolved
  -- location, AND the audit pointer (reclassified_from_id ← OLD type).
  -- routing_status flips to 'pending' so the UI shows the
  -- routing-in-flight chip until the RoutingEvaluationHandler completes
  -- (spec step 11).
  update public.tickets
     set ticket_type_id       = v_new_request_type_id,
         reclassified_from_id = v_ticket.ticket_type_id,
         location_id          = v_derived_location_id,
         workflow_id          = v_derived_workflow_definition_id,
         sla_id               = v_derived_sla_policy_id,
         reclassified_reason  = v_reason,
         reclassified_at      = now(),
         reclassified_by      = v_actor_users_id,
         routing_status       = 'pending',
         routing_failure_reason = null,
         updated_at           = now()
   where id = p_ticket_id and tenant_id = p_tenant_id
  returning * into v_ticket_row;

  -- ── 8. INSERT ticket_activities (reclassified) ─────────────────────────
  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, content, metadata)
  values (
    p_tenant_id, p_ticket_id, 'system_event', v_actor_person_id, 'system', v_reason,
    jsonb_build_object(
      'event',                              'reclassified',
      'from_request_type_id',               v_ticket.ticket_type_id,
      'to_request_type_id',                 v_new_request_type_id,
      'previous_workflow_definition_id',    v_ticket.workflow_id,
      'new_workflow_definition_id',         v_derived_workflow_definition_id,
      'previous_sla_policy_id',             v_ticket.sla_id,
      'new_sla_policy_id',                  v_derived_sla_policy_id,
      'previous_location_id',               v_ticket.location_id,
      'new_location_id',                    v_derived_location_id,
      'reason',                             v_reason
    )
  );

  -- 8b. Concurrent-edit breadcrumb (v10 / C4 mirror).
  if v_concurrent_override_edit then
    insert into public.ticket_activities
      (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
    values (
      p_tenant_id, p_ticket_id, 'system_event', v_actor_person_id, 'system',
      jsonb_build_object(
        'event',                          'automation_plan_overridden_by_concurrent_edit',
        'plan_workflow_definition_id',    v_plan_workflow_definition_id,
        'derived_workflow_definition_id', v_derived_workflow_definition_id,
        'plan_sla_policy_id',             v_plan_sla_policy_id,
        'derived_sla_policy_id',          v_derived_sla_policy_id,
        'plan_scope_override_id',         v_plan_scope_override_id,
        'derived_scope_override_id',      v_derived_override_id
      )
    );
  end if;

  -- ── 9. INSERT domain_events (ticket_reclassified) ──────────────────────
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id, 'ticket_reclassified', 'ticket', p_ticket_id,
    jsonb_build_object(
      'ticket_id',                          p_ticket_id,
      'from_request_type_id',               v_ticket.ticket_type_id,
      'to_request_type_id',                 v_new_request_type_id,
      'previous_workflow_definition_id',    v_ticket.workflow_id,
      'new_workflow_definition_id',         v_derived_workflow_definition_id,
      'previous_sla_policy_id',             v_ticket.sla_id,
      'new_sla_policy_id',                  v_derived_sla_policy_id,
      'previous_location_id',               v_ticket.location_id,
      'new_location_id',                    v_derived_location_id,
      'reason',                             v_reason
    ),
    v_actor_users_id
  );

  -- ── 10. Cancel active workflow_instances if effective workflow changes ──
  --
  -- Spec lines 2726-2746 + mirror of 00046:65-77. Compare effective
  -- values (not raw config). With the active rows now `cancelled`, the
  -- partial unique index 00345 no longer matches and the
  -- WorkflowStartHandler's INSERT can succeed.
  if v_ticket.workflow_id is distinct from v_derived_workflow_definition_id then
    update public.workflow_instances
       set status           = 'cancelled',
           cancelled_at     = now(),
           cancelled_reason = v_reason,
           cancelled_by     = v_actor_users_id
     where ticket_id = p_ticket_id
       and tenant_id = p_tenant_id
       and status in ('active', 'waiting');
  end if;

  -- ── 11. Emit outbox events atomically ──────────────────────────────────
  --
  -- (a) sla.timer_repointed_required if sla changed AND new sla is non-null.
  --
  --     If the new sla is NULL we don't emit (there's nothing to repoint
  --     to) — but we DO need to stop any old active timers under the
  --     previous policy. Do that inline so the ticket isn't left with
  --     stale running timers. When sla changes to non-null, the
  --     repoint handler does the STOP + INSERT in one tx via 00353.
  if v_ticket.sla_id is distinct from v_derived_sla_policy_id then
    if v_derived_sla_policy_id is not null then
      perform outbox.emit(
        p_tenant_id,
        'sla.timer_repointed_required',
        'ticket',
        p_ticket_id,
        jsonb_build_object(
          'tenant_id',     p_tenant_id,
          'ticket_id',     p_ticket_id,
          'sla_policy_id', v_derived_sla_policy_id,
          'started_at',    now()
        ),
        'sla.timer_repointed_required:' || p_ticket_id::text || ':reclassify:' || p_idempotency_key,
        1,
        null
      );
      v_follow_ups := array_append(v_follow_ups, 'sla.timer_repointed_required');
    else
      -- New SLA is null — stop the old policy's active timers inline +
      -- clear the ticket's due-at columns so the UI doesn't show stale
      -- breach times under the new (empty) policy.
      update public.sla_timers
         set stopped_at     = now(),
             stopped_reason = coalesce(v_reason, 'reclassified')
       where tenant_id    = p_tenant_id
         and ticket_id    = p_ticket_id
         and stopped_at   is null
         and completed_at is null;
      update public.tickets
         set sla_response_due_at      = null,
             sla_resolution_due_at    = null,
             sla_response_breached_at = null,
             sla_resolution_breached_at = null,
             sla_at_risk              = false,
             updated_at               = now()
       where id = p_ticket_id and tenant_id = p_tenant_id;
    end if;
  end if;

  -- (b) workflow.start_required if workflow changed AND new is non-null.
  --     The cancellation above already cancelled the old instance; this
  --     event triggers the new one. If the new workflow is null, no
  --     emit — the ticket runs without a workflow.
  if v_ticket.workflow_id is distinct from v_derived_workflow_definition_id
     and v_derived_workflow_definition_id is not null then
    perform outbox.emit(
      p_tenant_id,
      'workflow.start_required',
      'ticket',
      p_ticket_id,
      jsonb_build_object(
        'tenant_id',              p_tenant_id,
        'ticket_id',              p_ticket_id,
        'workflow_definition_id', v_derived_workflow_definition_id
      ),
      'workflow.start_required:' || p_ticket_id::text || ':reclassify:' || p_idempotency_key,
      1,
      null
    );
    v_follow_ups := array_append(v_follow_ups, 'workflow.start_required');
  end if;

  -- (c) routing.evaluation_required — ALWAYS (spec line 2762-2764).
  --     Even when the new type might resolve to the same target, the
  --     resolver re-runs to record the breadcrumb. Handler flips
  --     routing_status back to 'idle' on success.
  perform outbox.emit(
    p_tenant_id,
    'routing.evaluation_required',
    'ticket',
    p_ticket_id,
    jsonb_build_object(
      'tenant_id', p_tenant_id,
      'ticket_id', p_ticket_id
    ),
    'routing.evaluation_required:' || p_ticket_id::text || ':reclassify:' || p_idempotency_key,
    1,
    null
  );
  v_follow_ups := array_append(v_follow_ups, 'routing.evaluation_required');

  -- ── 12. Mark command_operations success + return ───────────────────────
  v_result := jsonb_build_object(
    'ticket',                   to_jsonb(v_ticket_row),
    'follow_ups',               to_jsonb(v_follow_ups),
    'concurrent_override_edit', v_concurrent_override_edit
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.reclassify_ticket(uuid, uuid, uuid, text, jsonb, jsonb) from public;
grant  execute on function public.reclassify_ticket(uuid, uuid, uuid, text, jsonb, jsonb) to service_role;

comment on function public.reclassify_ticket(uuid, uuid, uuid, text, jsonb, jsonb) is
  'B.2.A.Step11 §3.10 — atomic case reclassify. Validates new request_type tenant ownership + active + non-terminal approvals; re-derives effective workflow + SLA + location (concurrent-edit narrowed per codex-S12-I1 v3); UPDATEs tickets + cancels active workflow_instances + emits outbox events (sla.timer_repointed_required / workflow.start_required when effective values change; routing.evaluation_required always) in one transaction. Idempotent on (tenant_id, idempotency_key) via command_operations (00316). actor_user_id resolves auth_uid → users.id (F-CRIT-1 mirror). Spec: docs/follow-ups/b2-survey-and-design.md §3.10.';

notify pgrst, 'reload schema';
