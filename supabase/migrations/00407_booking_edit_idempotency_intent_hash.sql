-- Booking-audit remediation Slice 1 — idempotency hash determinism.
--
-- P0 (verified + scoped by the booking-audit codex idempotency review):
-- `edit_booking` and `edit_booking_scope` computed the
-- command_operations idempotency hash as md5 over the WHOLE plan text
-- (`md5(coalesce(p_plan::text,''))` / `md5(coalesce(p_plans::text,''))`).
-- The plan carries retry-unstable content (the server-stamped
-- `_resolution_at` instant, plus several audit-snapshot / id-keyed
-- arrays whose source-row order is non-deterministic). The same logical
-- edit, retried under the same idempotency key, hashed differently →
-- spurious `command_operations.payload_mismatch` 409 on a legitimate
-- replay. Scope is booking-edit-only — the create / grant RPCs were
-- verified unaffected (they do not stamp `_resolution_at` and hash
-- their own canonical inputs).
--
-- Fix has two halves:
--   1. SQL: a deterministic hash helper that strips server-stamped
--      `_`-prefixed fields (currently only `_resolution_at`) before
--      hashing, recursing through objects/arrays. `edit_booking` and
--      `edit_booking_scope` route their existing single hash line
--      through it. Every other byte of both function bodies is
--      reproduced verbatim from 00394 / 00399 (create-or-replace; the
--      prior migrations are NOT edited in place — forward-only).
--   2. Producer: assemble-edit-plan.service.ts canonicalises the 6
--      retry-unstable arrays the strip helper does NOT cover (they are
--      not `_`-prefixed) so the plan is byte-stable across retries.
--
-- Citations (every line reproduced below was Read in this session):
--   - supabase/migrations/00394_edit_booking_rpc_v5.sql:89-1073 —
--     edit_booking v5 full body + revoke/grant/comment/notify trailer.
--   - supabase/migrations/00399_edit_booking_scope_lift_b4a5_gate.sql
--     :20-1145 — edit_booking_scope full body + comment trailer.
--   - The ONLY byte changed inside each function body is its single
--     `v_payload_hash := md5(...)` assignment (00394:310 / 00399:200),
--     re-pointed to public.booking_edit_idempotency_payload_hash(...).
--
-- Pattern: create-or-replace, no drop-cascade on the helpers. The
-- edit_booking `drop function if exists` is reproduced verbatim from
-- 00394:87 (its signature is unchanged, so the drop is a no-op safety
-- net exactly as in v5). edit_booking_scope keeps the create-or-replace
-- (no-drop) pattern from 00399.

-- ── 1. Deterministic idempotency-hash helpers ───────────────────────
--
-- booking_edit_strip_hash_server_fields recursively removes any object
-- key in the exclusion set ('_resolution_at') at every nesting depth,
-- preserving array order (jsonb arrays are ordered; the producer is
-- responsible for canonicalising the *content* order of audit-snapshot
-- / id-keyed arrays — see assemble-edit-plan.service.ts). The runnable
-- guard in assemble-edit-plan.idempotency.spec.ts statically asserts
-- every `_`-prefixed EditPlan field is present in the exclusion list
-- below, so a future `_`-prefixed field cannot be added without
-- updating this set.

