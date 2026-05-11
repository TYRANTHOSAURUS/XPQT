-- B.2.A.Step8 — dispatch_child_work_orders_batch RPC (§3.4 batch sibling).
--
-- Spec:        docs/follow-ups/b2-survey-and-design.md §3.4 (lines 2228-2234).
-- Replaces:    §1.18 (workflow-engine create_child_tasks per-task loop).
-- Companion:   00336 (dispatch_child_work_order — single-child).
--
-- ── Why a batch RPC ─────────────────────────────────────────────────────
--
-- §1.18 (workflow-engine.service.ts:425-469) is today a TS for-loop over
-- `tasks` calling DispatchService.dispatch per task. A partial failure
-- mid-loop leaves [N committed children, M missing] and the engine
-- swallows the error at line 462 — the workflow advances anyway and the
-- operator sees a half-fanned-out workflow with no breadcrumb to the
-- missed two. Severity:critical per §1.18.
--
-- This RPC processes ALL tasks in ONE transaction:
--   * any task's validation failure (parent gate, FK validation, SLA
--     resolution) raises and rolls back the ENTIRE batch — no
--     half-fanned-out state.
--   * tasks share the SAME parent-share-lock + the SAME outer
--     idempotency gate, so retries replay the full set or commit
--     nothing.
--   * routing trace + SLA timers are TS-pre-computed per task; the
--     RPC just writes.
--
-- The implementation INTENTIONALLY does not loop-invoke the single-child
-- RPC. Doing so would (a) acquire N independent advisory locks
-- (one per inner idempotency key) and (b) write N command_operations
-- rows. Both are wrong for "one batch = one decision". Instead we
-- inline the per-task work inside one shared idempotency frame —
-- mirroring the spec's "saves the partial-fanout failure mode entirely".

