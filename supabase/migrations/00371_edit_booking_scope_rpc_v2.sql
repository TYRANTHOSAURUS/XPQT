-- B.4 Step 2F.1 — edit_booking_scope RPC v2 (self-review remediation).
--
-- Supersedes 00367. Drops + recreates `public.edit_booking_scope` to fix
-- the dry-run × idempotency-key contract gap surfaced by both plan- and
-- code-reviewer passes on commit 8a89048a.
--
-- ── What changed vs. 00367 ─────────────────────────────────────────────
--
-- 1. **Dry-run is now stateless** w.r.t. `command_operations`.
--    v1 hashed `p_dry_run` into the payload_hash AND wrote a
--    command_operations row on every dry-run. Two consequences:
--      a) If the TS caller re-uses one idempotency key across "preview"
--         (dry-run) then "commit" (the real call) — the natural pattern
--         where one client-request-id covers an end-to-end user intent
--         — the commit raised `command_operations.payload_mismatch`
--         (409) because the hash differed (`true` vs `false`).
--      b) Every preview clicked an idempotency row into the table that
--         lived indefinitely. Operators previewing N times = N
--         persisted rows.
--    v2 fix: dry-run is a STATELESS preview. It runs the validation
--    block + returns predicted outcomes WITHOUT touching
--    `command_operations` AT ALL (no replay check, no insert, no
--    success update). Commit (dry_run=false) is the only branch that
--    interacts with command_operations.
--    Consequence: dry-run and commit CAN share an idempotency_key —
--    the dry-run path never writes to command_operations, and the
--    payload hash is dry-run-agnostic (computed only over `p_plans`).
--
-- 2. **payload_hash no longer includes p_dry_run.**
--    `md5(p_plans::text)` — semantic inputs only. Symmetric with the
--    intent: the same EditPlan list IS the same edit, regardless of
--    which phase issued the call.
--
-- 3. **booking_not_found error is bounded.**
--    v1 raised `... requested=<v_booking_id_set>` which interpolates up
--    to 200 UUIDs into the error string (~7.6KB per error, logged +
--    forwarded through the stack). v2 raises with a count + the FIRST
--    missing id only (DETAIL), keeping the error string under ~200
--    bytes regardless of N.
--
-- 4. **Per-occurrence before/after fields in the return shape.**
--    Each `per_occurrence[]` entry now also carries `space_id_before`,
--    `space_id_after`, `start_at_before`, `start_at_after`. Step 2F.3's
--    visitor cascade fan-out reads these directly instead of issuing
--    N re-reads against the booking_slots table after commit. Net win
--    on the cascade path; zero cost on the RPC since the values are
--    already in scope.
--
-- 5. **recurrence_overridden defensive guard.**
--    Plan-builder MUST omit `recurrence_overridden` from scope-mode
--    edit plans — series edits don't override per-occurrence; that's a
--    per-occurrence concept. v2 raises `edit_booking_scope.invalid_plans`
--    if any plan tries to set it. Step 2F.2 plan-builder asserts the
--    same at build time; this is defense-in-depth for non-HTTP callers.
--
-- ── Citation discipline ────────────────────────────────────────────────
--
-- All citations from 00367's header still hold. New file: this v2
-- replaces 00367's function body; the 00367 file is preserved on disk
-- for git history but the function in the live DB after this migration
-- runs is the v2 body below.