create or replace function public.booking_edit_strip_hash_server_fields(p_value jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case jsonb_typeof(p_value)
    when 'object' then (
      select coalesce(jsonb_object_agg(key, public.booking_edit_strip_hash_server_fields(value)), '{}'::jsonb)
      from jsonb_each(p_value)
      where key not in ('_resolution_at')
    )
    when 'array' then (
      select coalesce(jsonb_agg(public.booking_edit_strip_hash_server_fields(value) order by ord), '[]'::jsonb)
      from jsonb_array_elements(p_value) with ordinality as e(value, ord)
    )
    else p_value
  end
$$;

create or replace function public.booking_edit_idempotency_payload_hash(p_payload jsonb)
returns text language sql immutable set search_path = public as $$
  select md5(coalesce(public.booking_edit_strip_hash_server_fields(p_payload)::text, ''));
$$;

revoke all on function public.booking_edit_strip_hash_server_fields(jsonb) from public;
revoke all on function public.booking_edit_idempotency_payload_hash(jsonb) from public;
grant  execute on function public.booking_edit_strip_hash_server_fields(jsonb) to service_role;
grant  execute on function public.booking_edit_idempotency_payload_hash(jsonb) to service_role;

comment on function public.booking_edit_idempotency_payload_hash(jsonb) is
  'Booking-audit remediation Slice 1 — deterministic command_operations idempotency hash for edit_booking / edit_booking_scope. Strips server-stamped _resolution_at before md5 so a legitimate retry of the same logical edit (re-stamped _resolution_at) hashes identically instead of spuriously raising command_operations.payload_mismatch. The producer (assemble-edit-plan.service.ts) canonicalises the 6 non-_-prefixed retry-unstable arrays; this helper covers the _-prefixed server fields.';

-- ── 2. edit_booking — reproduced VERBATIM from 00394:89-1073 ─────────
--     (single line changed: the v_payload_hash assignment, 00394:310).

drop function if exists public.edit_booking(uuid, jsonb, uuid, uuid, text);

create or replace function public.edit_booking(
  p_booking_id      uuid,
  p_plan            jsonb,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, outbox
as $$
declare
  v_started_at         constant timestamptz := now();

  v_existing           public.command_operations;
  v_payload_hash       text;
  v_lock_key           bigint;

  v_actor_users_id     uuid;

  v_booking            record;

  v_booking_patch      jsonb;
  v_slot_patches       jsonb;
  v_asset_patches      jsonb;
  v_order_patches      jsonb;
  v_wo_patches         jsonb;

  v_slot               jsonb;
  v_asset              jsonb;
  v_order              jsonb;
  v_wo                 jsonb;
  v_rule_id            uuid;

  -- Required (must be present in the booking patch):
  v_new_location_id        uuid;
  v_new_start_at           timestamptz;
  v_new_end_at             timestamptz;
  v_new_cost_snapshot      numeric(10,2);
  v_resolution_at_ts       timestamptz;

  -- Optional (preserve-or-overwrite — computed at write-time below):
  v_new_policy_snapshot    jsonb;
  v_new_applied_rule_ids   uuid[];
  v_new_cost_center_id     uuid;
  v_new_calendar_etag      text;
  v_new_host_person_id     uuid;
  v_new_recurrence_over    boolean;
  v_new_config_release_id  uuid;

  -- Semantic re-derivation gate.
  v_rules_max_updated_at   timestamptz;

  -- Approval reconciliation (§3.6.5).
  v_approval_block         jsonb;
  v_old_outcome            text;
  v_new_outcome            text;
  v_chain_config_changed   boolean;
  v_new_chain_config       jsonb;
  v_approval_state         text;
  v_pending_count          int;
  v_delegated_count        int;
  v_approved_count         int;
  v_rejected_count         int;
  v_action                 text;
  v_status_target          text;
  v_emit_approval_required boolean := false;
  v_new_chain_id           uuid;
  v_parallel_group         text;
  v_threshold              text;
  v_approver               jsonb;
  v_approver_type          text;
  v_approver_id            uuid;
  -- v5 — split arrays for the outbox payload (replaces v4 v_approver_ids).
  -- Self-review remediation: renamed v_approver_user_ids →
  -- v_approver_person_ids because the values are persons.id (sourced from
  -- required_approvers[n].id where type='person'), not users.id. The
  -- handler fans person → user via users.person_id JOIN at dispatch time.
  v_approver_person_ids    uuid[] := '{}'::uuid[];   -- person approvers
  v_approver_team_ids      uuid[] := '{}'::uuid[];   -- team approvers
  v_new_booking_status     text;

  v_audit_before           jsonb;
  v_audit_after            jsonb;

  v_emitted                jsonb := '[]'::jsonb;

  v_result                 jsonb;
  v_row_count              int;
  v_orders_updated         int := 0;
  v_assets_updated         int := 0;
  v_wo_updated             int := 0;
  v_slots_updated          int := 0;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'edit_booking: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'edit_booking: p_booking_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'edit_booking: p_idempotency_key required';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan must be a jsonb object'
      using errcode = 'P0001';
  end if;

  if not (p_plan ? 'booking') or jsonb_typeof(p_plan->'booking') <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking must be a jsonb object'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? 'slot_patches') or jsonb_typeof(p_plan->'slot_patches') <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.slot_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? '_resolution_at') or jsonb_typeof(p_plan->'_resolution_at') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan._resolution_at must be an ISO timestamp string'
      using errcode = 'P0001';
  end if;

  if not (p_plan ? 'approval') or jsonb_typeof(p_plan->'approval') <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval must be a jsonb object (v4 §3.6.5)'
      using errcode = 'P0001';
  end if;
  v_approval_block := p_plan->'approval';

  if not (v_approval_block ? 'old_outcome')
     or jsonb_typeof(v_approval_block->'old_outcome') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.old_outcome must be a string'
      using errcode = 'P0001';
  end if;
  if not (v_approval_block ? 'new_outcome')
     or jsonb_typeof(v_approval_block->'new_outcome') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_outcome must be a string'
      using errcode = 'P0001';
  end if;
  if not (v_approval_block ? 'chain_config_changed')
     or jsonb_typeof(v_approval_block->'chain_config_changed') <> 'boolean' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.chain_config_changed must be boolean'
      using errcode = 'P0001';
  end if;

  v_old_outcome          := v_approval_block->>'old_outcome';
  v_new_outcome          := v_approval_block->>'new_outcome';
  v_chain_config_changed := (v_approval_block->>'chain_config_changed')::boolean;
  v_new_chain_config     := case
                              when v_approval_block ? 'new_chain_config'
                                   and jsonb_typeof(v_approval_block->'new_chain_config') = 'object'
                              then v_approval_block->'new_chain_config'
                              else null
                            end;

  if v_old_outcome not in ('allow', 'require_approval', 'deny') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.old_outcome must be allow|require_approval|deny (got %)', v_old_outcome
      using errcode = 'P0001';
  end if;
  if v_new_outcome not in ('allow', 'require_approval', 'deny') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_outcome must be allow|require_approval|deny (got %)', v_new_outcome
      using errcode = 'P0001';
  end if;

  v_asset_patches := coalesce(p_plan->'asset_reservation_patches', '[]'::jsonb);
  v_order_patches := coalesce(p_plan->'order_patches',             '[]'::jsonb);
  v_wo_patches    := coalesce(p_plan->'work_order_sla_patches',    '[]'::jsonb);

  v_booking_patch := p_plan->'booking';
  v_slot_patches  := p_plan->'slot_patches';

  if jsonb_typeof(v_asset_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: asset_reservation_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_order_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: order_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_wo_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: work_order_sla_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;

  if not (v_booking_patch ? 'location_id') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.location_id is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'start_at') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.start_at is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'end_at') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.end_at is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'cost_amount_snapshot') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.cost_amount_snapshot is required'
      using errcode = 'P0001';
  end if;

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE.
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'edit_booking.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant_id, idempotency_key) ───────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate ───────────────────────────
  v_payload_hash := public.booking_edit_idempotency_payload_hash(p_plan);

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

  -- ── 4. Row lock on bookings + load pre-edit snapshot ─────────────────
  select id, tenant_id, title, description,
         requester_person_id, host_person_id, booked_by_user_id,
         location_id, start_at, end_at, timezone,
         status, source,
         cost_center_id, cost_amount_snapshot,
         policy_snapshot, applied_rule_ids, config_release_id,
         calendar_event_id, calendar_provider, calendar_etag,
         recurrence_series_id, recurrence_index, recurrence_overridden,
         recurrence_skipped, template_id,
         created_at, updated_at
    into v_booking
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'edit_booking.not_found: booking=% tenant=%', p_booking_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Cancelled-state guard ──────────────────────────────────────────
  if v_booking.status = 'cancelled' then
    raise exception 'booking.cancelled_cannot_edit: booking=% is cancelled and can no longer be edited',
      p_booking_id
      using errcode = 'P0001';
  end if;

  v_new_location_id := (v_booking_patch->>'location_id')::uuid;

  -- ── 6. Semantic re-derivation gate (origin+destination room scope) ───
  v_resolution_at_ts := (p_plan->>'_resolution_at')::timestamptz;
  select max(updated_at)
    into v_rules_max_updated_at
    from public.room_booking_rules
   where tenant_id = p_tenant_id
     and (
       target_scope = 'tenant'
       or (target_scope = 'room'
           and target_id in (v_booking.location_id, v_new_location_id))
       or target_scope in ('space_subtree', 'room_type')
     );

  if v_rules_max_updated_at is not null
     and v_rules_max_updated_at > v_resolution_at_ts then
    raise exception 'automation_plan.stale_resolution: room_booking_rules.updated_at=% > plan._resolution_at=%',
      v_rules_max_updated_at, v_resolution_at_ts
      using errcode = 'P0001',
            hint = 'The booking rule set changed since the plan was built. Refetch and retry.';
  end if;

  -- ── 7. Approval reconciliation gate (§3.6.5) ────────────────────────
  --
  -- 7.a — classify current approvals state.
  select
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'delegated'),
    count(*) filter (where status = 'approved'),
    count(*) filter (where status = 'rejected')
  into v_pending_count, v_delegated_count, v_approved_count, v_rejected_count
  from public.approvals
  where tenant_id = p_tenant_id
    and target_entity_type = 'booking'
    and target_entity_id = p_booking_id;

  if v_rejected_count > 0 then
    v_approval_state := 'terminal_rejected';
  elsif (v_pending_count + v_delegated_count) > 0 then
    v_approval_state := 'pending';
  elsif v_approved_count > 0 then
    v_approval_state := 'terminal_approved';
  else
    v_approval_state := 'none';
  end if;

  -- 7.b — resolve the decision table to a single action + status target.
  if v_approval_state = 'terminal_rejected' then
    v_action        := 'cancelled_raise';
    v_status_target := null;
  elsif v_new_outcome = 'deny' then
    v_action        := 'deny_raise';
    v_status_target := null;
  elsif v_old_outcome = 'allow' and v_new_outcome = 'allow' then
    v_action        := 'noop';
    v_status_target := null;
  elsif v_old_outcome = 'allow' and v_new_outcome = 'require_approval' then
    v_action        := 'insert';
    v_status_target := 'pending_approval';
    v_emit_approval_required := true;
  elsif v_old_outcome = 'require_approval' and v_new_outcome = 'allow' then
    if v_approval_state = 'pending' then
      v_action        := 'expire';
      v_status_target := 'confirmed';
    elsif v_approval_state = 'terminal_approved' then
      v_action        := 'noop';
      v_status_target := null;
    else
      v_action        := 'noop';
      v_status_target := null;
    end if;
  elsif v_old_outcome = 'require_approval' and v_new_outcome = 'require_approval' then
    if v_approval_state = 'pending' then
      if v_chain_config_changed then
        v_action        := 'expire_and_insert';
        v_status_target := 'pending_approval';
        v_emit_approval_required := true;
      else
        v_action        := 'noop';
        v_status_target := null;
      end if;
    elsif v_approval_state = 'terminal_approved' then
      if v_chain_config_changed then
        v_action        := 'expire_and_insert';
        v_status_target := 'pending_approval';
        v_emit_approval_required := true;
      else
        v_action        := 'noop';
        v_status_target := null;
      end if;
    else
      v_action        := 'insert';
      v_status_target := 'pending_approval';
      v_emit_approval_required := true;
    end if;
  else
    v_action        := 'noop';
    v_status_target := null;
  end if;

  -- 7.c — execute terminal raises BEFORE child validation.
  if v_action = 'cancelled_raise' then
    raise exception 'booking.cancelled_cannot_edit: booking=% has a rejected approval and can no longer be edited',
      p_booking_id
      using errcode = 'P0001';
  end if;
  if v_action = 'deny_raise' then
    raise exception 'edit_booking.deny_on_edit: rule resolver outcome=deny for booking=% — edit not allowed by current rules',
      p_booking_id
      using errcode = 'P0001',
            hint = 'A rule on the target room denies this edit. Pick a different room or revert the change.';
  end if;

  -- 7.d — validate the new chain config + collect approver_person_ids /
  -- approver_team_ids BEFORE the write block. Cross-tenant person/team
  -- failures surface as 404s without leaving a half-applied edit behind.
  if v_action in ('insert', 'expire_and_insert') then
    if v_new_chain_config is null
       or not (v_new_chain_config ? 'required_approvers')
       or jsonb_typeof(v_new_chain_config->'required_approvers') <> 'array' then
      raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_chain_config.required_approvers must be a jsonb array when an insert is required'
        using errcode = 'P0001';
    end if;
    v_threshold := coalesce(v_new_chain_config->>'threshold', 'all');
    if v_threshold not in ('all', 'any') then
      raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_chain_config.threshold must be all|any (got %)', v_threshold
        using errcode = 'P0001';
    end if;
    if v_threshold = 'all' then
      v_parallel_group := 'parallel-' || p_booking_id::text;
    else
      v_parallel_group := null;
    end if;

    v_new_chain_id        := gen_random_uuid();
    v_approver_person_ids := '{}'::uuid[];
    v_approver_team_ids   := '{}'::uuid[];

    for v_approver in
      select * from jsonb_array_elements(v_new_chain_config->'required_approvers')
    loop
      if jsonb_typeof(v_approver) <> 'object'
         or not (v_approver ? 'type')
         or not (v_approver ? 'id')
         or jsonb_typeof(v_approver->'type') <> 'string'
         or jsonb_typeof(v_approver->'id')   <> 'string' then
        raise exception 'edit_booking.invalid_plan_shape: each approver in new_chain_config.required_approvers must be { type:string, id:uuid }'
          using errcode = 'P0001';
      end if;
      v_approver_type := v_approver->>'type';
      v_approver_id   := (v_approver->>'id')::uuid;

      if v_approver_type = 'person' then
        perform public.validate_entity_in_tenant(p_tenant_id, 'person', v_approver_id);
        v_approver_person_ids := array_append(v_approver_person_ids, v_approver_id);
      elsif v_approver_type = 'team' then
        perform public.validate_entity_in_tenant(p_tenant_id, 'team', v_approver_id);
        v_approver_team_ids := array_append(v_approver_team_ids, v_approver_id);
      else
        raise exception 'edit_booking.invalid_plan_shape: approver type must be person|team (got %)', v_approver_type
          using errcode = 'P0001';
      end if;
    end loop;

    if (array_length(v_approver_person_ids, 1) is null)
       and (array_length(v_approver_team_ids, 1) is null) then
      raise exception 'edit_booking.invalid_plan_shape: p_plan.approval.new_chain_config.required_approvers cannot be empty when insert is required'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 8. Tenant-validate every FK in the plan ──────────────────────────
  perform public.validate_entity_in_tenant(
    p_tenant_id, 'space', (v_booking_patch->>'location_id')::uuid
  );

  if (v_booking_patch ? 'cost_center_id')
     and jsonb_typeof(v_booking_patch->'cost_center_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'cost_center', (v_booking_patch->>'cost_center_id')::uuid
    );
  end if;

  if (v_booking_patch ? 'host_person_id')
     and jsonb_typeof(v_booking_patch->'host_person_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'person', (v_booking_patch->>'host_person_id')::uuid
    );
  end if;

  if (v_booking_patch ? 'applied_rule_ids')
     and jsonb_typeof(v_booking_patch->'applied_rule_ids') = 'array' then
    for v_rule_id in
      select (value)::uuid
        from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')
    loop
      perform public.validate_entity_in_tenant(p_tenant_id, 'booking_rule', v_rule_id);
    end loop;
  end if;

  for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'space', (v_slot->>'space_id')::uuid
    );
  end loop;

  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    if v_asset ? 'asset_id' and jsonb_typeof(v_asset->'asset_id') = 'string' then
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'asset', (v_asset->>'asset_id')::uuid
      );
    end if;
  end loop;

  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'work_order', (v_wo->>'id')::uuid
    );
    if not exists (
      select 1 from public.work_orders
       where id = (v_wo->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = p_booking_id
    ) then
      raise exception 'edit_booking.work_order_not_in_booking: work_order=% does not belong to booking=% in tenant=%',
        (v_wo->>'id')::uuid, p_booking_id, p_tenant_id
        using errcode = 'P0001',
              hint = 'The plan referenced a work_order from a different booking. Refetch the plan and retry.';
    end if;
  end loop;

  for v_order in select * from jsonb_array_elements(v_order_patches) loop
    if not exists (
      select 1 from public.orders
       where id = (v_order->>'id')::uuid
         and tenant_id = p_tenant_id
    ) then
      raise exception 'edit_booking.not_found: order=% does not reference a known order in tenant %',
        (v_order->>'id')::uuid, p_tenant_id
        using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.orders
       where id = (v_order->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = p_booking_id
    ) then
      raise exception 'edit_booking.order_not_in_booking: order=% does not belong to booking=% in tenant=%',
        (v_order->>'id')::uuid, p_booking_id, p_tenant_id
        using errcode = 'P0001',
              hint = 'The plan referenced an order from a different booking. Refetch the plan and retry.';
    end if;
  end loop;

  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    if not exists (
      select 1 from public.asset_reservations
       where id = (v_asset->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = p_booking_id
    ) then
      raise exception 'edit_booking.asset_reservation_not_in_booking: asset_reservation=% does not belong to booking=% in tenant=%',
        (v_asset->>'id')::uuid, p_booking_id, p_tenant_id
        using errcode = 'P0001',
              hint = 'The plan referenced an asset reservation from a different booking. Refetch the plan and retry.';
    end if;
  end loop;

  -- ── 9. Derive new booking values from the patch ──────────────────────
  v_new_start_at       := (v_booking_patch->>'start_at')::timestamptz;
  v_new_end_at         := (v_booking_patch->>'end_at')::timestamptz;
  v_new_cost_snapshot  := nullif(v_booking_patch->>'cost_amount_snapshot', '')::numeric(10,2);

  v_new_policy_snapshot := case
                             when v_booking_patch ? 'policy_snapshot'
                             then coalesce(v_booking_patch->'policy_snapshot', '{}'::jsonb)
                             else v_booking.policy_snapshot
                           end;
  v_new_applied_rule_ids := case
                              when v_booking_patch ? 'applied_rule_ids'
                              then coalesce(
                                (select array_agg(value::uuid)
                                   from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')),
                                '{}'::uuid[])
                              else v_booking.applied_rule_ids
                            end;
  v_new_cost_center_id := case
                            when v_booking_patch ? 'cost_center_id'
                            then nullif(v_booking_patch->>'cost_center_id', '')::uuid
                            else v_booking.cost_center_id
                          end;
  v_new_calendar_etag  := case
                            when v_booking_patch ? 'calendar_etag'
                            then v_booking_patch->>'calendar_etag'
                            else v_booking.calendar_etag
                          end;
  v_new_host_person_id := case
                            when v_booking_patch ? 'host_person_id'
                            then nullif(v_booking_patch->>'host_person_id', '')::uuid
                            else v_booking.host_person_id
                          end;
  v_new_recurrence_over := case
                             when v_booking_patch ? 'recurrence_overridden'
                             then coalesce((v_booking_patch->>'recurrence_overridden')::boolean,
                                           v_booking.recurrence_overridden)
                             else v_booking.recurrence_overridden
                           end;
  v_new_config_release_id := case
                               when v_booking_patch ? 'config_release_id'
                               then nullif(v_booking_patch->>'config_release_id', '')::uuid
                               else v_booking.config_release_id
                             end;

  if v_status_target is not null then
    v_new_booking_status := v_status_target;
  else
    v_new_booking_status := v_booking.status;
  end if;

  -- ── 10. Atomic write block ───────────────────────────────────────────

  -- 10.a — booking_slots (per slot_patch).
  for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
    update public.booking_slots
       set space_id                = (v_slot->>'space_id')::uuid,
           start_at                = (v_slot->>'start_at')::timestamptz,
           end_at                  = (v_slot->>'end_at')::timestamptz,
           setup_buffer_minutes    = coalesce((v_slot->>'setup_buffer_minutes')::int,
                                              setup_buffer_minutes),
           teardown_buffer_minutes = coalesce((v_slot->>'teardown_buffer_minutes')::int,
                                              teardown_buffer_minutes),
           attendee_count          = case
                                       when v_slot ? 'attendee_count'
                                       then nullif(v_slot->>'attendee_count', '')::int
                                       else attendee_count
                                     end,
           attendee_person_ids     = case
                                       when v_slot ? 'attendee_person_ids'
                                            and jsonb_typeof(v_slot->'attendee_person_ids') = 'array'
                                       then coalesce(
                                         (select array_agg(value::uuid)
                                            from jsonb_array_elements_text(v_slot->'attendee_person_ids')),
                                         '{}'::uuid[])
                                       else attendee_person_ids
                                     end
     where id        = (v_slot->>'slot_id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_slots_updated := v_slots_updated + v_row_count;
  end loop;

  -- 10.b — bookings.
  update public.bookings
     set location_id           = v_new_location_id,
         start_at              = v_new_start_at,
         end_at                = v_new_end_at,
         cost_amount_snapshot  = v_new_cost_snapshot,
         policy_snapshot       = v_new_policy_snapshot,
         applied_rule_ids      = v_new_applied_rule_ids,
         cost_center_id        = v_new_cost_center_id,
         calendar_etag         = v_new_calendar_etag,
         host_person_id        = v_new_host_person_id,
         recurrence_overridden = v_new_recurrence_over,
         config_release_id     = v_new_config_release_id,
         status                = v_new_booking_status,
         updated_at            = v_started_at
   where id        = p_booking_id
     and tenant_id = p_tenant_id;

  -- 10.c — asset_reservations.
  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    update public.asset_reservations
       set start_at = (v_asset->>'start_at')::timestamptz,
           end_at   = (v_asset->>'end_at')::timestamptz
     where id        = (v_asset->>'id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_assets_updated := v_assets_updated + v_row_count;
  end loop;

  -- 10.d — orders.
  for v_order in select * from jsonb_array_elements(v_order_patches) loop
    update public.orders
       set delivery_location_id   = case
                                      when v_order ? 'delivery_location_id'
                                      then nullif(v_order->>'delivery_location_id', '')::uuid
                                      else delivery_location_id
                                    end,
           requested_for_start_at = case
                                      when v_order ? 'requested_for_start_at'
                                      then nullif(v_order->>'requested_for_start_at', '')::timestamptz
                                      else requested_for_start_at
                                    end,
           requested_for_end_at   = case
                                      when v_order ? 'requested_for_end_at'
                                      then nullif(v_order->>'requested_for_end_at', '')::timestamptz
                                      else requested_for_end_at
                                    end
     where id        = (v_order->>'id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_orders_updated := v_orders_updated + v_row_count;
  end loop;

  -- 10.e — approvals reconciliation writes (§3.6.5) + co-located inbox INSERT.
  if v_action in ('expire', 'expire_and_insert') then
    if v_approval_state = 'terminal_approved' then
      update public.approvals
         set status       = 'expired',
             responded_at = v_started_at,
             comments     = 'superseded_by_edit (booking edit at ' || v_started_at::text || ')'
       where tenant_id          = p_tenant_id
         and target_entity_type = 'booking'
         and target_entity_id   = p_booking_id
         and status             = 'approved';
    end if;
    update public.approvals
       set status       = 'expired',
           responded_at = v_started_at,
           comments     = 'superseded_by_edit (booking edit at ' || v_started_at::text || ')'
     where tenant_id          = p_tenant_id
       and target_entity_type = 'booking'
       and target_entity_id   = p_booking_id
       and status             in ('pending', 'delegated');
  end if;

  if v_action in ('insert', 'expire_and_insert') then
    -- INSERT mirrors booking-flow.service.ts:1275-1283. One INSERT per
    -- approver; chain_id + parallel_group set once outside the loop.
    for v_approver in
      select * from jsonb_array_elements(v_new_chain_config->'required_approvers')
    loop
      v_approver_type := v_approver->>'type';
      v_approver_id   := (v_approver->>'id')::uuid;
      insert into public.approvals
        (tenant_id, target_entity_type, target_entity_id,
         approval_chain_id, parallel_group,
         approver_person_id, approver_team_id, status,
         requested_at, created_at)
      values
        (p_tenant_id, 'booking', p_booking_id,
         v_new_chain_id, v_parallel_group,
         case when v_approver_type = 'person' then v_approver_id else null end,
         case when v_approver_type = 'team'   then v_approver_id else null end,
         'pending',
         v_started_at, v_started_at);

      -- ─── Hybrid C invariant — atomic inbox INSERT ─────────────────────
      -- For person approver: one row per the matching public.users row
      -- (users.person_id = v_approver_id, in p_tenant_id).
      -- For team approver: fan out via team_members.user_id (00003:123).
      -- ON CONFLICT DO NOTHING keeps RPC retry / cached_result replay safe
      -- — the partial unique index in 00391 is scoped by chain_id.
      if v_approver_type = 'person' then
        insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
        select p_tenant_id, u.id, 'booking.approval_required',
               jsonb_build_object(
                 'booking_id',          p_booking_id,
                 'chain_id',            v_new_chain_id,
                 'approver_person_id',  v_approver_id
               )
        from public.users u
        where u.person_id = v_approver_id
          and u.tenant_id = p_tenant_id
        on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
          where (payload ? 'chain_id') do nothing;

      elsif v_approver_type = 'team' then
        insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
        select p_tenant_id, u.id, 'booking.approval_required',
               jsonb_build_object(
                 'booking_id',        p_booking_id,
                 'chain_id',          v_new_chain_id,
                 'approver_team_id',  v_approver_id
               )
        from public.team_members tm
        join public.users u
          on u.id = tm.user_id
         and u.tenant_id = p_tenant_id
        where tm.team_id = v_approver_id
          and tm.tenant_id = p_tenant_id
        on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
          where (payload ? 'chain_id') do nothing;
      end if;
    end loop;
  end if;

  -- 10.f — work_orders sla patches.
  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    update public.work_orders
       set planned_start_at      = (v_wo->>'planned_start_at')::timestamptz,
           sla_resolution_due_at = case
                                     when v_wo ? 'sla_due_at'
                                     then nullif(v_wo->>'sla_due_at', '')::timestamptz
                                     else sla_resolution_due_at
                                   end,
           updated_at            = v_started_at
     where id        = (v_wo->>'id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_wo_updated := v_wo_updated + v_row_count;
  end loop;

  -- ── 11. audit_events insert ──────────────────────────────────────────
  v_audit_before := jsonb_build_object(
    'location_id',           v_booking.location_id,
    'start_at',              v_booking.start_at,
    'end_at',                v_booking.end_at,
    'cost_amount_snapshot',  v_booking.cost_amount_snapshot,
    'cost_center_id',        v_booking.cost_center_id,
    'calendar_etag',         v_booking.calendar_etag,
    'applied_rule_ids',      to_jsonb(v_booking.applied_rule_ids),
    'policy_snapshot',       v_booking.policy_snapshot,
    'host_person_id',        v_booking.host_person_id,
    'recurrence_overridden', v_booking.recurrence_overridden,
    'config_release_id',     v_booking.config_release_id,
    'status',                v_booking.status
  );
  v_audit_after := jsonb_build_object(
    'location_id',           v_new_location_id,
    'start_at',              v_new_start_at,
    'end_at',                v_new_end_at,
    'cost_amount_snapshot',  v_new_cost_snapshot,
    'cost_center_id',        v_new_cost_center_id,
    'calendar_etag',         v_new_calendar_etag,
    'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
    'policy_snapshot',       v_new_policy_snapshot,
    'host_person_id',        v_new_host_person_id,
    'recurrence_overridden', v_new_recurrence_over,
    'config_release_id',     v_new_config_release_id,
    'status',                v_new_booking_status
  );

  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details, created_at)
  values (
    p_tenant_id,
    'booking.edited',
    'booking',
    p_booking_id,
    v_actor_users_id,
    jsonb_build_object(
      'before',                v_audit_before,
      'after',                 v_audit_after,
      'slots_updated',         v_slots_updated,
      'assets_updated',        v_assets_updated,
      'orders_updated',        v_orders_updated,
      'wo_updated',            v_wo_updated,
      'approval_action',       v_action,
      'approval_old_outcome',  v_old_outcome,
      'approval_new_outcome',  v_new_outcome,
      'approval_prior_state',  v_approval_state,
      'approval_chain_id',     v_new_chain_id,
      'idempotency_key',       p_idempotency_key
    ),
    v_started_at
  );

  -- ── 12. domain_events insert ─────────────────────────────────────────
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id, created_at)
  values (
    p_tenant_id,
    'booking.edited',
    'booking',
    p_booking_id,
    jsonb_build_object(
      'booking_id',     p_booking_id,
      'started_at',     v_started_at,
      'idempotency_key', p_idempotency_key
    ),
    v_actor_users_id,
    v_started_at
  );

  -- ── 13. Outbox emits ─────────────────────────────────────────────────
  if v_booking.location_id is distinct from v_new_location_id then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.location_changed',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',         p_tenant_id,
        'booking_id',        p_booking_id,
        'previous_location', v_booking.location_id,
        'new_location',      v_new_location_id,
        'started_at',        v_started_at
      ),
      p_idempotency_key => 'booking.location_changed:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.location_changed'::text);
  end if;

  if v_booking.cost_amount_snapshot is distinct from v_new_cost_snapshot then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.cost_changed',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',     p_tenant_id,
        'booking_id',    p_booking_id,
        'previous_cost', v_booking.cost_amount_snapshot,
        'new_cost',      v_new_cost_snapshot,
        'started_at',    v_started_at
      ),
      p_idempotency_key => 'booking.cost_changed:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.cost_changed'::text);
  end if;

  -- v5: booking.approval_required emit for rows 2, 7, 8 — v5 splits the
  -- mixed v4 `approver_ids` into separate person/team arrays so the
  -- handler doesn't have to re-classify each id. The `approver_person_ids`
  -- key holds persons.id values; the handler resolves person → user via
  -- users.person_id JOIN at dispatch time (sub-step D).
  if v_emit_approval_required then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.approval_required',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',           p_tenant_id,
        'booking_id',          p_booking_id,
        'chain_id',            v_new_chain_id,
        'approver_person_ids', to_jsonb(v_approver_person_ids),
        'approver_team_ids',   to_jsonb(v_approver_team_ids),
        'started_at',          v_started_at
      ),
      p_idempotency_key => 'booking.approval_required:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.approval_required'::text);
  end if;

  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    if coalesce((v_wo->>'needs_repoint')::boolean, false) then
      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'sla.timer_repointed_required',
        p_aggregate_type  => 'work_order',
        p_aggregate_id    => (v_wo->>'id')::uuid,
        p_payload         => jsonb_build_object(
          'tenant_id',     p_tenant_id,
          'work_order_id', (v_wo->>'id')::uuid,
          'sla_policy_id', nullif(v_wo->>'sla_policy_id', '')::uuid,
          'started_at',    v_started_at,
          'source',        'edit_booking'
        ),
        p_idempotency_key => 'sla.timer_repointed_required:' || (v_wo->>'id')::text || ':' || p_idempotency_key,
        p_event_version   => 1,
        p_available_at    => null
      );
      v_emitted := v_emitted || to_jsonb('sla.timer_repointed_required'::text);
    end if;
  end loop;

  -- ── 14. Assemble result + mark command_operations success ────────────
  v_result := jsonb_build_object(
    'booking',     jsonb_build_object(
      'id',                    p_booking_id,
      'tenant_id',             p_tenant_id,
      'location_id',           v_new_location_id,
      'start_at',              v_new_start_at,
      'end_at',                v_new_end_at,
      'cost_amount_snapshot',  v_new_cost_snapshot,
      'cost_center_id',        v_new_cost_center_id,
      'calendar_etag',         v_new_calendar_etag,
      'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
      'policy_snapshot',       v_new_policy_snapshot,
      'host_person_id',        v_new_host_person_id,
      'recurrence_overridden', v_new_recurrence_over,
      'config_release_id',     v_new_config_release_id,
      'status',                v_new_booking_status,
      'updated_at',            v_started_at
    ),
    'follow_ups',  v_emitted,
    'slots_updated',  v_slots_updated,
    'assets_updated', v_assets_updated,
    'orders_updated', v_orders_updated,
    'wo_updated',     v_wo_updated
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke all on function public.edit_booking(uuid, jsonb, uuid, uuid, text) from public;
grant  execute on function public.edit_booking(uuid, jsonb, uuid, uuid, text) to service_role;

comment on function public.edit_booking(uuid, jsonb, uuid, uuid, text) is
  'B.4.A.5 sub-step B — edit_booking RPC v5 (supersedes 00364 v4). Hybrid C invariant: inbox_notifications row(s) inserted in the same RPC tx as the approvals row(s). Person approver → one inbox row for the matching users.person_id; team approver → fan-out via team_members.user_id JOIN public.users (tenant-filtered both sides; codex pick A). ON CONFLICT DO NOTHING on uq_inbox_notifications_chain (00391 partial unique index) keeps cached_result replay idempotent. Outbox payload split: approver_ids[] → approver_person_ids[] + approver_team_ids[] (the person array holds persons.id values; sub-step D fans person → user via users.person_id JOIN at dispatch time). All §3.6.5 Row 1-10 semantics + v3+v4 critical fixes preserved verbatim. Spec: /tmp/b4a5-plan-v2.md sub-step B.';

-- == 3. edit_booking_scope -- reproduced VERBATIM from 00399:20-1145 ==
--     (single line changed: the v_payload_hash assignment, 00399:200).

create or replace function public.edit_booking_scope(
  p_plans            jsonb,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_dry_run          boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, outbox
as $$
declare
  v_started_at         constant timestamptz := now();
  v_max_occurrences    constant int          := 200;

  v_existing           public.command_operations;
  v_payload_hash       text;
  v_lock_key           bigint;

  v_actor_users_id     uuid;

  v_plan_count         int;
  v_plan_elem          jsonb;
  v_plan_index         int;
  v_booking_id_set     uuid[];

  v_present_count      int;
  v_missing_count      int;
  v_first_missing      uuid;

  v_series_ids         uuid[];
  v_distinct_series    int;
  v_single_series_id   uuid;

  v_booking            record;
  v_target_booking_id  uuid;
  v_plan               jsonb;

  v_approval_block     jsonb;
  v_old_outcome        text;
  v_new_outcome        text;
  v_chain_config_changed boolean;
  v_new_chain_config   jsonb;

  v_approval_state     text;
  v_pending_count      int;
  v_delegated_count    int;
  v_approved_count     int;
  v_rejected_count     int;
  v_action             text;
  v_status_target      text;
  v_emit_approval_required boolean;
  v_threshold          text;
  v_parallel_group     text;
  v_new_chain_id       uuid;
  v_approver           jsonb;
  v_approver_type      text;
  v_approver_id        uuid;
  -- v3 — split arrays (replaces v2 v_approver_ids). Initializers added for
  -- parity with 00394 (self-review N4); the per-occurrence loop also
  -- re-initializes them at iteration entry, so the declaration default is
  -- belt-and-braces against future loop-entry edits that drop the reset.
  v_approver_person_ids  uuid[] := '{}'::uuid[];   -- person approvers (persons.id values)
  v_approver_team_ids    uuid[] := '{}'::uuid[];   -- team approvers
  v_new_booking_status text;

  v_booking_patch      jsonb;
  v_slot_patches       jsonb;
  v_asset_patches      jsonb;
  v_order_patches      jsonb;
  v_wo_patches         jsonb;

  v_new_location_id        uuid;
  v_new_start_at           timestamptz;
  v_new_end_at             timestamptz;
  v_new_cost_snapshot      numeric(10,2);
  v_resolution_at_ts       timestamptz;

  v_new_policy_snapshot    jsonb;
  v_new_applied_rule_ids   uuid[];
  v_new_cost_center_id     uuid;
  v_new_calendar_etag      text;
  v_new_host_person_id     uuid;
  v_new_config_release_id  uuid;

  v_rules_max_updated_at   timestamptz;

  v_rule_id            uuid;
  v_slot               jsonb;
  v_asset              jsonb;
  v_order              jsonb;
  v_wo                 jsonb;

  v_audit_before       jsonb;
  v_audit_after        jsonb;

  v_slot_space_before  uuid;
  v_slot_start_before  timestamptz;

  v_row_count          int;
  v_slots_updated      int;
  v_assets_updated     int;
  v_orders_updated     int;
  v_wo_updated         int;

  v_per_follow_ups     jsonb;
  v_per_occurrence     jsonb := '[]'::jsonb;
  v_aggregated_follow_ups jsonb := '[]'::jsonb;

  v_committed          int := 0;

  v_result             jsonb;
begin
  -- ── 0. Argument validation ───────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'edit_booking_scope: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'edit_booking_scope: p_idempotency_key required';
  end if;
  if p_plans is null or jsonb_typeof(p_plans) <> 'array' then
    raise exception 'edit_booking_scope.invalid_plans: p_plans must be a jsonb array'
      using errcode = 'P0001';
  end if;

  v_plan_count := jsonb_array_length(p_plans);

  if v_plan_count = 0 then
    raise exception 'edit_booking_scope.invalid_plans: p_plans must be a non-empty array'
      using errcode = 'P0001';
  end if;

  if v_plan_count > v_max_occurrences then
    raise exception 'edit_booking_scope.too_many_occurrences: % occurrences exceeds the % cap',
      v_plan_count, v_max_occurrences
      using errcode = 'P0001',
            hint = 'The chunk-threshold confirmation lives in TS at occurrence>100. >200 is a hard server cap.';
  end if;

  v_plan_index := 0;
  for v_plan_elem in select * from jsonb_array_elements(p_plans) loop
    if jsonb_typeof(v_plan_elem) <> 'object'
       or not (v_plan_elem ? 'booking_id')
       or jsonb_typeof(v_plan_elem->'booking_id') <> 'string'
       or not (v_plan_elem ? 'plan')
       or jsonb_typeof(v_plan_elem->'plan') <> 'object' then
      raise exception 'edit_booking_scope.invalid_plans: each element must be { booking_id:uuid, plan:object } (index=%)', v_plan_index
        using errcode = 'P0001';
    end if;
    if (v_plan_elem->'plan'->'booking') ? 'recurrence_overridden' then
      raise exception 'edit_booking_scope.invalid_plans: plan.booking.recurrence_overridden is not valid in scope-mode plans (index=%)', v_plan_index
        using errcode = 'P0001',
              hint = 'recurrence_overridden is a per-occurrence concept. The Step 2F.2 plan-builder must omit it from scope-mode edit plans.';
    end if;
    v_plan_index := v_plan_index + 1;
  end loop;

  -- ── 1. F-CRIT-1: auth_uid → users.id ─────────────────────────────────
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'edit_booking.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant_id, idempotency_key) ──────────
  if not p_dry_run then
    v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
    perform pg_advisory_xact_lock(v_lock_key);
  end if;

  -- ── 3. command_operations idempotency gate (commit-only) ────────────
  v_payload_hash := public.booking_edit_idempotency_payload_hash(p_plans);

  if not p_dry_run then
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
  end if;

  -- ── 4. Extract + sort booking_ids deterministically ─────────────────
  select array_agg((elem->>'booking_id')::uuid order by (elem->>'booking_id')::uuid)
    into v_booking_id_set
    from jsonb_array_elements(p_plans) elem;

  if (select count(*) from unnest(v_booking_id_set) x) <>
     (select count(*) from (select distinct x from unnest(v_booking_id_set) x) d) then
    raise exception 'edit_booking_scope.invalid_plans: duplicate booking_id detected in p_plans'
      using errcode = 'P0001';
  end if;

  -- ── 5. Lock all bookings FOR UPDATE in id order (deadlock-safe) ─────
  perform 1 from public.bookings
   where id = any(v_booking_id_set)
     and tenant_id = p_tenant_id
   order by id asc
   for update;

  select count(*)::int
    into v_present_count
    from public.bookings
   where id = any(v_booking_id_set)
     and tenant_id = p_tenant_id;

  if v_present_count <> array_length(v_booking_id_set, 1) then
    v_missing_count := array_length(v_booking_id_set, 1) - v_present_count;
    select missing_id
      into v_first_missing
      from (
        select unnest(v_booking_id_set) as missing_id
      ) x
     where missing_id not in (
       select id from public.bookings
        where id = any(v_booking_id_set) and tenant_id = p_tenant_id
     )
     order by missing_id asc
     limit 1;

    raise exception 'edit_booking_scope.booking_not_found: % booking_id(s) not found in tenant=%, first missing: %',
      v_missing_count, p_tenant_id, v_first_missing
      using errcode = 'P0001',
            detail = 'first missing booking_id: ' || v_first_missing::text;
  end if;

  -- ── 6. Defense-in-depth: same-series check ──────────────────────────
  select array_agg(distinct recurrence_series_id)
    into v_series_ids
    from public.bookings
   where id = any(v_booking_id_set)
     and tenant_id = p_tenant_id;

  v_distinct_series := coalesce(array_length(v_series_ids, 1), 0);

  if v_distinct_series <> 1 or v_series_ids[1] is null then
    raise exception 'edit_booking_scope.mixed_series: booking_ids must all share the same non-null recurrence_series_id (distinct_series_ids=%)',
      v_series_ids
      using errcode = 'P0001';
  end if;

  v_single_series_id := v_series_ids[1];

  -- ── 7. Per-occurrence loop: validate + (optionally) write ───────────
  for v_plan_elem in select * from jsonb_array_elements(p_plans) loop
    v_target_booking_id := (v_plan_elem->>'booking_id')::uuid;
    v_plan := v_plan_elem->'plan';

    v_slots_updated  := 0;
    v_assets_updated := 0;
    v_orders_updated := 0;
    v_wo_updated     := 0;
    v_per_follow_ups := '[]'::jsonb;
    v_emit_approval_required := false;
    v_approver_person_ids := '{}'::uuid[];
    v_approver_team_ids := '{}'::uuid[];
    v_new_chain_id := null;
    v_parallel_group := null;

    select id, tenant_id, title, description,
           requester_person_id, host_person_id, booked_by_user_id,
           location_id, start_at, end_at, timezone,
           status, source,
           cost_center_id, cost_amount_snapshot,
           policy_snapshot, applied_rule_ids, config_release_id,
           calendar_event_id, calendar_provider, calendar_etag,
           recurrence_series_id, recurrence_index, recurrence_overridden,
           recurrence_skipped, template_id,
           created_at, updated_at
      into v_booking
      from public.bookings
     where id = v_target_booking_id
       and tenant_id = p_tenant_id;

    if not found then
      raise exception 'edit_booking_scope.booking_not_found: booking=% missing during loop iteration', v_target_booking_id
        using errcode = 'P0001';
    end if;

    if not (v_plan ? 'booking') or jsonb_typeof(v_plan->'booking') <> 'object' then
      raise exception 'edit_booking.invalid_plan_shape: plan.booking must be a jsonb object (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;
    if not (v_plan ? 'slot_patches') or jsonb_typeof(v_plan->'slot_patches') <> 'array' then
      raise exception 'edit_booking.invalid_plan_shape: plan.slot_patches must be a jsonb array (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;
    if not (v_plan ? '_resolution_at') or jsonb_typeof(v_plan->'_resolution_at') <> 'string' then
      raise exception 'edit_booking.invalid_plan_shape: plan._resolution_at must be an ISO timestamp string (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;
    if not (v_plan ? 'approval') or jsonb_typeof(v_plan->'approval') <> 'object' then
      raise exception 'edit_booking.invalid_plan_shape: plan.approval must be a jsonb object (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;
    v_approval_block := v_plan->'approval';

    if not (v_approval_block ? 'old_outcome')
       or jsonb_typeof(v_approval_block->'old_outcome') <> 'string'
       or not (v_approval_block ? 'new_outcome')
       or jsonb_typeof(v_approval_block->'new_outcome') <> 'string'
       or not (v_approval_block ? 'chain_config_changed')
       or jsonb_typeof(v_approval_block->'chain_config_changed') <> 'boolean' then
      raise exception 'edit_booking.invalid_plan_shape: plan.approval missing required keys (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;

    v_old_outcome          := v_approval_block->>'old_outcome';
    v_new_outcome          := v_approval_block->>'new_outcome';
    v_chain_config_changed := (v_approval_block->>'chain_config_changed')::boolean;
    v_new_chain_config     := case
                                when v_approval_block ? 'new_chain_config'
                                     and jsonb_typeof(v_approval_block->'new_chain_config') = 'object'
                                then v_approval_block->'new_chain_config'
                                else null
                              end;

    if v_old_outcome not in ('allow', 'require_approval', 'deny') then
      raise exception 'edit_booking.invalid_plan_shape: approval.old_outcome must be allow|require_approval|deny (booking=%, got %)', v_target_booking_id, v_old_outcome
        using errcode = 'P0001';
    end if;
    if v_new_outcome not in ('allow', 'require_approval', 'deny') then
      raise exception 'edit_booking.invalid_plan_shape: approval.new_outcome must be allow|require_approval|deny (booking=%, got %)', v_target_booking_id, v_new_outcome
        using errcode = 'P0001';
    end if;

    v_booking_patch := v_plan->'booking';
    v_slot_patches  := v_plan->'slot_patches';
    v_asset_patches := coalesce(v_plan->'asset_reservation_patches', '[]'::jsonb);
    v_order_patches := coalesce(v_plan->'order_patches',             '[]'::jsonb);
    v_wo_patches    := coalesce(v_plan->'work_order_sla_patches',    '[]'::jsonb);

    if jsonb_typeof(v_asset_patches) <> 'array'
       or jsonb_typeof(v_order_patches) <> 'array'
       or jsonb_typeof(v_wo_patches) <> 'array' then
      raise exception 'edit_booking.invalid_plan_shape: child-patch arrays must all be jsonb arrays (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;

    if not (v_booking_patch ? 'location_id')
       or not (v_booking_patch ? 'start_at')
       or not (v_booking_patch ? 'end_at')
       or not (v_booking_patch ? 'cost_amount_snapshot') then
      raise exception 'edit_booking.invalid_plan_shape: plan.booking missing required keys (booking=%)', v_target_booking_id
        using errcode = 'P0001';
    end if;

    if v_booking.status = 'cancelled' then
      raise exception 'booking.cancelled_cannot_edit: booking=% is cancelled and can no longer be edited',
        v_target_booking_id
        using errcode = 'P0001';
    end if;

    v_new_location_id := (v_booking_patch->>'location_id')::uuid;

    v_resolution_at_ts := (v_plan->>'_resolution_at')::timestamptz;
    select max(updated_at)
      into v_rules_max_updated_at
      from public.room_booking_rules
     where tenant_id = p_tenant_id
       and (
         target_scope = 'tenant'
         or (target_scope = 'room'
             and target_id in (v_booking.location_id, v_new_location_id))
         or target_scope in ('space_subtree', 'room_type')
       );

    if v_rules_max_updated_at is not null
       and v_rules_max_updated_at > v_resolution_at_ts then
      raise exception 'automation_plan.stale_resolution: room_booking_rules.updated_at=% > plan._resolution_at=% (booking=%)',
        v_rules_max_updated_at, v_resolution_at_ts, v_target_booking_id
        using errcode = 'P0001',
              hint = 'The booking rule set changed since the plan was built. Refetch the scope-edit plan and retry.';
    end if;

    select
      count(*) filter (where status = 'pending'),
      count(*) filter (where status = 'delegated'),
      count(*) filter (where status = 'approved'),
      count(*) filter (where status = 'rejected')
    into v_pending_count, v_delegated_count, v_approved_count, v_rejected_count
    from public.approvals
    where tenant_id = p_tenant_id
      and target_entity_type = 'booking'
      and target_entity_id = v_target_booking_id;

    if v_rejected_count > 0 then
      v_approval_state := 'terminal_rejected';
    elsif (v_pending_count + v_delegated_count) > 0 then
      v_approval_state := 'pending';
    elsif v_approved_count > 0 then
      v_approval_state := 'terminal_approved';
    else
      v_approval_state := 'none';
    end if;

    if v_approval_state = 'terminal_rejected' then
      v_action        := 'cancelled_raise';
      v_status_target := null;
    elsif v_new_outcome = 'deny' then
      v_action        := 'deny_raise';
      v_status_target := null;
    elsif v_old_outcome = 'allow' and v_new_outcome = 'allow' then
      v_action        := 'noop';
      v_status_target := null;
    elsif v_old_outcome = 'allow' and v_new_outcome = 'require_approval' then
      v_action        := 'insert';
      v_status_target := 'pending_approval';
      v_emit_approval_required := true;
    elsif v_old_outcome = 'require_approval' and v_new_outcome = 'allow' then
      if v_approval_state = 'pending' then
        v_action        := 'expire';
        v_status_target := 'confirmed';
      elsif v_approval_state = 'terminal_approved' then
        v_action        := 'noop';
        v_status_target := null;
      else
        v_action        := 'noop';
        v_status_target := null;
      end if;
    elsif v_old_outcome = 'require_approval' and v_new_outcome = 'require_approval' then
      if v_approval_state = 'pending' then
        if v_chain_config_changed then
          v_action        := 'expire_and_insert';
          v_status_target := 'pending_approval';
          v_emit_approval_required := true;
        else
          v_action        := 'noop';
          v_status_target := null;
        end if;
      elsif v_approval_state = 'terminal_approved' then
        if v_chain_config_changed then
          v_action        := 'expire_and_insert';
          v_status_target := 'pending_approval';
          v_emit_approval_required := true;
        else
          v_action        := 'noop';
          v_status_target := null;
        end if;
      else
        v_action        := 'insert';
        v_status_target := 'pending_approval';
        v_emit_approval_required := true;
      end if;
    else
      v_action        := 'noop';
      v_status_target := null;
    end if;

    if v_action = 'cancelled_raise' then
      raise exception 'booking.cancelled_cannot_edit: booking=% has a rejected approval and can no longer be edited',
        v_target_booking_id
        using errcode = 'P0001';
    end if;
    if v_action = 'deny_raise' then
      raise exception 'edit_booking.deny_on_edit: rule resolver outcome=deny for booking=% — edit not allowed by current rules',
        v_target_booking_id
        using errcode = 'P0001',
              hint = 'A rule on the target room denies this edit. Pick a different room or revert the change.';
    end if;

    -- B.4.A.5 sub-step H lifted the controller-vs-notification gate here
    -- on 2026-05-13: notification dispatch (atomic inbox INSERT + outbox
    -- handler + inbox surface + admin overrides) is shipped, so approval-
    -- flipping scope-mode edits no longer need pre-flight refusal at the
    -- RPC layer. v_emit_approval_required stays — the downstream inbox +
    -- outbox emit blocks (lines 1106 + 1111 of 00395) still consume it.

    -- Defense-in-depth — defined but unreachable until gate lifts in H.
    if v_action in ('insert', 'expire_and_insert') then
      if v_new_chain_config is null
         or not (v_new_chain_config ? 'required_approvers')
         or jsonb_typeof(v_new_chain_config->'required_approvers') <> 'array' then
        raise exception 'edit_booking.invalid_plan_shape: plan.approval.new_chain_config.required_approvers must be a jsonb array when an insert is required (booking=%)', v_target_booking_id
          using errcode = 'P0001';
      end if;
      v_threshold := coalesce(v_new_chain_config->>'threshold', 'all');
      if v_threshold not in ('all', 'any') then
        raise exception 'edit_booking.invalid_plan_shape: plan.approval.new_chain_config.threshold must be all|any (booking=%, got %)', v_target_booking_id, v_threshold
          using errcode = 'P0001';
      end if;
      if v_threshold = 'all' then
        v_parallel_group := 'parallel-' || v_target_booking_id::text;
      else
        v_parallel_group := null;
      end if;

      v_new_chain_id := gen_random_uuid();
      v_approver_person_ids := '{}'::uuid[];
      v_approver_team_ids := '{}'::uuid[];

      for v_approver in
        select * from jsonb_array_elements(v_new_chain_config->'required_approvers')
      loop
        if jsonb_typeof(v_approver) <> 'object'
           or not (v_approver ? 'type')
           or not (v_approver ? 'id')
           or jsonb_typeof(v_approver->'type') <> 'string'
           or jsonb_typeof(v_approver->'id')   <> 'string' then
          raise exception 'edit_booking.invalid_plan_shape: each approver must be { type:string, id:uuid } (booking=%)', v_target_booking_id
            using errcode = 'P0001';
        end if;
        v_approver_type := v_approver->>'type';
        v_approver_id   := (v_approver->>'id')::uuid;

        if v_approver_type = 'person' then
          perform public.validate_entity_in_tenant(p_tenant_id, 'person', v_approver_id);
          v_approver_person_ids := array_append(v_approver_person_ids, v_approver_id);
        elsif v_approver_type = 'team' then
          perform public.validate_entity_in_tenant(p_tenant_id, 'team', v_approver_id);
          v_approver_team_ids := array_append(v_approver_team_ids, v_approver_id);
        else
          raise exception 'edit_booking.invalid_plan_shape: approver type must be person|team (booking=%, got %)', v_target_booking_id, v_approver_type
            using errcode = 'P0001';
        end if;
      end loop;

      if (array_length(v_approver_person_ids, 1) is null)
         and (array_length(v_approver_team_ids, 1) is null) then
        raise exception 'edit_booking.invalid_plan_shape: plan.approval.new_chain_config.required_approvers cannot be empty (booking=%)', v_target_booking_id
          using errcode = 'P0001';
      end if;
    end if;

    perform public.validate_entity_in_tenant(
      p_tenant_id, 'space', v_new_location_id
    );

    if (v_booking_patch ? 'cost_center_id')
       and jsonb_typeof(v_booking_patch->'cost_center_id') = 'string' then
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'cost_center', (v_booking_patch->>'cost_center_id')::uuid
      );
    end if;

    if (v_booking_patch ? 'host_person_id')
       and jsonb_typeof(v_booking_patch->'host_person_id') = 'string' then
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'person', (v_booking_patch->>'host_person_id')::uuid
      );
    end if;

    if (v_booking_patch ? 'applied_rule_ids')
       and jsonb_typeof(v_booking_patch->'applied_rule_ids') = 'array' then
      for v_rule_id in
        select (value)::uuid
          from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')
      loop
        perform public.validate_entity_in_tenant(p_tenant_id, 'booking_rule', v_rule_id);
      end loop;
    end if;

    for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'space', (v_slot->>'space_id')::uuid
      );
    end loop;

    for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
      if v_asset ? 'asset_id' and jsonb_typeof(v_asset->'asset_id') = 'string' then
        perform public.validate_entity_in_tenant(
          p_tenant_id, 'asset', (v_asset->>'asset_id')::uuid
        );
      end if;
    end loop;

    for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'work_order', (v_wo->>'id')::uuid
      );
      if not exists (
        select 1 from public.work_orders
         where id = (v_wo->>'id')::uuid
           and tenant_id = p_tenant_id
           and booking_id = v_target_booking_id
      ) then
        raise exception 'edit_booking.work_order_not_in_booking: work_order=% does not belong to booking=% in tenant=%',
          (v_wo->>'id')::uuid, v_target_booking_id, p_tenant_id
          using errcode = 'P0001',
                hint = 'The plan referenced a work_order from a different booking. Refetch the scope-edit plan and retry.';
      end if;
    end loop;

    for v_order in select * from jsonb_array_elements(v_order_patches) loop
      if not exists (
        select 1 from public.orders
         where id = (v_order->>'id')::uuid
           and tenant_id = p_tenant_id
      ) then
        raise exception 'edit_booking.not_found: order=% does not reference a known order in tenant %',
          (v_order->>'id')::uuid, p_tenant_id
          using errcode = 'P0001';
      end if;
      if not exists (
        select 1 from public.orders
         where id = (v_order->>'id')::uuid
           and tenant_id = p_tenant_id
           and booking_id = v_target_booking_id
      ) then
        raise exception 'edit_booking.order_not_in_booking: order=% does not belong to booking=% in tenant=%',
          (v_order->>'id')::uuid, v_target_booking_id, p_tenant_id
          using errcode = 'P0001',
                hint = 'The plan referenced an order from a different booking. Refetch the scope-edit plan and retry.';
      end if;
    end loop;

    for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
      if not exists (
        select 1 from public.asset_reservations
         where id = (v_asset->>'id')::uuid
           and tenant_id = p_tenant_id
           and booking_id = v_target_booking_id
      ) then
        raise exception 'edit_booking.asset_reservation_not_in_booking: asset_reservation=% does not belong to booking=% in tenant=%',
          (v_asset->>'id')::uuid, v_target_booking_id, p_tenant_id
          using errcode = 'P0001',
                hint = 'The plan referenced an asset reservation from a different booking. Refetch the scope-edit plan and retry.';
      end if;
    end loop;

    v_new_start_at       := (v_booking_patch->>'start_at')::timestamptz;
    v_new_end_at         := (v_booking_patch->>'end_at')::timestamptz;
    v_new_cost_snapshot  := nullif(v_booking_patch->>'cost_amount_snapshot', '')::numeric(10,2);

    v_new_policy_snapshot := case
                               when v_booking_patch ? 'policy_snapshot'
                               then coalesce(v_booking_patch->'policy_snapshot', '{}'::jsonb)
                               else v_booking.policy_snapshot
                             end;
    v_new_applied_rule_ids := case
                                when v_booking_patch ? 'applied_rule_ids'
                                then coalesce(
                                  (select array_agg(value::uuid)
                                     from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')),
                                  '{}'::uuid[])
                                else v_booking.applied_rule_ids
                              end;
    v_new_cost_center_id := case
                              when v_booking_patch ? 'cost_center_id'
                              then nullif(v_booking_patch->>'cost_center_id', '')::uuid
                              else v_booking.cost_center_id
                            end;
    v_new_calendar_etag  := case
                              when v_booking_patch ? 'calendar_etag'
                              then v_booking_patch->>'calendar_etag'
                              else v_booking.calendar_etag
                            end;
    v_new_host_person_id := case
                              when v_booking_patch ? 'host_person_id'
                              then nullif(v_booking_patch->>'host_person_id', '')::uuid
                              else v_booking.host_person_id
                            end;
    v_new_config_release_id := case
                                 when v_booking_patch ? 'config_release_id'
                                 then nullif(v_booking_patch->>'config_release_id', '')::uuid
                                 else v_booking.config_release_id
                               end;

    if v_status_target is not null then
      v_new_booking_status := v_status_target;
    else
      v_new_booking_status := v_booking.status;
    end if;

    v_slot_space_before := null;
    v_slot_start_before := null;
    select bs.space_id, bs.start_at
      into v_slot_space_before, v_slot_start_before
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.booking_id = v_target_booking_id
     order by bs.display_order asc
     limit 1;

    if p_dry_run then
      if v_booking.location_id is distinct from v_new_location_id then
        v_per_follow_ups := v_per_follow_ups || to_jsonb('booking.location_changed'::text);
      end if;
      if v_booking.cost_amount_snapshot is distinct from v_new_cost_snapshot then
        v_per_follow_ups := v_per_follow_ups || to_jsonb('booking.cost_changed'::text);
      end if;
      for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
        if coalesce((v_wo->>'needs_repoint')::boolean, false) then
          v_per_follow_ups := v_per_follow_ups || to_jsonb('sla.timer_repointed_required'::text);
        end if;
      end loop;

      v_per_occurrence := v_per_occurrence || jsonb_build_object(
        'booking_id',           v_target_booking_id,
        'would_succeed',        true,
        'approval_action',      v_action,
        'follow_ups_preview',   v_per_follow_ups,
        'slots_to_update',      jsonb_array_length(v_slot_patches),
        'assets_to_update',     jsonb_array_length(v_asset_patches),
        'orders_to_update',     jsonb_array_length(v_order_patches),
        'wo_to_update',         jsonb_array_length(v_wo_patches),
        'space_id_before',      v_slot_space_before,
        'space_id_after',       v_new_location_id,
        'start_at_before',      v_slot_start_before,
        'start_at_after',       v_new_start_at
      );

      v_aggregated_follow_ups := v_aggregated_follow_ups || v_per_follow_ups;
      continue;
    end if;

    -- Atomic write block.
    for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
      update public.booking_slots
         set space_id                = (v_slot->>'space_id')::uuid,
             start_at                = (v_slot->>'start_at')::timestamptz,
             end_at                  = (v_slot->>'end_at')::timestamptz,
             setup_buffer_minutes    = coalesce((v_slot->>'setup_buffer_minutes')::int,
                                                setup_buffer_minutes),
             teardown_buffer_minutes = coalesce((v_slot->>'teardown_buffer_minutes')::int,
                                                teardown_buffer_minutes),
             attendee_count          = case
                                         when v_slot ? 'attendee_count'
                                         then nullif(v_slot->>'attendee_count', '')::int
                                         else attendee_count
                                       end,
             attendee_person_ids     = case
                                         when v_slot ? 'attendee_person_ids'
                                              and jsonb_typeof(v_slot->'attendee_person_ids') = 'array'
                                         then coalesce(
                                           (select array_agg(value::uuid)
                                              from jsonb_array_elements_text(v_slot->'attendee_person_ids')),
                                           '{}'::uuid[])
                                         else attendee_person_ids
                                       end
       where id        = (v_slot->>'slot_id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = v_target_booking_id;
      get diagnostics v_row_count = row_count;
      v_slots_updated := v_slots_updated + v_row_count;
    end loop;

    update public.bookings
       set location_id           = v_new_location_id,
           start_at              = v_new_start_at,
           end_at                = v_new_end_at,
           cost_amount_snapshot  = v_new_cost_snapshot,
           policy_snapshot       = v_new_policy_snapshot,
           applied_rule_ids      = v_new_applied_rule_ids,
           cost_center_id        = v_new_cost_center_id,
           calendar_etag         = v_new_calendar_etag,
           host_person_id        = v_new_host_person_id,
           config_release_id     = v_new_config_release_id,
           status                = v_new_booking_status,
           updated_at            = v_started_at
     where id        = v_target_booking_id
       and tenant_id = p_tenant_id;

    for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
      update public.asset_reservations
         set start_at = (v_asset->>'start_at')::timestamptz,
             end_at   = (v_asset->>'end_at')::timestamptz
       where id        = (v_asset->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = v_target_booking_id;
      get diagnostics v_row_count = row_count;
      v_assets_updated := v_assets_updated + v_row_count;
    end loop;

    for v_order in select * from jsonb_array_elements(v_order_patches) loop
      update public.orders
         set delivery_location_id   = case
                                        when v_order ? 'delivery_location_id'
                                        then nullif(v_order->>'delivery_location_id', '')::uuid
                                        else delivery_location_id
                                      end,
             requested_for_start_at = case
                                        when v_order ? 'requested_for_start_at'
                                        then nullif(v_order->>'requested_for_start_at', '')::timestamptz
                                        else requested_for_start_at
                                      end,
             requested_for_end_at   = case
                                        when v_order ? 'requested_for_end_at'
                                        then nullif(v_order->>'requested_for_end_at', '')::timestamptz
                                        else requested_for_end_at
                                      end
       where id        = (v_order->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = v_target_booking_id;
      get diagnostics v_row_count = row_count;
      v_orders_updated := v_orders_updated + v_row_count;
    end loop;

    -- Approval reconciliation writes + inbox INSERT (defense-in-depth —
    -- unreachable until sub-step H lifts the gate above; kept symmetric
    -- with 00394:798-873 so cutover is gate-flag-only).
    if v_action in ('expire', 'expire_and_insert') then
      if v_approval_state = 'terminal_approved' then
        update public.approvals
           set status       = 'expired',
               responded_at = v_started_at,
               comments     = 'superseded_by_edit (booking edit at ' || v_started_at::text || ')'
         where tenant_id          = p_tenant_id
           and target_entity_type = 'booking'
           and target_entity_id   = v_target_booking_id
           and status             = 'approved';
      end if;
      update public.approvals
         set status       = 'expired',
             responded_at = v_started_at,
             comments     = 'superseded_by_edit (booking edit at ' || v_started_at::text || ')'
       where tenant_id          = p_tenant_id
         and target_entity_type = 'booking'
         and target_entity_id   = v_target_booking_id
         and status             in ('pending', 'delegated');
    end if;

    if v_action in ('insert', 'expire_and_insert') then
      for v_approver in
        select * from jsonb_array_elements(v_new_chain_config->'required_approvers')
      loop
        v_approver_type := v_approver->>'type';
        v_approver_id   := (v_approver->>'id')::uuid;
        insert into public.approvals
          (tenant_id, target_entity_type, target_entity_id,
           approval_chain_id, parallel_group,
           approver_person_id, approver_team_id, status,
           requested_at, created_at)
        values
          (p_tenant_id, 'booking', v_target_booking_id,
           v_new_chain_id, v_parallel_group,
           case when v_approver_type = 'person' then v_approver_id else null end,
           case when v_approver_type = 'team'   then v_approver_id else null end,
           'pending',
           v_started_at, v_started_at);

        -- ─── Hybrid C invariant — atomic inbox INSERT ──────────────────
        if v_approver_type = 'person' then
          insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
          select p_tenant_id, u.id, 'booking.approval_required',
                 jsonb_build_object(
                   'booking_id',          v_target_booking_id,
                   'chain_id',            v_new_chain_id,
                   'approver_person_id',  v_approver_id
                 )
          from public.users u
          where u.person_id = v_approver_id
            and u.tenant_id = p_tenant_id
          on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
            where (payload ? 'chain_id') do nothing;

        elsif v_approver_type = 'team' then
          insert into public.inbox_notifications (tenant_id, user_id, event_kind, payload)
          select p_tenant_id, u.id, 'booking.approval_required',
                 jsonb_build_object(
                   'booking_id',        v_target_booking_id,
                   'chain_id',          v_new_chain_id,
                   'approver_team_id',  v_approver_id
                 )
          from public.team_members tm
          join public.users u
            on u.id = tm.user_id
           and u.tenant_id = p_tenant_id
          where tm.team_id = v_approver_id
            and tm.tenant_id = p_tenant_id
          on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
            where (payload ? 'chain_id') do nothing;
        end if;
      end loop;
    end if;

    for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
      update public.work_orders
         set planned_start_at      = (v_wo->>'planned_start_at')::timestamptz,
             sla_resolution_due_at = case
                                       when v_wo ? 'sla_due_at'
                                       then nullif(v_wo->>'sla_due_at', '')::timestamptz
                                       else sla_resolution_due_at
                                     end,
             updated_at            = v_started_at
       where id        = (v_wo->>'id')::uuid
         and tenant_id = p_tenant_id
         and booking_id = v_target_booking_id;
      get diagnostics v_row_count = row_count;
      v_wo_updated := v_wo_updated + v_row_count;
    end loop;

    v_audit_before := jsonb_build_object(
      'location_id',           v_booking.location_id,
      'start_at',              v_booking.start_at,
      'end_at',                v_booking.end_at,
      'cost_amount_snapshot',  v_booking.cost_amount_snapshot,
      'cost_center_id',        v_booking.cost_center_id,
      'calendar_etag',         v_booking.calendar_etag,
      'applied_rule_ids',      to_jsonb(v_booking.applied_rule_ids),
      'policy_snapshot',       v_booking.policy_snapshot,
      'host_person_id',        v_booking.host_person_id,
      'recurrence_overridden', v_booking.recurrence_overridden,
      'config_release_id',     v_booking.config_release_id,
      'status',                v_booking.status
    );
    v_audit_after := jsonb_build_object(
      'location_id',           v_new_location_id,
      'start_at',              v_new_start_at,
      'end_at',                v_new_end_at,
      'cost_amount_snapshot',  v_new_cost_snapshot,
      'cost_center_id',        v_new_cost_center_id,
      'calendar_etag',         v_new_calendar_etag,
      'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
      'policy_snapshot',       v_new_policy_snapshot,
      'host_person_id',        v_new_host_person_id,
      'recurrence_overridden', v_booking.recurrence_overridden,
      'config_release_id',     v_new_config_release_id,
      'status',                v_new_booking_status
    );

    insert into public.audit_events
      (tenant_id, event_type, entity_type, entity_id, actor_user_id, details, created_at)
    values (
      p_tenant_id,
      'booking.edited',
      'booking',
      v_target_booking_id,
      v_actor_users_id,
      jsonb_build_object(
        'before',                v_audit_before,
        'after',                 v_audit_after,
        'slots_updated',         v_slots_updated,
        'assets_updated',        v_assets_updated,
        'orders_updated',        v_orders_updated,
        'wo_updated',            v_wo_updated,
        'approval_action',       v_action,
        'approval_old_outcome',  v_old_outcome,
        'approval_new_outcome',  v_new_outcome,
        'approval_prior_state',  v_approval_state,
        'approval_chain_id',     v_new_chain_id,
        'idempotency_key',       p_idempotency_key,
        'scope_series_id',       v_single_series_id
      ),
      v_started_at
    );

    insert into public.domain_events
      (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id, created_at)
    values (
      p_tenant_id,
      'booking.edited',
      'booking',
      v_target_booking_id,
      jsonb_build_object(
        'booking_id',      v_target_booking_id,
        'started_at',      v_started_at,
        'idempotency_key', p_idempotency_key,
        'scope_series_id', v_single_series_id
      ),
      v_actor_users_id,
      v_started_at
    );

    if v_booking.location_id is distinct from v_new_location_id then
      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'booking.location_changed',
        p_aggregate_type  => 'booking',
        p_aggregate_id    => v_target_booking_id,
        p_payload         => jsonb_build_object(
          'tenant_id',         p_tenant_id,
          'booking_id',        v_target_booking_id,
          'previous_location', v_booking.location_id,
          'new_location',      v_new_location_id,
          'started_at',        v_started_at,
          'scope_series_id',   v_single_series_id
        ),
        p_idempotency_key => 'booking.location_changed:' || v_target_booking_id::text || ':' || p_idempotency_key,
        p_event_version   => 1,
        p_available_at    => null
      );
      v_per_follow_ups := v_per_follow_ups || to_jsonb('booking.location_changed'::text);
    end if;

    if v_booking.cost_amount_snapshot is distinct from v_new_cost_snapshot then
      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'booking.cost_changed',
        p_aggregate_type  => 'booking',
        p_aggregate_id    => v_target_booking_id,
        p_payload         => jsonb_build_object(
          'tenant_id',       p_tenant_id,
          'booking_id',      v_target_booking_id,
          'previous_cost',   v_booking.cost_amount_snapshot,
          'new_cost',        v_new_cost_snapshot,
          'started_at',      v_started_at,
          'scope_series_id', v_single_series_id
        ),
        p_idempotency_key => 'booking.cost_changed:' || v_target_booking_id::text || ':' || p_idempotency_key,
        p_event_version   => 1,
        p_available_at    => null
      );
      v_per_follow_ups := v_per_follow_ups || to_jsonb('booking.cost_changed'::text);
    end if;

    -- Codex remediation: booking.approval_required emit for §3.6.5 rows
    -- 2/7/8. v3 originally only emitted location/cost/SLA, leaving the
    -- per-occurrence inbox INSERT block (lines 932-963) without an email
    -- partner. When sub-step H lifts the gate at line ~562, scope edits
    -- would inbox-without-email — half-baked. Mirror 00394:990-1008's
    -- emit shape (split person/team arrays); idempotency_key is keyed
    -- by booking_id so each occurrence gets its own dedup boundary
    -- (consistent with location_changed / cost_changed above). The
    -- `chain_config_changed` flag in the per-occurrence plan drives
    -- v_emit_approval_required (set in the §3.6.5 lookup at lines
    -- 502-536), so the same predicate that flipped the inbox INSERT
    -- block on now flips the emit on. Defense-in-depth: unreachable
    -- until sub-step H lifts the gate, but in place + pushed so the
    -- cutover is gate-flag-only.
    if v_emit_approval_required then
      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'booking.approval_required',
        p_aggregate_type  => 'booking',
        p_aggregate_id    => v_target_booking_id,
        p_payload         => jsonb_build_object(
          'tenant_id',           p_tenant_id,
          'booking_id',          v_target_booking_id,
          'chain_id',            v_new_chain_id,
          'approver_person_ids', to_jsonb(v_approver_person_ids),
          'approver_team_ids',   to_jsonb(v_approver_team_ids),
          'started_at',          v_started_at,
          'scope_series_id',     v_single_series_id
        ),
        p_idempotency_key => 'booking.approval_required:' || v_target_booking_id::text || ':' || p_idempotency_key,
        p_event_version   => 1,
        p_available_at    => null
      );
      v_per_follow_ups := v_per_follow_ups || to_jsonb('booking.approval_required'::text);
    end if;

    for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
      if coalesce((v_wo->>'needs_repoint')::boolean, false) then
        perform outbox.emit(
          p_tenant_id       => p_tenant_id,
          p_event_type      => 'sla.timer_repointed_required',
          p_aggregate_type  => 'work_order',
          p_aggregate_id    => (v_wo->>'id')::uuid,
          p_payload         => jsonb_build_object(
            'tenant_id',       p_tenant_id,
            'work_order_id',   (v_wo->>'id')::uuid,
            'sla_policy_id',   nullif(v_wo->>'sla_policy_id', '')::uuid,
            'started_at',      v_started_at,
            'source',          'edit_booking_scope',
            'scope_series_id', v_single_series_id
          ),
          p_idempotency_key => 'sla.timer_repointed_required:' || (v_wo->>'id')::text || ':' || p_idempotency_key,
          p_event_version   => 1,
          p_available_at    => null
        );
        v_per_follow_ups := v_per_follow_ups || to_jsonb('sla.timer_repointed_required'::text);
      end if;
    end loop;

    v_per_occurrence := v_per_occurrence || jsonb_build_object(
      'booking_id',      v_target_booking_id,
      'slots_updated',   v_slots_updated,
      'assets_updated',  v_assets_updated,
      'orders_updated',  v_orders_updated,
      'wo_updated',      v_wo_updated,
      'follow_ups',      v_per_follow_ups,
      'space_id_before', v_slot_space_before,
      'space_id_after',  v_new_location_id,
      'start_at_before', v_slot_start_before,
      'start_at_after',  v_new_start_at
    );
    v_aggregated_follow_ups := v_aggregated_follow_ups || v_per_follow_ups;
    v_committed := v_committed + 1;
  end loop;

  -- ── 8. Assemble result + mark command_operations success ────────────
  if p_dry_run then
    v_result := jsonb_build_object(
      'dry_run',                 true,
      'would_succeed',           true,
      'series_id',               v_single_series_id,
      'per_occurrence',          v_per_occurrence,
      'aggregated_follow_ups',   v_aggregated_follow_ups
    );
    return v_result;
  end if;

  v_result := jsonb_build_object(
    'committed',               v_committed,
    'series_id',               v_single_series_id,
    'per_occurrence',          v_per_occurrence,
    'aggregated_follow_ups',   v_aggregated_follow_ups
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

comment on function public.edit_booking_scope(jsonb, uuid, uuid, text, boolean) is
  'B.4.A.5 sub-step H — controller-vs-notification gate lifted (2026-05-13). Hybrid C invariant unchanged: inbox_notifications row(s) inserted in the same RPC tx as the approvals row(s); booking.approval_required outbox emit per occurrence whose plan flipped approval. Person approver → users.person_id; team approver → team_members.user_id JOIN public.users (tenant-filtered both sides). ON CONFLICT DO NOTHING on uq_inbox_notifications_chain. Error code booking.edit_requires_notification_dispatch stays registered in packages/shared for defense-in-depth — any future regression that re-introduces the gate must reuse it. Companion to TS gate lifts at reservation.service.ts (editOne + editSlot) and assemble-edit-plan.service.ts (editScope per-occurrence loop). Spec: /tmp/b4a5-plan-v2.md sub-step H.';

notify pgrst, 'reload schema';
