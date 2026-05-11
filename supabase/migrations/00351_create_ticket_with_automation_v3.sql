-- B.2.A.Step12 codex-S12-I1 remediation — create_ticket_with_automation v3.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.11 (lines 2793-3034).
-- Builds on: 00350_create_ticket_with_automation_v2.sql.
--
-- ── Why v3 ──────────────────────────────────────────────────────────────
--
-- F-IMP-1 (codex-S12-I1) — concurrent-edit detection was too broad.
--
-- Pre-v3 (00350_create_ticket_with_automation_v2.sql:349-358) the
-- concurrent-edit gate exempted EVERY row in `request_type_scope_overrides`
-- whose `updated_at > _resolution_at` for the request type. An admin
-- editing an UNRELATED override (different scope, different space_group,
-- different building) for the same request_type would silently mask a
-- legitimately stale plan elsewhere — the gate would let any semantic
-- mismatch through with `concurrent_override_edit = true` because *some*
-- override on this request type happened to move.
--
-- v3 narrows the check to the specific row PG actually derived from. Two
-- shapes are now handled symmetrically:
--
--   (a) PG derived a winning override (`v_override` not null).
--       Check ONLY that row's `updated_at`. If it post-dates the TS
--       plan's `_resolution_at`, this is a legitimate concurrent edit on
--       the SAME row TS would have seen. PG wins.
--
--   (b) PG derived no winning override, but the TS plan named one
--       (`p_automation_plan.scope_override_id` not null).
--       Asymmetric: TS saw an override, PG sees none. Check whether
--       the TS-named override row was edited or DELETED after TS
--       resolved. Either condition (post-`_resolution_at` updated_at,
--       OR the row no longer exists) counts as concurrent edit.
--
-- Unrelated overrides — different scope, different building, different
-- request_type — never trip the gate.
--
-- The workflow + SLA + scope_override mismatch raises in step 5d are
-- unchanged. Only the trigger that flips `v_concurrent_override_edit` is
-- tightened. The force_workflow_definition_id escape hatch from v2
-- remains untouched.
--
-- Other 00349/00350 behavior is preserved verbatim.