drop function if exists public.edit_booking_scope(jsonb, uuid, uuid, text, boolean);

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
  v_booking_id_set     uuid[];                    -- after sort

  v_present_count      int;
  v_missing_count      int;
  v_first_missing      uuid;

  v_series_ids         uuid[];
  v_distinct_series    int;
  v_single_series_id   uuid;

  v_booking            record;                    -- per-iteration booking row
  v_target_booking_id  uuid;
  v_plan               jsonb;                     -- the inner EditPlan

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
  v_approver_ids       uuid[];
  v_new_booking_status text;

  -- Per-occurrence plan-derived values.
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

  -- v2 N-4 — per-occurrence before/after snapshots.
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

  -- Per-element shape validation: each must be {booking_id, plan} where
  -- plan is an object. We don't deep-validate the inner plan here — the
  -- per-occurrence path replicates 00364's shape checks (00364:258-356).
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
    -- v2 N-7 — scope-mode plans MUST NOT set recurrence_overridden.
    -- recurrence_overridden is a per-occurrence concept (single occurrence
    -- diverging from the series projection). Series edits move the whole
    -- group; setting recurrence_overridden in a scope plan would
    -- silently corrupt the projection state.
    if (v_plan_elem->'plan'->'booking') ? 'recurrence_overridden' then
      raise exception 'edit_booking_scope.invalid_plans: plan.booking.recurrence_overridden is not valid in scope-mode plans (index=%)', v_plan_index
        using errcode = 'P0001',
              hint = 'recurrence_overridden is a per-occurrence concept. The Step 2F.2 plan-builder must omit it from scope-mode edit plans.';
    end if;
    v_plan_index := v_plan_index + 1;
  end loop;

  -- ── 1. F-CRIT-1: auth_uid → users.id (mirrors 00364:357-371) ─────────
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
  -- Held on commit-path only; dry-runs are stateless previews and don't
  -- take the lock either (no command_operations row → no need to
  -- serialise replays). Cleaner semantics + cheaper preview path.
  if not p_dry_run then
    v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
    perform pg_advisory_xact_lock(v_lock_key);
  end if;

  -- ── 3. command_operations idempotency gate (commit-only) ────────────
  -- v2 fix: dry-run is a stateless preview. It NEVER touches
  -- command_operations — no replay check, no insert, no success update.
  -- Commit path is unchanged from v1 except the payload_hash no longer
  -- mixes p_dry_run (so a prior commit's hash matches a fresh commit
  -- with the same plans).
  v_payload_hash := md5(coalesce(p_plans::text, ''));

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

  -- Duplicate booking_ids are an upstream bug — TS plan-build must produce
  -- one plan per occurrence. Fail loudly rather than silently double-write.
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

  -- Verify every booking_id was present. v2: bound the error message —
  -- name the count + the first missing id, NOT the full requested set
  -- (could be 200 UUIDs, ~7.6KB error string).
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

    -- Reset per-occurrence accumulators.
    v_slots_updated  := 0;
    v_assets_updated := 0;
    v_orders_updated := 0;
    v_wo_updated     := 0;
    v_per_follow_ups := '[]'::jsonb;
    v_emit_approval_required := false;
    v_approver_ids := '{}'::uuid[];
    v_new_chain_id := null;
    v_parallel_group := null;

    -- 7.a — load pre-edit snapshot (already locked at step 5).
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

    -- Plan shape validation per occurrence (mirrors 00364:258-356).
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

    -- 7.b — cancelled-state guard (mirrors 00364:425-430).
    if v_booking.status = 'cancelled' then
      raise exception 'booking.cancelled_cannot_edit: booking=% is cancelled and can no longer be edited',
        v_target_booking_id
        using errcode = 'P0001';
    end if;

    v_new_location_id := (v_booking_patch->>'location_id')::uuid;

    -- 7.c — semantic re-derivation gate (mirrors 00364:435-454).
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

    -- 7.d — approval reconciliation (mirrors 00364:456-580).
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

    -- 7.e — B.4.A.5 controller-vs-notification gate (third emit site).
    if v_emit_approval_required then
      raise exception 'booking.edit_requires_notification_dispatch: booking=% would emit booking.approval_required (rows 2/7/8 of §3.6.5) before notification dispatch ships in B.4.A.5',
        v_target_booking_id
        using errcode = 'P0001',
              hint = 'Until B.4.A.5 ships notification dispatch (email approvers + in-app inbox), edits that change approval requirements are blocked.';
    end if;

    -- 7.f — validate new chain config + collect approver_ids (mirrors
    -- 00364:577-633). Defensive carryover from 00364; reachable only if
    -- v_emit_approval_required would have stayed false but action is
    -- still insert/expire_and_insert (no such path post B.4.A.5 gate).
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
      v_approver_ids := '{}'::uuid[];

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
        elsif v_approver_type = 'team' then
          perform public.validate_entity_in_tenant(p_tenant_id, 'team', v_approver_id);
        else
          raise exception 'edit_booking.invalid_plan_shape: approver type must be person|team (booking=%, got %)', v_target_booking_id, v_approver_type
            using errcode = 'P0001';
        end if;

        v_approver_ids := array_append(v_approver_ids, v_approver_id);
      end loop;

      if array_length(v_approver_ids, 1) is null then
        raise exception 'edit_booking.invalid_plan_shape: plan.approval.new_chain_config.required_approvers cannot be empty (booking=%)', v_target_booking_id
          using errcode = 'P0001';
      end if;
    end if;

    -- 7.g — tenant-validate every other FK in the plan.
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

    -- 7.h — derive new booking values.
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

    -- v2 N-4 — capture per-occurrence before-snapshot for the return
    -- shape (first slot in slot_patches; scope-mode plans always have
    -- one slot patch per occurrence).
    v_slot_space_before := null;
    v_slot_start_before := null;
    select bs.space_id, bs.start_at
      into v_slot_space_before, v_slot_start_before
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.booking_id = v_target_booking_id
     order by bs.display_order asc
     limit 1;

    -- 7.i — DRY-RUN short-circuit: record outcome + continue.
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
        -- v2 N-4 — per-occurrence before/after for visitor cascade fan-out.
        'space_id_before',      v_slot_space_before,
        'space_id_after',       v_new_location_id,
        'start_at_before',      v_slot_start_before,
        'start_at_after',       v_new_start_at
      );

      v_aggregated_follow_ups := v_aggregated_follow_ups || v_per_follow_ups;
      continue;
    end if;

    -- 7.j — atomic write block.
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
    -- Note: recurrence_overridden is NOT updated by scope-mode edits
    -- (see argument-validation gate above). It stays at whatever
    -- per-occurrence editOne set it to (or its create-time default).

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

    -- Approval reconciliation writes (defense-in-depth — unreachable
    -- post B.4.A.5 gate but kept symmetric with 00364:878-927).
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

    -- 7.k — audit + domain_events per occurrence.
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
      -- v2: scope edits do NOT touch recurrence_overridden; preserve.
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

    -- 7.l — outbox emits per occurrence.
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

    -- 7.m — accumulate per-occurrence outcome (with v2 N-4 before/after).
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
    -- v2: dry-run never touches command_operations. Return + bail.
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

