-- B.2.A.Step8 — dispatch_child_work_order RPC (§3.4 single-child).
--
-- Spec:        docs/follow-ups/b2-survey-and-design.md §3.4 (lines 2165-2226).
-- Replaces:    §1.15 (DispatchService.dispatch multi-table write surface).
-- Companion:   00337 (dispatch_child_work_orders_batch — batch sibling).
-- Helpers:     00316 (command_operations), 00317 (validate_assignees_in_tenant),
--              00321 (validate_entity_in_tenant v2).
--
-- ── What this RPC commits atomically ────────────────────────────────────
--
-- One transaction containing:
--   1. Advisory lock keyed on (tenant_id, idempotency_key) — sibling RPCs
--      already in B.2.A use the same pattern (00323/00325/00326/00327/
--      00328-00330/00331-00335).
--   2. command_operations idempotency gate (cache hit replays cached_result;
--      mismatched payload raises payload_mismatch — same pattern as
--      00327:139-152 / 00330:153-176 / 00335:182-201).
--   3. SELECT FOR SHARE on the parent case — must be tenant-owned, kind='case',
--      status_category not in (pending_approval, resolved, closed).
--   4. Tenant-FK validation for every uuid in payload (request_type, location,
--      asset, assignees, sla_id).
--   5. INSERT into public.work_orders using the TS-minted deterministic
--      child_id (uuidv5 of the idempotency key — retry-safe; same key + same
--      payload yields the same child row in the cached_result).
--   6. INSERT into public.routing_decisions (the resolver-trace audit row
--      supplied by TS as routing_trace + routing_chosen_by). Mirrors
--      RoutingService.recordDecision shape (routing.service.ts:65-85).
--   7. *(if sla_id non-null)* INSERT into public.sla_timers + UPDATE
--      work_orders.sla_response_due_at / sla_resolution_due_at. Mirrors
--      SlaService.startTimers shape (sla.service.ts:74-126). TS computes the
--      business-hours-adjusted due_at; the RPC just inserts.
--   8. INSERT into public.ticket_activities on the PARENT case row with
--      event='dispatched' — operator timeline parity with the legacy
--      dispatch.service.ts:271-282 emission.
--   9. Mark command_operations success + return result jsonb.
--
-- ── Why an RPC instead of TS multi-step ─────────────────────────────────
--
-- The legacy `DispatchService.dispatch()` (dispatch.service.ts:43-288)
-- threads through five separate supabase-js calls (work_orders.INSERT,
-- routing_decisions.INSERT via routing.service.ts, sla_timers.INSERT +
-- work_orders.UPDATE via sla.service.ts, ticket_activities.INSERT on
-- parent). Each is its own HTTP round-trip and its own transaction. A
-- mid-sequence failure leaves the child WO existing without routing
-- audit / without SLA timers / without parent activity — every dropped
-- write is a documented severity:critical leak in §1.15.
--
-- The workflow-engine call site (workflow-engine.service.ts:425-469)
-- multiplies the hazard per task in the create_child_tasks loop —
-- partial fan-out is the §1.18 failure mode the batch sibling (00337)
-- closes.
--
-- ── Idempotency semantics ───────────────────────────────────────────────
--
-- TS layer mints `child_id` deterministically via uuidv5 keyed on the
-- outer idempotency_key. The RPC's INSERT into work_orders writes that
-- exact id — replays of the same (tenant_id, idempotency_key) +
-- (md5(payload)) hit the command_operations cache and return the cached
-- result without re-inserting. A different payload under the same key
-- raises payload_mismatch — surface 409 per map-rpc-error.ts STATUS_BY_CODE.
--
-- ── Validation parity ───────────────────────────────────────────────────
--
-- TS preflight validates assignees/request_type/location/asset/sla_id
-- via assertTenantOwned + validateAssigneesInTenant (tenant-validation.ts).
-- The RPC re-validates server-side via validate_assignees_in_tenant
-- (00317) and validate_entity_in_tenant (00321) — defense-in-depth
-- against a TS regression that bypasses the preflight (same rationale as
-- the §3.2 / §3.3 sub-RPCs).