create or replace function public.dispatch_child_work_orders_batch(
  p_parent_id        uuid,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_tasks            jsonb     -- jsonb array of per-task payload (same shape as §3.4 single)
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing                 public.command_operations;
  v_payload_hash             text;
  v_lock_key                 bigint;

  v_parent                   record;
  v_actor_person_id          uuid;

  v_task                     jsonb;
  v_results                  jsonb := '[]'::jsonb;

  -- Per-task locals
  v_child_id                 uuid;
  v_title                    text;
  v_description              text;
  v_priority                 text;
  v_interaction_mode         text;
  v_ticket_type_id           uuid;
  v_asset_id                 uuid;
  v_location_id              uuid;
  v_assigned_team_id         uuid;
  v_assigned_user_id         uuid;
  v_assigned_vendor_id       uuid;
  v_sla_id                   uuid;
  v_routing_trace            jsonb;
  v_routing_chosen_by        text;
  v_routing_strategy         text;
  v_routing_rule_id          uuid;
  v_routing_context          jsonb;
  v_status                   text;
  v_status_category          text;
  v_any_assignee             boolean;

  v_timer                    jsonb;
  v_timer_type               text;
  v_timer_target_minutes     int;
  v_timer_due_at             timestamptz;
  v_timer_calendar_id        uuid;
  v_sla_response_due         timestamptz;
  v_sla_resolution_due       timestamptz;

  v_result                   jsonb;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────
  if p_parent_id is null then
    raise exception 'dispatch_child_work_orders_batch: p_parent_id required';
  end if;
  if p_tenant_id is null then
    raise exception 'dispatch_child_work_orders_batch: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'dispatch_child_work_orders_batch: p_idempotency_key required';
  end if;
  if p_tasks is null or jsonb_typeof(p_tasks) <> 'array' then
    raise exception 'dispatch_child_work_orders_batch.invalid_payload: p_tasks must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_tasks) = 0 then
    raise exception 'dispatch_child_work_orders_batch.empty_tasks: p_tasks must contain at least one task'
      using errcode = 'P0001',
            hint = 'caller passed an empty tasks array; nothing to dispatch';
  end if;

  -- ── 1. Advisory xact lock ────────────────────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. command_operations idempotency gate ───────────────────────────
  v_payload_hash := md5(coalesce(p_tasks::text, ''));

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

  -- ── 3. Parent gate (once, shared across the batch) ───────────────────
  select id, status_category, priority,
         ticket_type_id, location_id, asset_id, requester_person_id
    into v_parent
    from public.tickets
   where id = p_parent_id and tenant_id = p_tenant_id
   for share;

  if not found then
    raise exception 'dispatch_child_work_order.parent_not_found: parent case % does not exist in tenant %',
      p_parent_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  if v_parent.status_category = 'pending_approval' then
    raise exception 'dispatch_child_work_order.parent_not_dispatchable: parent case % is pending approval',
      p_parent_id
      using errcode = 'P0001';
  end if;
  if v_parent.status_category in ('resolved', 'closed') then
    raise exception 'dispatch_child_work_order.parent_not_dispatchable: parent case % is %',
      p_parent_id, v_parent.status_category
      using errcode = 'P0001';
  end if;

  -- ── 4. Actor person id (shared, used by every task's activity row) ───
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 5. Per-task loop (inlined; same shape as the single RPC body) ────
  for v_task in select * from jsonb_array_elements(p_tasks) loop
    if jsonb_typeof(v_task) <> 'object' then
      raise exception 'dispatch_child_work_orders_batch.invalid_payload: each task must be a jsonb object'
        using errcode = 'P0001';
    end if;

    -- Required fields.
    if not (v_task ? 'child_id') or jsonb_typeof(v_task->'child_id') <> 'string' then
      raise exception 'dispatch_child_work_order.invalid_payload: child_id is required and must be a uuid string'
        using errcode = 'P0001';
    end if;
    begin
      v_child_id := (v_task->>'child_id')::uuid;
    exception when others then
      raise exception 'dispatch_child_work_order.invalid_payload: child_id must be a valid uuid (got %)',
        v_task->>'child_id'
        using errcode = 'P0001';
    end;

    if not (v_task ? 'title') or jsonb_typeof(v_task->'title') <> 'string' then
      raise exception 'dispatch_child_work_order.invalid_payload: title is required and must be a non-empty string'
        using errcode = 'P0001';
    end if;
    v_title := v_task->>'title';
    if v_title is null or length(btrim(v_title)) = 0 then
      raise exception 'dispatch_child_work_order.invalid_payload: title must be a non-empty string'
        using errcode = 'P0001';
    end if;

    -- Optional fields.
    v_description       := nullif(v_task->>'description', '');
    v_priority          := nullif(v_task->>'priority', '');
    v_interaction_mode  := coalesce(nullif(v_task->>'interaction_mode', ''), 'internal');
    v_ticket_type_id    := nullif(v_task->>'ticket_type_id',     '')::uuid;
    v_asset_id          := nullif(v_task->>'asset_id',           '')::uuid;
    v_location_id       := nullif(v_task->>'location_id',        '')::uuid;
    v_assigned_team_id  := nullif(v_task->>'assigned_team_id',   '')::uuid;
    v_assigned_user_id  := nullif(v_task->>'assigned_user_id',   '')::uuid;
    v_assigned_vendor_id:= nullif(v_task->>'assigned_vendor_id', '')::uuid;
    if (v_task ? 'sla_id') and jsonb_typeof(v_task->'sla_id') = 'string' then
      v_sla_id := (v_task->>'sla_id')::uuid;
    else
      v_sla_id := null;
    end if;

    if v_interaction_mode not in ('internal','external') then
      raise exception 'dispatch_child_work_order.invalid_payload: interaction_mode must be internal or external (got %)',
        v_interaction_mode
        using errcode = 'P0001';
    end if;

    v_routing_trace      := coalesce(v_task->'routing_trace', '[]'::jsonb);
    v_routing_chosen_by  := nullif(v_task->>'routing_chosen_by', '');
    v_routing_strategy   := coalesce(nullif(v_task->>'routing_strategy', ''), 'manual');
    v_routing_rule_id    := nullif(v_task->>'routing_rule_id', '')::uuid;
    v_routing_context    := coalesce(v_task->'routing_context', '{}'::jsonb);

    -- Tenant-FK validation (per task; raises rolls back the whole batch).
    if v_ticket_type_id is not null then
      perform public.validate_entity_in_tenant(p_tenant_id, 'request_type', v_ticket_type_id);
    end if;
    if v_location_id is not null then
      perform public.validate_entity_in_tenant(p_tenant_id, 'space', v_location_id);
    end if;
    if v_asset_id is not null then
      perform public.validate_entity_in_tenant(p_tenant_id, 'asset', v_asset_id);
    end if;
    if v_sla_id is not null then
      perform public.validate_entity_in_tenant(p_tenant_id, 'sla_policy', v_sla_id);
    end if;
    perform public.validate_assignees_in_tenant(
      p_tenant_id,
      v_assigned_team_id,
      v_assigned_user_id,
      v_assigned_vendor_id
    );

    v_any_assignee := (v_assigned_team_id is not null or v_assigned_user_id is not null or v_assigned_vendor_id is not null);
    v_status          := 'new';
    v_status_category := case when v_any_assignee then 'assigned' else 'new' end;

    -- Reset per-task SLA mirror vars (loop reuses globals).
    v_sla_response_due   := null;
    v_sla_resolution_due := null;

    -- Child INSERT.
    insert into public.work_orders (
      id, tenant_id, parent_kind, parent_ticket_id, ticket_type_id,
      title, description, priority, interaction_mode,
      location_id, asset_id, requester_person_id,
      status, status_category,
      assigned_team_id, assigned_user_id, assigned_vendor_id,
      sla_id
    ) values (
      v_child_id, p_tenant_id, 'case', p_parent_id,
      coalesce(v_ticket_type_id, v_parent.ticket_type_id),
      v_title, v_description,
      coalesce(v_priority, v_parent.priority, 'medium'),
      v_interaction_mode,
      coalesce(v_location_id, v_parent.location_id),
      coalesce(v_asset_id, v_parent.asset_id),
      v_parent.requester_person_id,
      v_status, v_status_category,
      v_assigned_team_id, v_assigned_user_id, v_assigned_vendor_id,
      v_sla_id
    );

    -- routing_decisions audit row.
    insert into public.routing_decisions (
      tenant_id, ticket_id,
      entity_kind, case_id, work_order_id,
      strategy, chosen_team_id, chosen_user_id, chosen_vendor_id,
      chosen_by, rule_id, trace, context
    ) values (
      p_tenant_id, v_child_id,
      'work_order', null, v_child_id,
      v_routing_strategy,
      v_assigned_team_id, v_assigned_user_id, v_assigned_vendor_id,
      coalesce(v_routing_chosen_by, 'manual'),
      v_routing_rule_id, v_routing_trace, v_routing_context
    );

    -- SLA timers + mirror.
    if v_sla_id is not null then
      if not (v_task ? 'timers') or jsonb_typeof(v_task->'timers') <> 'array'
         or jsonb_array_length(v_task->'timers') = 0 then
        raise exception 'dispatch_child_work_order.timers_required: sla_id is non-null but timers array is missing or empty'
          using errcode = 'P0001';
      end if;
      for v_timer in select * from jsonb_array_elements(v_task->'timers') loop
        if jsonb_typeof(v_timer) <> 'object' then
          raise exception 'dispatch_child_work_order.invalid_payload: timers entries must be jsonb objects'
            using errcode = 'P0001';
        end if;
        v_timer_type           := v_timer->>'timer_type';
        v_timer_target_minutes := (v_timer->>'target_minutes')::int;
        v_timer_due_at         := (v_timer->>'due_at')::timestamptz;
        v_timer_calendar_id    := nullif(v_timer->>'business_hours_calendar_id', '')::uuid;
        if v_timer_type not in ('response','resolution') then
          raise exception 'dispatch_child_work_order.invalid_payload: timer_type=% (must be response|resolution)',
            v_timer_type
            using errcode = 'P0001';
        end if;
        insert into public.sla_timers
          (tenant_id, ticket_id, sla_policy_id, timer_type,
           target_minutes, due_at, business_hours_calendar_id)
        values (p_tenant_id, v_child_id, v_sla_id, v_timer_type,
                v_timer_target_minutes, v_timer_due_at, v_timer_calendar_id);
        if v_timer_type = 'response'   then v_sla_response_due   := v_timer_due_at; end if;
        if v_timer_type = 'resolution' then v_sla_resolution_due := v_timer_due_at; end if;
      end loop;

      update public.work_orders
         set sla_response_due_at   = coalesce(v_sla_response_due,   sla_response_due_at),
             sla_resolution_due_at = coalesce(v_sla_resolution_due, sla_resolution_due_at),
             updated_at            = now()
       where id = v_child_id and tenant_id = p_tenant_id;
    end if;

    -- Parent activity row per task.
    insert into public.ticket_activities (
      tenant_id, ticket_id,
      activity_type, author_person_id, visibility, metadata
    ) values (
      p_tenant_id, p_parent_id,
      'system_event', v_actor_person_id, 'system',
      jsonb_build_object(
        'event',              'dispatched',
        'child_id',           v_child_id,
        'assigned_team_id',   v_assigned_team_id,
        'assigned_user_id',   v_assigned_user_id,
        'assigned_vendor_id', v_assigned_vendor_id,
        'sla_id',             v_sla_id
      )
    );

    v_results := v_results || jsonb_build_object(
      'child_id',           v_child_id,
      'status',             v_status,
      'status_category',    v_status_category,
      'assigned_team_id',   v_assigned_team_id,
      'assigned_user_id',   v_assigned_user_id,
      'assigned_vendor_id', v_assigned_vendor_id,
      'sla_id',             v_sla_id,
      'routing_chosen_by',  v_routing_chosen_by
    );
  end loop;

  -- ── 6. Result + cache ────────────────────────────────────────────────
  v_result := jsonb_build_object(
    'parent_id',   p_parent_id,
    'tenant_id',   p_tenant_id,
    'tasks',       v_results,
    'task_count',  jsonb_array_length(v_results),
    'noop',        false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.dispatch_child_work_orders_batch(uuid, uuid, uuid, text, jsonb) from public;
grant  execute on function public.dispatch_child_work_orders_batch(uuid, uuid, uuid, text, jsonb) to service_role;

comment on function public.dispatch_child_work_orders_batch(uuid, uuid, uuid, text, jsonb) is
  'Atomic batch dispatch of N child work_orders from a parent case. Replaces §1.18 (workflow-engine.service.ts:425-469) per-task TS for-loop that swallowed mid-loop failures and produced half-fanned-out workflows (severity:critical). All N tasks commit or none commit — one raise inside the loop rolls back the entire batch. Single shared advisory lock + command_operations gate per batch (NOT per task); deterministic child_ids (TS-minted uuidv5 per task). Per-task body inlined (NOT a loop over the single-child RPC) so the lock + idempotency frame is shared. Same validation defense-in-depth as 00336. Result: {parent_id, tenant_id, tasks:[{child_id, status, status_category, assigned_*_id, sla_id, routing_chosen_by}], task_count, noop}. Spec: docs/follow-ups/b2-survey-and-design.md §3.4 (lines 2228-2234).';

notify pgrst, 'reload schema';