revoke all on function public.edit_booking_scope(jsonb, uuid, uuid, text, boolean) from public;
-- service_role only (canonical lockdown — 00309:361, 00310:260, 00358:389, 00364:1141).
grant  execute on function public.edit_booking_scope(jsonb, uuid, uuid, text, boolean) to service_role;

comment on function public.edit_booking_scope(jsonb, uuid, uuid, text, boolean) is
  'B.4 Step 2F.1 v2 (00371) — edit_booking_scope RPC. Supersedes 00367. Atomic write across N occurrences of a recurrence series. v2 contract: dry-run is a STATELESS preview — does NOT touch command_operations (no replay, no insert, no success update); payload_hash no longer mixes p_dry_run (so dry-run and commit can share an idempotency_key); booking_not_found error bounded (count + first missing id, not the full set); per-occurrence result now carries space_id_before/after + start_at_before/after for the visitor cascade fan-out in Step 2F.3; recurrence_overridden is rejected from scope-mode plans (per-occurrence concept, not a series-edit field). Mirrors edit_booking (00364) per-occurrence semantics — semantic re-derivation gate, approval reconciliation per §3.6.5, FK validation via validate_entity_in_tenant. Defense-in-depth: (1) all booking_ids must share the same non-null recurrence_series_id (raises edit_booking_scope.mixed_series 422 on mismatch); (2) N > 200 hard cap (raises edit_booking_scope.too_many_occurrences 422); (3) B.4.A.5 controller-vs-notification gate at every approval-required emit site refuses plans before notification dispatch ships. Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.6.5 + §7.B.4.C + b4-followups.md §"Step 2F.1 dry-run idempotency contract".';

notify pgrst, 'reload schema';
