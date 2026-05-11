-- B.2.A.Step11 self-review remediation — reclassify_ticket v2 (F-CRIT-1).
--
-- Adds a PG-side terminal-state guard to reclassify_ticket. The TS layer
-- at apps/api/src/modules/ticket/reclassify.service.ts:~376 already
-- rejects closed | resolved tickets via assertReclassifiable (see
-- TERMINAL_CATEGORIES at line 21). But the RPC at 00354 had no symmetric
-- gate — any caller bypassing ReclassifyService (psql, seed scripts,
-- future internal orchestrator) could reclassify a terminal ticket and
-- fire routing / sla / workflow side effects on a closed case.
--
-- Symmetric with the approval gate at step 3 (00354:215-231) — every
-- B.2 RPC must enforce its own invariants regardless of caller trust.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.10 (reclassify_ticket).
-- Citations:
--   - apps/api/src/modules/ticket/reclassify.service.ts:21 (TERMINAL_CATEGORIES)
--   - apps/api/src/modules/ticket/reclassify.service.ts:369-387 (assertReclassifiable)
--   - supabase/migrations/00354_reclassify_ticket_rpc.sql:215-231 (approval gate;
--     mirror this pattern)
--
-- Wire shape (unchanged from 00354 6-arg signature):
--   reclassify_ticket(p_ticket_id, p_tenant_id, p_actor_user_id,
--                     p_idempotency_key, p_payload, p_automation_plan)
--   returns jsonb
--
-- Error code raised: `reclassify_ticket.terminal_ticket` (P0001, → 422).
-- Registered in packages/shared/src/error-codes.ts + EN/NL messages on
-- both api and web; mapped to 422 in STATUS_BY_CODE.

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

  -- ── 2b. Terminal-state guard (Step11 self-review F-CRIT-1) ─────────────
  --
  -- Defense-in-depth terminal-state guard. The TS layer
  -- (reclassify.service.ts:~376) already rejects closed/resolved tickets,
  -- but the RPC was bypassable by any internal caller (psql, seed, future
  -- orchestrator). Symmetric with the approval gate at step 3 — every
  -- B.2 RPC enforces its own invariants regardless of caller trust.
  if v_ticket.status_category in ('resolved', 'closed') then
    raise exception 'reclassify_ticket.terminal_ticket: ticket in % state cannot be reclassified',
      v_ticket.status_category
      using errcode = 'P0001',
            hint = 'Cannot reclassify a ticket in resolved or closed state. Reopen first.';
  end if;

  -- ── 3. Reject if non-terminal approvals exist (v9 / C-P-C3; v10 / C2 enum gap) ──
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
  v_derived_location_id := coalesce(
    coalesce(v_new_location_id, v_ticket.location_id),
    case when v_ticket.asset_id is not null then (
      select assigned_space_id from public.assets
       where id = v_ticket.asset_id and tenant_id = p_tenant_id
    ) else null end
  );

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

  if v_derived_location_id is distinct from v_plan_effective_location_id then
    raise exception 'automation_plan.effective_location_mismatch: derived=% plan=%',
      coalesce(v_derived_location_id::text, '<null>'),
      coalesce(v_plan_effective_location_id::text, '<null>')
      using errcode = 'P0001';
  end if;

  if v_plan_resolution_at is not null
     and (v_derived_workflow_definition_id is distinct from v_plan_workflow_definition_id
          or v_derived_sla_policy_id        is distinct from v_plan_sla_policy_id
          or v_derived_override_id          is distinct from v_plan_scope_override_id) then
    if v_derived_override is not null then
      select updated_at into v_winning_override_updated_at
        from public.request_type_scope_overrides
       where id = (v_derived_override->>'id')::uuid
         and tenant_id = p_tenant_id;
      if v_winning_override_updated_at is not null
         and v_winning_override_updated_at > v_plan_resolution_at then
        v_concurrent_override_edit := true;
      end if;
    elsif v_plan_scope_override_id is not null then
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
  if p_actor_user_id is not null then
    select u.id, u.person_id
      into v_actor_users_id, v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 7. UPDATE tickets ──────────────────────────────────────────────────
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
  'B.2.A.Step11 §3.10 (v2 — Step11 self-review F-CRIT-1) — atomic case reclassify. Adds PG-side terminal-state guard (status_category in (resolved, closed) raises reclassify_ticket.terminal_ticket → 422); symmetric with the approval gate (step 3). All other behaviour identical to 00354: validates new request_type tenant ownership + active + non-terminal approvals; re-derives effective workflow + SLA + location (concurrent-edit narrowed per codex-S12-I1 v3); UPDATEs tickets + cancels active workflow_instances + emits outbox events in one transaction. Idempotent on (tenant_id, idempotency_key) via command_operations (00316). actor_user_id resolves auth_uid → users.id (F-CRIT-1 mirror).';

notify pgrst, 'reload schema';
