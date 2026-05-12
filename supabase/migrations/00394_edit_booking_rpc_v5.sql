-- B.4.A.5 sub-step B · 00394 · edit_booking RPC v5 (supersedes 00364 v4).
--
-- Hybrid C invariant — the inbox_notifications row(s) for a fresh approval
-- chain are INSERTed in the SAME RPC tx as the approvals row(s), so the
-- /me/inbox surface (Sub-step E) never lags behind the booking state. Spec
-- ref: /tmp/b4a5-plan-v2.md §Locked decisions #5 + #7 + sub-step B.
--
-- ── What changed vs. 00364 ──────────────────────────────────────────────
--
-- 1. **Inbox INSERT alongside the approval-chain INSERT.**
--    v4 has ONE approval-chain INSERT site (00364:906-927 — the
--    `if v_action in ('insert', 'expire_and_insert')` loop over
--    `required_approvers`). v5 wraps each approver INSERT in a
--    co-located inbox INSERT that:
--      - Person approver → INSERT one inbox row for the user whose
--        `users.person_id = v_approver_id`, in `p_tenant_id`.
--      - Team approver → fan-out via `team_members` joined on
--        `team_members.user_id = users.id`, tenant-filtered both sides
--        (00003:119-126 confirms `user_id` is the team_members → users
--        FK column). Codex pick A — fan-out lives INSIDE the RPC so
--        `inbox_notifications` is the single source of truth for the
--        per-user inbox surface.
--      - ON CONFLICT DO NOTHING on the partial unique index from 00391
--        (`uq_inbox_notifications_chain` predicate
--        `(payload ? 'chain_id')`). The ON CONFLICT WHERE clause MUST
--        match the partial index's WHERE clause exactly — Postgres
--        partial-index conflict-target rule, validated by 00391's
--        end-of-file probe.
--
-- 2. **Outbox payload: split mixed `approver_ids` into two typed arrays.**
--    v4 emitted `{ chain_id, approver_ids: uuid[], started_at }` where
--    `approver_ids` mixed person ids and team ids — the consumer had to
--    re-classify each id. v5 emits:
--      { booking_id, chain_id, approver_person_ids: uuid[],
--        approver_team_ids: uuid[], started_at }
--    The `approver_person_ids` key holds `persons.id` values (sourced
--    from `required_approvers[n].id` where `type='person'`). The Sub-step D
--    handler fans person → user via `users.person_id` JOIN — the same way
--    the inbox INSERT block below already does — and fans team → user via
--    a `team_members` JOIN. The split shape required a parallel update to
--    apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts
--    + its spec to keep TS compile + jest gates green (the handler is
--    still a stub that logs; sub-step D fills in dispatch).
--
--    NOTE: the v5 self-review remediation (commit 7852ebf0 follow-up)
--    renamed the array from the original `approver_user_ids` to
--    `approver_person_ids` because the contents are person ids, NOT user
--    ids. The original name lied about the contents and would have caused
--    the sub-step D handler to find zero rows on a `users WHERE id =
--    any(...)` lookup. `approver_team_ids` is unchanged — those ARE team
--    ids.
--
-- 3. **No `inbox_written` flag on the outbox payload.**
--    Architect N3 (plan v2) — `ON CONFLICT DO NOTHING` on
--    inbox_notifications is the sole idempotency boundary for the inbox
--    write. There is no consumer-side "did the producer write inbox?"
--    hint to leak. The outbox handler (sub-step D) handles email-only.
--
-- ── Code preserved byte-identically from v4 ─────────────────────────────
--
-- Everything outside the changes above. Specifically:
--   - All §3.6.5 Row 1-10 decision-table semantics (00364:482-572).
--   - All v3 critical fixes (origin+destination room scope on the
--     stale-resolution gate; booking-scope on every child patch).
--   - All v4 expiry shapes (00364:879-904) — `superseded_by_edit` comment,
--     terminal_approved → expire 'approved' rows extension for Row 8.
--   - Approval INSERT loop body (00364:906-927) — single chain_id,
--     parallel_group from threshold='all'|'any', no step_number.
--   - F-CRIT-1 actor resolution; advisory lock; command_operations
--     idempotency gate; FK validation; audit + domain_events;
--     booking.location_changed + booking.cost_changed +
--     sla.timer_repointed_required outbox emits.
--
-- ── Citations (verified in current main 2026-05-13) ─────────────────────
--
-- - supabase/migrations/00003_people_users_roles.sql:119-126 —
--   public.team_members(team_id, user_id) FK (NOT person_id).
-- - supabase/migrations/00391_inbox_notifications.sql:60-63 — partial
--   unique index `uq_inbox_notifications_chain` with WHERE
--   `(payload ? 'chain_id')`.
-- - supabase/migrations/00364_edit_booking_rpc_v4.sql — full v4 body
--   (preserved verbatim apart from the deltas above).
-- - apps/api/src/modules/outbox/handlers/booking-approval-required.handler.ts
--   — stub handler; field rename done in same commit so this migration
--   doesn't break TS compile.

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
  v_payload_hash := md5(coalesce(p_plan::text, ''));

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

notify pgrst, 'reload schema';