create or replace function public.dispatch_child_work_order(
  p_parent_id        uuid,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_payload          jsonb
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

  -- Required payload fields.
  v_child_id                 uuid;
  v_title                    text;

  -- Optional payload fields.
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

  -- Routing trace mirror — `chosen_*` is derived from the row we just
  -- wrote so the audit row sits next to the actual assignment.
  v_routing_chosen_team_id   uuid;
  v_routing_chosen_user_id   uuid;
  v_routing_chosen_vendor_id uuid;

  -- SLA timers loop.
  v_timer                    jsonb;
  v_timer_type               text;
  v_timer_target_minutes     int;
  v_timer_due_at             timestamptz;
  v_timer_calendar_id        uuid;
  v_sla_response_due         timestamptz;
  v_sla_resolution_due       timestamptz;

  v_status                   text;
  v_status_category          text;
  v_any_assignee             boolean;

  v_result                   jsonb;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────
  if p_parent_id is null then
    raise exception 'dispatch_child_work_order: p_parent_id required';
  end if;
  if p_tenant_id is null then
    raise exception 'dispatch_child_work_order: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'dispatch_child_work_order: p_idempotency_key required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'dispatch_child_work_order.invalid_payload: p_payload must be a jsonb object'
      using errcode = 'P0001';
  end if;

  -- ── 1. Required payload fields ───────────────────────────────────────
  -- child_id is TS-minted (uuidv5 of the idempotency_key) so the row
  -- write is retry-safe. A missing or malformed id is a programmer error.
  if not (p_payload ? 'child_id') or jsonb_typeof(p_payload->'child_id') <> 'string' then
    raise exception 'dispatch_child_work_order.invalid_payload: child_id is required and must be a uuid string'
      using errcode = 'P0001';
  end if;
  begin
    v_child_id := (p_payload->>'child_id')::uuid;
  exception when others then
    raise exception 'dispatch_child_work_order.invalid_payload: child_id must be a valid uuid (got %)',
      p_payload->>'child_id'
      using errcode = 'P0001';
  end;

  if not (p_payload ? 'title') or jsonb_typeof(p_payload->'title') <> 'string' then
    raise exception 'dispatch_child_work_order.invalid_payload: title is required and must be a non-empty string'
      using errcode = 'P0001';
  end if;
  v_title := p_payload->>'title';
  if v_title is null or length(btrim(v_title)) = 0 then
    raise exception 'dispatch_child_work_order.invalid_payload: title must be a non-empty string'
      using errcode = 'P0001';
  end if;

  -- ── 2. Optional payload fields ───────────────────────────────────────
  v_description       := nullif(p_payload->>'description', '');
  v_priority          := nullif(p_payload->>'priority', '');
  v_interaction_mode  := coalesce(nullif(p_payload->>'interaction_mode', ''), 'internal');
  v_ticket_type_id    := nullif(p_payload->>'ticket_type_id',     '')::uuid;
  v_asset_id          := nullif(p_payload->>'asset_id',           '')::uuid;
  v_location_id       := nullif(p_payload->>'location_id',        '')::uuid;
  v_assigned_team_id  := nullif(p_payload->>'assigned_team_id',   '')::uuid;
  v_assigned_user_id  := nullif(p_payload->>'assigned_user_id',   '')::uuid;
  v_assigned_vendor_id:= nullif(p_payload->>'assigned_vendor_id', '')::uuid;
  -- sla_id semantics: key absent → resolveChildSla picked null (TS pre-resolved
  -- and passed the result). key present with jsonb null → "No SLA" (explicit).
  -- key present with a uuid string → that policy. The TS layer normalises both
  -- before invoking the RPC so we just read the value here.
  if (p_payload ? 'sla_id') and jsonb_typeof(p_payload->'sla_id') = 'string' then
    v_sla_id := (p_payload->>'sla_id')::uuid;
  else
    v_sla_id := null;
  end if;

  if v_interaction_mode not in ('internal','external') then
    raise exception 'dispatch_child_work_order.invalid_payload: interaction_mode must be internal or external (got %)',
      v_interaction_mode
      using errcode = 'P0001';
  end if;

  -- Routing-trace snapshot (TS pre-evaluated; the RPC just persists).
  v_routing_trace      := coalesce(p_payload->'routing_trace', '[]'::jsonb);
  v_routing_chosen_by  := nullif(p_payload->>'routing_chosen_by', '');
  v_routing_strategy   := coalesce(nullif(p_payload->>'routing_strategy', ''), 'manual');
  v_routing_rule_id    := nullif(p_payload->>'routing_rule_id', '')::uuid;
  v_routing_context    := coalesce(p_payload->'routing_context', '{}'::jsonb);

  -- ── 3. Advisory xact lock ────────────────────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 4. command_operations idempotency gate (00316) ───────────────────
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

  -- ── 5. SELECT FOR SHARE on the parent case ───────────────────────────
  -- Parent is the case (tickets row). Use FOR SHARE — we read but don't
  -- mutate the parent's row; we do INSERT a child ticket_activity row
  -- that references parent.id (FK). Other RPCs (transition_entity_status,
  -- set_entity_assignment) may concurrently UPDATE the parent's
  -- status_category / assignment columns — those are independent of the
  -- dispatch decision. FOR SHARE blocks parent-row DELETE without
  -- blocking sibling UPDATEs.
  --
  -- Tenant filter is mandatory (memory: tenant_id is the #0 invariant).
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

  -- ── 6. Parent dispatchability gates ──────────────────────────────────
  -- Mirror the TS-level gates at dispatch.service.ts:84-102.
  --
  -- public.tickets is the case table post step1c.10c; rows here are
  -- always kind='case'. (The step1c cutover removed ticket_kind from
  -- tickets; work_orders is a separate table.) The "parent must be a
  -- case" check therefore reduces to "must exist in public.tickets" —
  -- which the SELECT above already enforced. The dedicated
  -- parent_not_case error code stays in the registry for forward
  -- compatibility with future call sites that might pass a work_order
  -- id in error.
  if v_parent.status_category = 'pending_approval' then
    raise exception 'dispatch_child_work_order.parent_not_dispatchable: parent case % is pending approval',
      p_parent_id
      using errcode = 'P0001',
            hint = 'cannot dispatch while parent is pending approval';
  end if;
  if v_parent.status_category in ('resolved', 'closed') then
    raise exception 'dispatch_child_work_order.parent_not_dispatchable: parent case % is %',
      p_parent_id, v_parent.status_category
      using errcode = 'P0001',
            hint = 'cannot dispatch a work order on a terminal case';
  end if;

  -- ── 7. Tenant-FK validation (defense-in-depth) ───────────────────────
  -- TS preflight already validated these via assertTenantOwned +
  -- validateAssigneesInTenant. The RPC re-validates server-side so a
  -- buggy or compromised TS preflight can't write a foreign-tenant uuid
  -- past the FK existence check (same rationale as 00326 / 00328).
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
  -- validate_assignees_in_tenant raises 42501 on first miss; non-null
  -- assignees only.
  perform public.validate_assignees_in_tenant(
    p_tenant_id,
    v_assigned_team_id,
    v_assigned_user_id,
    v_assigned_vendor_id
  );

  -- ── 8. status_category inheritance ───────────────────────────────────
  -- Mirror the legacy TS behaviour at dispatch.service.ts:239-243: child
  -- starts in 'new'; if ANY assignee is set (manual or post-routing),
  -- bump to 'assigned'. TS layer pre-routed before calling so the
  -- payload's `assigned_*_id` already reflects the resolved target.
  v_any_assignee := (v_assigned_team_id is not null or v_assigned_user_id is not null or v_assigned_vendor_id is not null);
  v_status          := 'new';
  v_status_category := case when v_any_assignee then 'assigned' else 'new' end;

  -- ── 9. INSERT child work_order ───────────────────────────────────────
  -- Deterministic id (TS-minted); parent_kind='case' explicit (dispatch
  -- is always case→wo); priority defaulted to parent.priority when DTO
  -- absent (parity with dispatch.service.ts:107).
  insert into public.work_orders (
    id,
    tenant_id,
    parent_kind,
    parent_ticket_id,
    ticket_type_id,
    title,
    description,
    priority,
    interaction_mode,
    location_id,
    asset_id,
    requester_person_id,
    status,
    status_category,
    assigned_team_id,
    assigned_user_id,
    assigned_vendor_id,
    sla_id
  ) values (
    v_child_id,
    p_tenant_id,
    'case',
    p_parent_id,
    coalesce(v_ticket_type_id, v_parent.ticket_type_id),
    v_title,
    v_description,
    coalesce(v_priority, v_parent.priority, 'medium'),
    v_interaction_mode,
    coalesce(v_location_id, v_parent.location_id),
    coalesce(v_asset_id, v_parent.asset_id),
    v_parent.requester_person_id,
    v_status,
    v_status_category,
    v_assigned_team_id,
    v_assigned_user_id,
    v_assigned_vendor_id,
    v_sla_id
  );

  -- ── 10. INSERT routing_decisions audit row ───────────────────────────
  -- Mirror RoutingService.recordDecision shape
  -- (apps/api/src/modules/routing/routing.service.ts:65-85). Polymorphic
  -- columns per 00229: entity_kind='work_order', work_order_id=child id.
  -- TS layer hands us the trace snapshot; we attach the resolved
  -- chosen_*_id columns from the row we just inserted.
  v_routing_chosen_team_id   := v_assigned_team_id;
  v_routing_chosen_user_id   := v_assigned_user_id;
  v_routing_chosen_vendor_id := v_assigned_vendor_id;

  insert into public.routing_decisions (
    tenant_id, ticket_id,
    entity_kind, case_id, work_order_id,
    strategy, chosen_team_id, chosen_user_id, chosen_vendor_id,
    chosen_by, rule_id, trace, context
  ) values (
    p_tenant_id,
    v_child_id,
    'work_order',
    null,
    v_child_id,
    v_routing_strategy,
    v_routing_chosen_team_id,
    v_routing_chosen_user_id,
    v_routing_chosen_vendor_id,
    coalesce(v_routing_chosen_by, 'manual'),
    v_routing_rule_id,
    v_routing_trace,
    v_routing_context
  );

  -- ── 11. SLA timers (when v_sla_id non-null) ──────────────────────────
  -- TS layer pre-computes the business-hours-adjusted due_at per timer
  -- (mirrors SlaService.buildTimersForRpc — sla.service.ts:150-256) and
  -- passes the array as payload.timers. The RPC inserts the rows + mirrors
  -- the due_at onto the work_orders row's sla_response_due_at /
  -- sla_resolution_due_at columns (parity with sla.service.ts:101-103 +
  -- :118-120).
  --
  -- Absence semantics: payload.timers absent OR empty AND v_sla_id is
  -- null → no work to do. v_sla_id non-null AND timers absent/empty is a
  -- programmer error (TS skipped its responsibility) — surface as a
  -- generic raise (no registered code; clients map to 500). Same rationale
  -- as 00330:200-205 (update_entity_sla.timers_required).
  if v_sla_id is not null then
    if not (p_payload ? 'timers') or jsonb_typeof(p_payload->'timers') <> 'array'
       or jsonb_array_length(p_payload->'timers') = 0 then
      raise exception 'dispatch_child_work_order.timers_required: sla_id is non-null but timers array is missing or empty'
        using errcode = 'P0001';
    end if;

    for v_timer in select * from jsonb_array_elements(p_payload->'timers') loop
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

    -- Mirror due_at columns on the work_order row.
    update public.work_orders
       set sla_response_due_at   = coalesce(v_sla_response_due,   sla_response_due_at),
           sla_resolution_due_at = coalesce(v_sla_resolution_due, sla_resolution_due_at),
           updated_at            = now()
     where id = v_child_id and tenant_id = p_tenant_id;
  end if;

  -- ── 12. Resolve actor_person_id (for parent activity row) ────────────
  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 13. INSERT activity row on the PARENT ────────────────────────────
  -- Mirror dispatch.service.ts:271-282. Visibility='system' (not
  -- requester-visible); metadata captures the child id + assignment +
  -- sla snapshot so the operator timeline shows the dispatch decision.
  insert into public.ticket_activities (
    tenant_id, ticket_id,
    activity_type, author_person_id, visibility, metadata
  ) values (
    p_tenant_id,
    p_parent_id,
    'system_event',
    v_actor_person_id,
    'system',
    jsonb_build_object(
      'event',              'dispatched',
      'child_id',           v_child_id,
      'assigned_team_id',   v_assigned_team_id,
      'assigned_user_id',   v_assigned_user_id,
      'assigned_vendor_id', v_assigned_vendor_id,
      'sla_id',             v_sla_id
    )
  );

  -- ── 14. Assemble result + mark command_operations success ────────────
  v_result := jsonb_build_object(
    'child_id',           v_child_id,
    'parent_id',          p_parent_id,
    'tenant_id',          p_tenant_id,
    'status',             v_status,
    'status_category',    v_status_category,
    'assigned_team_id',   v_assigned_team_id,
    'assigned_user_id',   v_assigned_user_id,
    'assigned_vendor_id', v_assigned_vendor_id,
    'sla_id',             v_sla_id,
    'routing_chosen_by',  v_routing_chosen_by,
    'noop',               false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.dispatch_child_work_order(uuid, uuid, uuid, text, jsonb) from public;
grant  execute on function public.dispatch_child_work_order(uuid, uuid, uuid, text, jsonb) to service_role;

comment on function public.dispatch_child_work_order(uuid, uuid, uuid, text, jsonb) is
  'Atomic single-tx dispatch of a child work_order from a parent case. Replaces the legacy multi-step DispatchService.dispatch (apps/api/src/modules/ticket/dispatch.service.ts:43-288) which fanned out 5 separate supabase-js writes (work_orders INSERT + routing_decisions INSERT + sla_timers INSERT + work_orders UPDATE sla_*_due_at + ticket_activities INSERT on parent) and could partial-commit on any mid-sequence failure (every dropped write was severity:critical per §1.15). Atomicity: one tx; one RAISE rolls everything back. Idempotency: command_operations gate on (tenant_id, idempotency_key); deterministic child_id (TS-minted uuidv5) makes retry the same row. Validation: validate_assignees_in_tenant (00317) + validate_entity_in_tenant (00321) server-side defense-in-depth. Parent gates: tenant-scoped lookup + status_category not in pending_approval/resolved/closed. Result: {child_id, parent_id, tenant_id, status, status_category, assigned_*_id, sla_id, routing_chosen_by, noop}. Spec: docs/follow-ups/b2-survey-and-design.md §3.4.';

notify pgrst, 'reload schema';