create or replace function public.create_ticket_with_automation(
  p_input            jsonb,
  p_automation_plan  jsonb,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox, pg_catalog
as $$
declare
  v_existing            public.command_operations;
  v_payload_hash        text;
  v_lock_key            bigint;

  -- p_input fields
  v_ticket_id            uuid;
  v_request_type_id      uuid;
  v_requester_person_id  uuid;
  v_title                text;
  v_description          text;
  v_priority             text;
  v_impact               text;
  v_urgency              text;
  v_location_id          uuid;
  v_asset_id             uuid;
  v_parent_ticket_id     uuid;
  v_assigned_team_id     uuid;
  v_assigned_user_id     uuid;
  v_assigned_vendor_id   uuid;
  v_watchers             uuid[];
  v_source_channel       text;
  v_interaction_mode     text;
  v_form_data            jsonb;
  v_external_system      text;
  v_external_id          text;
  v_requested_for_person_id uuid;
  v_force_workflow_definition_id uuid;

  -- p_automation_plan fields
  v_plan_effective_location_id     uuid;
  v_plan_scope_override_id         uuid;
  v_plan_workflow_definition_id    uuid;
  v_plan_sla_policy_id             uuid;
  v_plan_routing_decision          jsonb;
  v_plan_routing_trace             jsonb;
  v_plan_resolution_at             timestamptz;

  -- request_types (FOR SHARE)
  v_request_type        record;

  -- PG-side re-derived
  v_derived_location_id            uuid;
  v_derived_override               jsonb;
  v_derived_override_id            uuid;
  v_derived_workflow_definition_id uuid;
  v_derived_sla_policy_id          uuid;
  v_concurrent_override_edit       boolean := false;
  v_request_type_default_workflow_id uuid;

  -- v3 / codex-S12-I1: row-scoped concurrent-edit detection.
  v_winning_override_updated_at    timestamptz;

  -- INSERT helpers
  v_status              text;
  v_status_category     text;
  v_final_team_id       uuid;
  v_final_user_id       uuid;
  v_final_vendor_id     uuid;
  v_ticket_row          public.tickets;

  -- Routing trace assertion
  v_routing_chosen_by   text;
  v_routing_trace_input jsonb;

  -- Activity actor + result
  v_actor_person_id     uuid;
  v_actor_users_id      uuid;  -- F-CRIT-1: resolved users.id (PK) for domain_events FK.
  v_follow_ups          text[] := '{}';
  v_result              jsonb;
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'create_ticket_with_automation: p_tenant_id required';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'create_ticket_with_automation.input_invalid: p_input must be a jsonb object'
      using errcode = 'P0001';
  end if;
  if p_automation_plan is null or jsonb_typeof(p_automation_plan) <> 'object' then
    raise exception 'create_ticket_with_automation.input_invalid: p_automation_plan must be a jsonb object'
      using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'create_ticket_with_automation: p_idempotency_key required';
  end if;

  -- ── 1. Advisory lock + command_operations idempotency gate (00316) ─────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  v_payload_hash := md5(
    coalesce(p_input::text, '') || '|' || coalesce(p_automation_plan::text, '')
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

  -- ── 2. Parse p_input + p_automation_plan ────────────────────────────────
  v_ticket_id              := nullif(p_input->>'ticket_id', '')::uuid;
  v_request_type_id        := nullif(p_input->>'request_type_id', '')::uuid;
  v_requester_person_id    := nullif(p_input->>'requester_person_id', '')::uuid;
  v_requested_for_person_id:= nullif(p_input->>'requested_for_person_id', '')::uuid;
  v_title                  := p_input->>'title';
  v_description            := p_input->>'description';
  v_priority               := coalesce(p_input->>'priority', 'medium');
  v_impact                 := p_input->>'impact';
  v_urgency                := p_input->>'urgency';
  v_location_id            := nullif(p_input->>'location_id', '')::uuid;
  v_asset_id               := nullif(p_input->>'asset_id', '')::uuid;
  v_parent_ticket_id       := nullif(p_input->>'parent_ticket_id', '')::uuid;
  v_assigned_team_id       := nullif(p_input->>'assigned_team_id', '')::uuid;
  v_assigned_user_id       := nullif(p_input->>'assigned_user_id', '')::uuid;
  v_assigned_vendor_id     := nullif(p_input->>'assigned_vendor_id', '')::uuid;
  v_source_channel         := coalesce(p_input->>'source_channel', 'portal');
  v_interaction_mode       := coalesce(p_input->>'interaction_mode', 'internal');
  v_form_data              := case
                                when p_input ? 'form_data'
                                  and jsonb_typeof(p_input->'form_data') = 'object'
                                  then p_input->'form_data'
                                else null
                              end;
  v_external_system        := p_input->>'external_system';
  v_external_id            := p_input->>'external_id';

  -- F-CRIT-2 / Option B: workflow-override escape hatch for webhook ingest.
  -- Optional; null = no override (default semantic re-derivation).
  v_force_workflow_definition_id := nullif(p_input->>'force_workflow_definition_id', '')::uuid;

  -- watchers — string[] of uuids per ticket.service.ts:76 contract
  if p_input ? 'watchers' and jsonb_typeof(p_input->'watchers') = 'array' then
    select coalesce(array_agg((w)::uuid), '{}'::uuid[])
      into v_watchers
      from jsonb_array_elements_text(p_input->'watchers') w;
  else
    v_watchers := '{}'::uuid[];
  end if;

  if v_ticket_id is null then
    raise exception 'create_ticket_with_automation.input_invalid: p_input.ticket_id required (TS pre-mints via uuidv5)'
      using errcode = 'P0001';
  end if;
  if v_request_type_id is null then
    raise exception 'create_ticket_with_automation.input_invalid: p_input.request_type_id required'
      using errcode = 'P0001';
  end if;
  if v_requester_person_id is null then
    raise exception 'create_ticket_with_automation.input_invalid: p_input.requester_person_id required'
      using errcode = 'P0001';
  end if;
  if v_title is null or length(v_title) = 0 then
    raise exception 'create_ticket_with_automation.input_invalid: p_input.title required'
      using errcode = 'P0001';
  end if;

  -- requested_for defaults to requester
  if v_requested_for_person_id is null then
    v_requested_for_person_id := v_requester_person_id;
  end if;

  -- Plan
  v_plan_effective_location_id  := nullif(p_automation_plan->>'effective_location_id', '')::uuid;
  v_plan_scope_override_id      := nullif(p_automation_plan->>'scope_override_id', '')::uuid;
  v_plan_workflow_definition_id := nullif(p_automation_plan->>'effective_workflow_definition_id', '')::uuid;
  v_plan_sla_policy_id          := nullif(p_automation_plan->>'effective_sla_policy_id', '')::uuid;
  v_plan_resolution_at          := nullif(p_automation_plan->>'_resolution_at', '')::timestamptz;

  if p_automation_plan ? 'routing_decision'
     and jsonb_typeof(p_automation_plan->'routing_decision') = 'object' then
    v_plan_routing_decision := p_automation_plan->'routing_decision';
  else
    v_plan_routing_decision := null;
  end if;

  if p_automation_plan ? 'routing_trace'
     and jsonb_typeof(p_automation_plan->'routing_trace') = 'object' then
    v_plan_routing_trace := p_automation_plan->'routing_trace';
  else
    v_plan_routing_trace := null;
  end if;

  -- ── 3. Tenant validation for every FK ───────────────────────────────────
  --
  -- v9 / C-C-C1: person/case/asset/space/request_type/scope_override/
  -- workflow_definition/sla_policy via validate_entity_in_tenant (00340).
  -- Assignees via validate_assignees_in_tenant (00317).
  perform public.validate_entity_in_tenant(p_tenant_id, 'request_type', v_request_type_id);
  perform public.validate_entity_in_tenant(p_tenant_id, 'person', v_requester_person_id);
  if v_requested_for_person_id is not null and v_requested_for_person_id <> v_requester_person_id then
    perform public.validate_entity_in_tenant(p_tenant_id, 'person', v_requested_for_person_id);
  end if;
  if v_parent_ticket_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'case', v_parent_ticket_id);
  end if;
  if v_asset_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'asset', v_asset_id);
  end if;
  if v_location_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'space', v_location_id);
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
  -- F-CRIT-2 / Option B: tenant-validate the forced workflow id too.
  if v_force_workflow_definition_id is not null then
    perform public.validate_entity_in_tenant(p_tenant_id, 'workflow_definition', v_force_workflow_definition_id);
  end if;
  -- Assignees (each non-null)
  perform public.validate_assignees_in_tenant(
    p_tenant_id,
    v_assigned_team_id,
    v_assigned_user_id,
    v_assigned_vendor_id
  );

  -- ── 4. SELECT request_types FOR SHARE (v8 / I1 ordering — before step 5) ─
  select rt.requires_approval, rt.workflow_definition_id, rt.sla_policy_id,
         rt.approval_approver_person_id, rt.approval_approver_team_id, rt.active
    into v_request_type
    from public.request_types rt
   where rt.id = v_request_type_id and rt.tenant_id = p_tenant_id
   for share;

  if not found or not coalesce(v_request_type.active, false) then
    raise exception 'create_ticket_with_automation.request_type_not_found: id=% inactive_or_missing', v_request_type_id
      using errcode = 'P0002';
  end if;

  -- Capture for force-workflow breadcrumb (F-CRIT-2 / Option B).
  v_request_type_default_workflow_id := v_request_type.workflow_definition_id;

  -- ── 5. Semantic re-derivation (v6 / I2; v8 / I1 ordering) ───────────────
  --
  -- 5a. Effective location.
  -- Mirror scope-override-resolver.service.ts:111-125.
  v_derived_location_id := coalesce(
    v_location_id,
    case when v_asset_id is not null then (
      select assigned_space_id from public.assets
       where id = v_asset_id and tenant_id = p_tenant_id
    ) else null end
  );

  if v_derived_location_id is distinct from v_plan_effective_location_id then
    raise exception 'automation_plan.effective_location_mismatch: derived=% plan=%',
      coalesce(v_derived_location_id::text, '<null>'),
      coalesce(v_plan_effective_location_id::text, '<null>')
      using errcode = 'P0001';
  end if;

  -- 5b. Effective workflow + SLA via existing PG function (00096).
  v_derived_override := public.request_type_effective_scope_override(
    p_tenant_id, v_request_type_id, v_derived_location_id
  );
  v_derived_override_id := nullif(v_derived_override->>'id', '')::uuid;
  v_derived_workflow_definition_id := coalesce(
    nullif(v_derived_override->>'workflow_definition_id', '')::uuid,
    v_request_type.workflow_definition_id
  );
  v_derived_sla_policy_id := coalesce(
    nullif(v_derived_override->>'case_sla_policy_id', '')::uuid,
    v_request_type.sla_policy_id
  );

  -- 5c. Concurrent-edit detection (v10 / C4 ; v3 / codex-S12-I1 tightening).
  --
  -- Pre-v3: the check exempted ANY row in request_type_scope_overrides for
  -- this request_type with updated_at > _resolution_at, so an unrelated
  -- override edit (different scope) could silently mask a stale plan.
  --
  -- v3 narrows to the SPECIFIC override row PG derived from:
  --
  --   (a) PG derived a winning override (v_derived_override not null):
  --       check that row's updated_at.
  --   (b) PG derived NO override but TS named one: check the TS-named row.
  --       Edited (updated_at > _resolution_at) OR deleted (null) → concurrent.
  --
  -- Unrelated overrides never trip the gate.
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

  -- 5d. Reject if mismatch + NOT a concurrent edit.
  --
  -- F-CRIT-2 / Option B: when force_workflow_definition_id is non-null,
  -- SKIP the workflow mismatch gate entirely. The caller is asserting it
  -- wants a specific workflow regardless of request-type config; the SLA
  -- + override gates still fire normally.
  if v_force_workflow_definition_id is null
     and v_derived_workflow_definition_id is distinct from v_plan_workflow_definition_id
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

  -- 5e. Routing trace input check (if plan has a routing decision).
  if v_plan_routing_decision is not null and v_plan_routing_trace is not null then
    v_routing_trace_input := v_plan_routing_trace->'input';
    if v_routing_trace_input is not null then
      if nullif(v_routing_trace_input->>'request_type_id', '')::uuid is distinct from v_request_type_id
         or nullif(v_routing_trace_input->>'location_id', '')::uuid is distinct from v_derived_location_id
         or nullif(v_routing_trace_input->>'asset_id', '')::uuid is distinct from v_asset_id then
        raise exception 'automation_plan.routing_input_mismatch: trace.input does not match (request_type=%, location=%, asset=%)',
          v_request_type_id, v_derived_location_id, v_asset_id
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- 5f. Force-workflow override (F-CRIT-2 / Option B).
  -- After the gate, REPLACE the derived workflow id with the forced value.
  -- This is what gets written to tickets.workflow_id + the outbox payload
  -- so the workflow.start_required handler picks the right workflow.
  if v_force_workflow_definition_id is not null then
    v_derived_workflow_definition_id := v_force_workflow_definition_id;
  end if;

  -- ── 6. Compute status + final assignees ────────────────────────────────
  if v_request_type.requires_approval = true
     and (v_request_type.approval_approver_person_id is not null
          or v_request_type.approval_approver_team_id is not null) then
    v_status := 'awaiting_approval';
    v_status_category := 'pending_approval';
  else
    v_status := 'new';
    v_status_category := 'new';
  end if;

  -- Caller assignee wins; else routing-decision target; else null.
  v_final_team_id   := v_assigned_team_id;
  v_final_user_id   := v_assigned_user_id;
  v_final_vendor_id := v_assigned_vendor_id;
  if v_final_team_id is null and v_final_user_id is null and v_final_vendor_id is null
     and v_plan_routing_decision is not null then
    v_final_team_id   := nullif(v_plan_routing_decision->>'team_id', '')::uuid;
    v_final_user_id   := nullif(v_plan_routing_decision->>'user_id', '')::uuid;
    v_final_vendor_id := nullif(v_plan_routing_decision->>'vendor_id', '')::uuid;
    -- Validate routing-decision-derived assignees too (defense-in-depth).
    perform public.validate_assignees_in_tenant(
      p_tenant_id, v_final_team_id, v_final_user_id, v_final_vendor_id
    );
  end if;

  -- ── 7. INSERT into tickets with pre-minted id ──────────────────────────
  --
  -- v8 / I2 column-name mapping: ticket_type_id ← request_type_id;
  -- workflow_id ← effective workflow; sla_id ← effective sla.
  insert into public.tickets (
    id, tenant_id, ticket_type_id, parent_ticket_id,
    title, description, priority, impact, urgency,
    requester_person_id, requested_for_person_id,
    location_id, asset_id,
    assigned_team_id, assigned_user_id, assigned_vendor_id,
    workflow_id, sla_id,
    status, status_category,
    interaction_mode, source_channel,
    form_data,
    watchers,
    external_system, external_id
  ) values (
    v_ticket_id, p_tenant_id, v_request_type_id, v_parent_ticket_id,
    v_title, v_description, v_priority, v_impact, v_urgency,
    v_requester_person_id, v_requested_for_person_id,
    v_derived_location_id, v_asset_id,
    v_final_team_id, v_final_user_id, v_final_vendor_id,
    v_derived_workflow_definition_id, v_derived_sla_policy_id,
    v_status, v_status_category,
    v_interaction_mode, v_source_channel,
    v_form_data,
    coalesce(v_watchers, '{}'::uuid[]),
    v_external_system, v_external_id
  )
  returning * into v_ticket_row;

  -- ── 8. Routing record (sync, v4 / C1; v5 / I4 unassigned) ──────────────
  --
  -- If caller provided an assignee, skip routing entirely. Else, if the
  -- plan has a routing_decision, write the row (including unassigned).
  if v_assigned_team_id is null
     and v_assigned_user_id is null
     and v_assigned_vendor_id is null
     and v_plan_routing_decision is not null then
    v_routing_chosen_by := coalesce(v_plan_routing_decision->>'chosen_by', 'unassigned');
    insert into public.routing_decisions (
      tenant_id, ticket_id, strategy,
      chosen_team_id, chosen_user_id, chosen_vendor_id,
      chosen_by, rule_id, trace, context
    ) values (
      p_tenant_id, v_ticket_id,
      coalesce(v_plan_routing_decision->>'strategy', v_routing_chosen_by),
      v_final_team_id, v_final_user_id, v_final_vendor_id,
      v_routing_chosen_by,
      nullif(v_plan_routing_decision->>'rule_id', '')::uuid,
      coalesce(v_plan_routing_trace->'trace', '[]'::jsonb),
      jsonb_build_object(
        'request_type_id', v_request_type_id,
        'asset_id',        v_asset_id,
        'location_id',     v_derived_location_id,
        'priority',        v_priority
      )
    );
  end if;

  -- ── 9. Resolve actor IDs for ticket_activities + domain_events ─────────
  --
  -- F-CRIT-1: `p_actor_user_id` is the Supabase auth UID (`users.auth_uid`).
  -- `domain_events.actor_user_id` is FK to `users.id` (00019:11). Resolve
  -- once here via the lookup; reuse `v_actor_users_id` for both
  -- domain_events INSERTs in steps 11 + 12a.
  if p_actor_user_id is not null then
    select u.id, u.person_id
      into v_actor_users_id, v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid = p_actor_user_id
     limit 1;
  end if;

  -- ── 10. INSERT ticket_activities (ticket_created) ──────────────────────
  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
  values (
    p_tenant_id, v_ticket_id, 'system_event', v_actor_person_id, 'system',
    jsonb_build_object('event', 'ticket_created')
  );

  -- 10b. Concurrent-edit breadcrumb (v10 / C4).
  if v_concurrent_override_edit then
    insert into public.ticket_activities
      (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
    values (
      p_tenant_id, v_ticket_id, 'system_event', v_actor_person_id, 'system',
      jsonb_build_object(
        'event', 'automation_plan_overridden_by_concurrent_edit',
        'plan_workflow_definition_id', v_plan_workflow_definition_id,
        'derived_workflow_definition_id', v_derived_workflow_definition_id,
        'plan_sla_policy_id', v_plan_sla_policy_id,
        'derived_sla_policy_id', v_derived_sla_policy_id,
        'plan_scope_override_id', v_plan_scope_override_id,
        'derived_scope_override_id', v_derived_override_id
      )
    );
  end if;

  -- 10c. Force-workflow breadcrumb (F-CRIT-2 / Option B).
  if v_force_workflow_definition_id is not null then
    insert into public.ticket_activities
      (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
    values (
      p_tenant_id, v_ticket_id, 'system_event', v_actor_person_id, 'system',
      jsonb_build_object(
        'event', 'workflow_forced_by_caller',
        'caller_value', v_force_workflow_definition_id,
        'request_type_default', v_request_type_default_workflow_id
      )
    );
  end if;

  -- ── 11. INSERT domain_events (ticket_created) ──────────────────────────
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id, 'ticket_created', 'ticket', v_ticket_id,
    jsonb_build_object(
      'ticket_id', v_ticket_id,
      'request_type_id', v_request_type_id,
      'workflow_id', v_derived_workflow_definition_id,
      'sla_id', v_derived_sla_policy_id,
      'location_id', v_derived_location_id,
      'requires_approval', (v_status_category = 'pending_approval')
    ),
    v_actor_users_id  -- F-CRIT-1: users.id (PK), not auth_uid.
  );

  -- ── 12. Branch on requires_approval ────────────────────────────────────
  if v_status_category = 'pending_approval' then
    -- 12a. INSERT approvals row.
    -- approvals schema per 00012 — target_entity_type='ticket'.
    insert into public.approvals (
      tenant_id, target_entity_type, target_entity_id,
      approver_person_id, approver_team_id,
      status
    ) values (
      p_tenant_id, 'ticket', v_ticket_id,
      v_request_type.approval_approver_person_id,
      v_request_type.approval_approver_team_id,
      'pending'
    );

    insert into public.domain_events
      (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    values (
      p_tenant_id, 'approval_requested', 'ticket', v_ticket_id,
      jsonb_build_object('ticket_id', v_ticket_id),
      v_actor_users_id  -- F-CRIT-1: users.id (PK), not auth_uid.
    );

    insert into public.ticket_activities
      (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
    values (
      p_tenant_id, v_ticket_id, 'system_event', v_actor_person_id, 'system',
      jsonb_build_object('event', 'approval_requested')
    );

    -- NO SLA timers, NO workflow start. Those land at grant time via
    -- §3.5 grant_ticket_approval (a future B.2 RPC).
  else
    -- 12b. No-approval branch — emit outbox events atomically.
    --
    -- v9 / P-I2: started_at = ticket.created_at on the create path
    -- (SLA clock = when customer asked).
    if v_derived_sla_policy_id is not null then
      perform outbox.emit(
        p_tenant_id,
        'sla.timer_recompute_required',
        'ticket',
        v_ticket_id,
        jsonb_build_object(
          'tenant_id', p_tenant_id,
          'ticket_id', v_ticket_id,
          'sla_policy_id', v_derived_sla_policy_id,
          'started_at', v_ticket_row.created_at
        ),
        'sla.timer_recompute_required:' || v_ticket_id::text || ':create',
        1,
        null
      );
      v_follow_ups := array_append(v_follow_ups, 'sla.timer_recompute_required');
    end if;

    if v_derived_workflow_definition_id is not null then
      perform outbox.emit(
        p_tenant_id,
        'workflow.start_required',
        'ticket',
        v_ticket_id,
        jsonb_build_object(
          'tenant_id', p_tenant_id,
          'ticket_id', v_ticket_id,
          'workflow_definition_id', v_derived_workflow_definition_id
        ),
        'workflow.start_required:' || v_ticket_id::text || ':create',
        1,
        null
      );
      v_follow_ups := array_append(v_follow_ups, 'workflow.start_required');
    end if;
  end if;

  if v_status_category = 'pending_approval' then
    v_follow_ups := array_append(v_follow_ups, 'approval');
  elsif v_plan_routing_decision is not null
        and v_assigned_team_id is null
        and v_assigned_user_id is null
        and v_assigned_vendor_id is null then
    v_follow_ups := array_append(v_follow_ups, 'routing');
  end if;

  -- ── 13. Mark command_operations success + return ───────────────────────
  v_result := jsonb_build_object(
    'ticket',     to_jsonb(v_ticket_row),
    'follow_ups', to_jsonb(v_follow_ups),
    'concurrent_override_edit', v_concurrent_override_edit
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.create_ticket_with_automation(jsonb, jsonb, uuid, uuid, text) from public;
grant  execute on function public.create_ticket_with_automation(jsonb, jsonb, uuid, uuid, text) to service_role;

comment on function public.create_ticket_with_automation(jsonb, jsonb, uuid, uuid, text) is
  'B.2.A.Step12 §3.11 v3 — atomic ticket create + automation. v3 / codex-S12-I1: concurrent-edit detection narrowed from any-row-on-request-type to the SPECIFIC override row PG derived from (or the TS-named row when PG derives no override). Unrelated overrides on the same request_type no longer mask a stale plan. F-CRIT-1 + F-CRIT-2 behavior from v2 preserved.';

notify pgrst, 'reload schema';
