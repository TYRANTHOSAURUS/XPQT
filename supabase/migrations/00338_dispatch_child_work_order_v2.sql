-- B.2.A.Step8 — dispatch_child_work_order RPC (§3.4 single) — v2.
--
-- Spec:        docs/follow-ups/b2-survey-and-design.md §3.4.
-- Replaces:    00336 (v1).
-- Companion:   00339 (batch v2).
--
-- ── What this revision fixes ────────────────────────────────────────────
--
-- 1. **Polymorphic sla_timers columns set on insert** (F-CRIT-1).
--    Migration 00227 added (entity_kind, case_id, work_order_id) to
--    sla_timers as the canonical address scheme for entity-aware reads.
--    The v1 RPC INSERTed timers WITHOUT setting these columns. The
--    backfill in 00227:24-31 only touched rows that existed at that
--    migration's time — new rows inserted by 00336 / 00337 had NULL
--    polymorphic columns, so any read filtering by
--    `entity_kind = 'work_order' AND work_order_id = X` missed those
--    timers (silent read-side regression). 00330:259-277 (the canonical
--    sla_timers INSERT in update_entity_sla v3) DOES populate them; we
--    mirror that shape exactly here.
--
-- 2. **Unreachable coalesce arm dropped** (F-IMP-7). The v1 INSERT used
--    `coalesce(v_priority, v_parent.priority, 'medium')`. `tickets.priority`
--    is `NOT NULL DEFAULT 'medium'` (00011:14) so `v_parent.priority` is
--    never null — the third coalesce arg is unreachable. Drop to
--    `coalesce(v_priority, v_parent.priority)`.
--
-- 3. **routing_trace embedded ids — documented limitation.** The trace's
--    schema (apps/api/src/modules/routing/resolver.types.ts:87-92) is
--    `{ step, matched, reason, target: AssignmentTarget | null }`. The
--    only embedded ids are the per-step `target.team_id|user_id|vendor_id`
--    on matched steps and the chosen one ends up in the work_orders row's
--    assigned_*_id columns (already validated via
--    validate_assignees_in_tenant). Intermediate-step trace targets that
--    aren't the final pick are audit-only — they describe what the
--    resolver considered, not what it wrote. Top-level routing_rule_id +
--    chosen_*_id are the authoritative tenant-scoped ids and are
--    validated. Trace is stored verbatim (audit-only); embedded ids are
--    NOT re-validated.
--
-- Schema-cache reload at the bottom so PostgREST picks up the new body.

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

  v_routing_chosen_team_id   uuid;
  v_routing_chosen_user_id   uuid;
  v_routing_chosen_vendor_id uuid;

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
  -- public.tickets is the case table post step1c.10c; the parent_not_case
  -- branch is unreachable here. The error code was dropped from the
  -- registry alongside this v2 (see error-codes.ts + messages.{en,nl}.ts).
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

  -- ── 8. status_category inheritance ───────────────────────────────────
  v_any_assignee := (v_assigned_team_id is not null or v_assigned_user_id is not null or v_assigned_vendor_id is not null);
  v_status          := 'new';
  v_status_category := case when v_any_assignee then 'assigned' else 'new' end;

  -- ── 9. INSERT child work_order ───────────────────────────────────────
  -- F-IMP-7: priority defaults to v_parent.priority (NOT NULL DEFAULT
  -- 'medium' at 00011:14) so the third coalesce arg is unreachable —
  -- dropped.
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
    coalesce(v_priority, v_parent.priority),
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
  -- F-CRIT-1: set polymorphic (entity_kind, case_id, work_order_id) +
  -- started_at columns on every insert. Mirrors 00330:259-277 exactly so
  -- entity-aware reads (00227's idx_sla_timers_work_order_id index +
  -- any caller filtering `where entity_kind='work_order' and
  -- work_order_id=X`) hit dispatch-emitted rows.
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

      insert into public.sla_timers (
        tenant_id, ticket_id, sla_policy_id, timer_type,
        target_minutes, due_at, business_hours_calendar_id,
        paused, recompute_pending,
        entity_kind, case_id, work_order_id, started_at
      ) values (
        p_tenant_id, v_child_id, v_sla_id, v_timer_type,
        v_timer_target_minutes, v_timer_due_at, v_timer_calendar_id,
        false, false,
        'work_order', null, v_child_id, now()
      );

      if v_timer_type = 'response'   then v_sla_response_due   := v_timer_due_at; end if;
      if v_timer_type = 'resolution' then v_sla_resolution_due := v_timer_due_at; end if;
    end loop;

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
  'v2 (00338) — Atomic single-tx dispatch of a child work_order from a parent case. Fixes F-CRIT-1 (sla_timers polymorphic columns now populated; mirrors 00330:259-277) + F-IMP-7 (drops unreachable coalesce arm; tickets.priority is NOT NULL DEFAULT). routing_trace embedded ids are audit-only and not re-validated — top-level routing_rule_id + chosen_*_id are authoritative and validated via validate_assignees_in_tenant. Spec: docs/follow-ups/b2-survey-and-design.md §3.4.';

notify pgrst, 'reload schema';
