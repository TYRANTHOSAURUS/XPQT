-- B.4.A.3 — edit_booking RPC v3 (codex P0 hotfix; supersedes 00362).
--
-- Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4.
--
-- v2 → v3 supersession. v3 drops 00362's function and recreates it with two
-- CRITICAL fixes from codex review (both verified by the implementer agent;
-- both were missed by every self-reviewer through v1+v2):
--
--   ── Critical 1 (CRITICAL) — Stale-resolution gate missed destination-room
--      rule changes. ──────────────────────────────────────────────────────
--
--   v2 (00362:369-378) gated room-scoped rules ONLY against the PRE-EDIT
--   booking.location_id:
--       or (target_scope = 'room' and target_id = v_booking.location_id)
--   But the resolver in apps/api/src/modules/room-booking-rules/
--   rule-resolver.service.ts:88-194 evaluates the scenario at
--   `scenario.space_id` — i.e. the EDIT TARGET, not the origin. So the gate
--   could miss the case:
--     1. Booking currently in room A.
--     2. Admin updates a `target_scope='room' target_id=B` rule at T0.
--     3. TS plan-build runs at T0-1; resolver outcome computed AGAINST B
--        (the target the edit wants to move to).
--     4. RPC entry at T0+1; v2 gate checks `target_id = A` only — misses
--        B's updated_at.
--     5. RPC commits with a stale outcome. An approval/deny rule on B is
--        silently bypassed.
--
--   v3 fix: derive v_new_location_id from p_plan.booking.location_id BEFORE
--   the gate (it's a required field already, validated in §0), then check
--   both origin AND destination in the `room` scope:
--       or (target_scope = 'room'
--           and target_id in (v_booking.location_id, v_new_location_id))
--   The `space_subtree` and `room_type` scopes stay conservatively tenant-
--   wide (same as v2) — narrowing those still requires the resolver's
--   ancestor walk (rule-resolver.service.ts:209-236), which is the B.4.A.4
--   follow-up. Trade-off: false-positive 409s when an UNRELATED space_subtree
--   rule changes vs. false-negative commits when the destination room's rule
--   changes. The safer direction is false-positive — caller refetches the
--   plan and the second attempt succeeds.
--
--   ── Critical 2 (CRITICAL) — Child patches were tenant-scoped but not
--      booking-scoped. ────────────────────────────────────────────────────
--
--   v2 validated each work_order/order/asset_reservation patch row by
--   (id, tenant_id) ONLY:
--     - 00362:444-447: validate_entity_in_tenant work_order check.
--     - 00362:451-460: order existence check.
--     - 00362:561-580: asset_reservations UPDATE.
--     - 00362:573-594: orders UPDATE.
--     - 00362:597-610: work_orders UPDATE.
--   Schema has booking-scoping FKs the RPC ignored:
--     - work_orders.booking_id at 00278:86 (FK to bookings, on delete set null).
--     - orders.booking_id      at 00278:108 (FK to bookings, on delete set null).
--     - asset_reservations.booking_id at 00278:135 (FK to bookings, on delete set null).
--   Consequence: a malicious or buggy TS caller could pass any (id, tenant)
--   tuple of ANOTHER booking's child row, and the RPC would rewrite its
--   planned_start_at / delivery_location_id / start_at. Cross-booking data
--   corruption inside the same tenant — a real-world failure mode given the
--   plan-builder constructs these arrays from frontend state.
--
--   v3 fix: every child-row check and UPDATE additionally requires
--   `booking_id = p_booking_id`. Three new error codes (404):
--     - edit_booking.work_order_not_in_booking
--     - edit_booking.order_not_in_booking
--     - edit_booking.asset_reservation_not_in_booking
--   booking_id is NULLABLE on all three tables (verified on remote
--   2026-05-12). A NULL booking_id means the child row isn't anchored to
--   THIS booking; the RPC rejects it (defensive — an edit_booking call
--   should never touch unscoped rows).
--
--   The validate_entity_in_tenant calls for work_order / asset (the asset
--   row, not the reservation) are kept — they still verify the asset / WO
--   exists in the tenant. The booking-scope check is layered ON TOP via the
--   UPDATE's WHERE clause + a row-count check (canonical B.2.A pattern; see
--   00310 grant_booking_approval for FOR UPDATE + row-state verification).
--
-- All v2 fixes (1-9) are preserved verbatim. Citations to v2 in this file
-- refer to 00362 line numbers.
--
-- Sibling RPCs (template for body shape):
--   - 00309_create_booking_with_attach_plan_rpc.sql — booking-side canonical.
--   - 00310_grant_booking_approval_rpc.sql         — approval-side canonical.
--   - 00335_update_entity_combined_v5.sql          — B.2.A orchestrator template.
--   - 00358_grant_ticket_approval_v3.sql           — F-CRIT-1 actor resolution.
--   - 00362_edit_booking_rpc_v2.sql                — predecessor (this v3 supersedes).
--
-- ── EditPlan jsonb contract (unchanged from v2) ─────────────────────────
-- See 00362 header for the full schema. v3 doesn't change the wire shape.
--
-- ── Raise codes ─────────────────────────────────────────────────────────
--   (v2 codes preserved)
--   edit_booking.actor_not_found                       (404)
--   edit_booking.not_found                             (404)
--   edit_booking.invalid_plan_shape                    (400)
--   edit_booking.approval_reconciliation_required     (422)
--   booking.cancelled_cannot_edit                      (422)
--   command_operations.payload_mismatch                (409)
--   command_operations.unexpected_state                (500)
--   automation_plan.stale_resolution                   (409)
--   validate_entity_in_tenant.*_not_in_tenant         (404)
--
--   (v3 new — Critical 2)
--   edit_booking.work_order_not_in_booking             (404)
--   edit_booking.order_not_in_booking                  (404)
--   edit_booking.asset_reservation_not_in_booking     (404)

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
  if not (p_plan ? 'approval_outcome_changed')
     or jsonb_typeof(p_plan->'approval_outcome_changed') not in ('boolean') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval_outcome_changed must be boolean'
      using errcode = 'P0001';
  end if;

  v_booking_patch := p_plan->'booking';
  v_slot_patches  := p_plan->'slot_patches';
  v_asset_patches := coalesce(p_plan->'asset_reservation_patches', '[]'::jsonb);
  v_order_patches := coalesce(p_plan->'order_patches',             '[]'::jsonb);
  v_wo_patches    := coalesce(p_plan->'work_order_sla_patches',    '[]'::jsonb);

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

  -- REQUIRED booking-patch keys must be present (v2 Fix 2).
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

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE. (Unchanged from v2.)
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

  -- v3 Critical 1: derive v_new_location_id BEFORE the stale-resolution
  -- gate so the gate can cover both origin AND destination room rules.
  -- location_id is a REQUIRED field on the booking patch (§0 check at
  -- :220-222), so v_booking_patch->>'location_id' is guaranteed non-null
  -- here. Cast to uuid; if the cast fails it surfaces as a 22P02 invalid
  -- text representation, surfaced via the API filter as a generic
  -- validation error.
  v_new_location_id := (v_booking_patch->>'location_id')::uuid;

  -- ── 6. Semantic re-derivation gate (v3 Critical 1 — cover dest room) ─
  --
  -- Mirror RuleResolverService specificity (rule-resolver.service.ts:88-194):
  --   tenant            → always could match
  --   room              → matches when target_id = scenario.space_id (the
  --                       EVALUATED target). The resolver evaluates against
  --                       the edit's DESTINATION room, so we must check
  --                       BOTH the pre-edit (origin) and the post-edit
  --                       (destination) location ids. If the destination
  --                       equals the origin (no location change), the IN
  --                       list collapses to one id.
  --   space_subtree     → matches when target_id is an ancestor of space_id
  --                       (resolver loadAncestorChain at :209-236).
  --   room_type         → matches when target_id-as-text = space.type.
  --
  -- v3 narrows room scope to (origin, destination). v3 keeps space_subtree
  -- and room_type as conservative tenant-wide includes (same as v2) —
  -- narrowing those needs an ancestor walk in PL/pgSQL, a B.4.A.4 follow-up.
  -- Trade-off direction is safe: false-positive 409 (caller refetches) is
  -- preferable to false-negative commit (silent rule bypass — the v2 bug
  -- v3 is hotfixing).
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

  -- ── 7. Approval-flip deferral guard (B.4.A.4 boundary) ───────────────
  if coalesce((p_plan->>'approval_outcome_changed')::boolean, false) then
    raise exception 'edit_booking.approval_reconciliation_required: plan reports approval_outcome_changed=true; reconciliation lands in B.4.A.4'
      using errcode = 'P0001',
            hint = 'This edit changes the rule outcome''s approval requirement. Retry after B.4.A.4 ships, or revert the change that crosses the approval boundary.';
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

  -- config_release_id has NO tenant validation: the config_releases table
  -- isn't created yet (column is unconstrained `uuid` per 00277:65, planned
  -- for a future FK). v2 wrote through verbatim; v3 preserves.

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

  -- v3 Critical 2: tenant-validate work_order rows AND require booking-scope.
  -- The validate_entity_in_tenant call checks (id, tenant). The booking-
  -- scope check is enforced at the UPDATE site below — a NULL or mismatched
  -- booking_id raises edit_booking.work_order_not_in_booking. We do the
  -- existence check eagerly here so the error surface is uniform across
  -- the three child types.
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

  -- v3 Critical 2: order existence + booking-scope check together.
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

  -- v3 Critical 2: asset_reservations booking-scope check (preflight). The
  -- validate_entity_in_tenant('asset', …) call above checks the ASSET row
  -- the reservation points at, not the reservation row itself. We need a
  -- separate booking-scope check on the asset_reservation row by id.
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
  -- v_new_location_id was derived above (before the stale-resolution gate);
  -- the rest of the required fields read directly; optional fields use
  -- preserve-or-overwrite based on key presence (v2 Fix 2).
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

  -- ── 10. Atomic write block ───────────────────────────────────────────

  -- 10.a — booking_slots (per slot_patch). (Unchanged from v2.)
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

  -- 10.b — bookings. (v2 Fix 1 + Fix 2 preserved.)
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
         updated_at            = v_started_at
   where id        = p_booking_id
     and tenant_id = p_tenant_id;

  -- 10.c — asset_reservations. v3 Critical 2: WHERE clause now includes
  -- booking_id = p_booking_id, so a row from another booking (even within
  -- the same tenant) won't match and won't be rewritten. The preflight at
  -- §8 already raised edit_booking.asset_reservation_not_in_booking if the
  -- id wasn't booking-scoped, so a 0-row UPDATE here would be an
  -- impossible state — but keeping the WHERE-clause defense matches the
  -- canonical defense-in-depth pattern (00310:127-149).
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

  -- 10.d — orders. v3 Critical 2: same booking-scope tightening.
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

  -- 10.e — work_orders sla patches. v3 Critical 2: same booking-scope
  -- tightening.
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
    'config_release_id',     v_booking.config_release_id
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
    'config_release_id',     v_new_config_release_id
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
      'before',          v_audit_before,
      'after',           v_audit_after,
      'slots_updated',   v_slots_updated,
      'assets_updated',  v_assets_updated,
      'orders_updated',  v_orders_updated,
      'wo_updated',      v_wo_updated,
      'idempotency_key', p_idempotency_key
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

  -- sla.timer_repointed_required per WO patch that signalled needs_repoint.
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
      'status',                v_booking.status,
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
-- v2 Fix 5 preserved: service_role only (canonical lockdown — 00309:361,
-- 00310:260, 00358:389).
grant  execute on function public.edit_booking(uuid, jsonb, uuid, uuid, text) to service_role;

comment on function public.edit_booking(uuid, jsonb, uuid, uuid, text) is
  'B.4.A.3 — edit_booking RPC v3 (supersedes 00362). v3 folds two CRITICAL codex fixes that v1+v2 self-review missed: (Critical 1) stale-resolution gate now covers BOTH the pre-edit and post-edit room ids — the resolver evaluates against the destination, so a rule update on the destination room would have been silently bypassed by v2''s origin-only check (00362:369-378). (Critical 2) every child-row patch (work_orders / orders / asset_reservations) now requires booking_id = p_booking_id in addition to tenant_id — booking_id is NULLABLE on all three (00278:91/116/140), and v2 only filtered by tenant, so a buggy/malicious TS caller could rewrite child rows from a different booking in the same tenant. Three new 404 codes added: edit_booking.work_order_not_in_booking, edit_booking.order_not_in_booking, edit_booking.asset_reservation_not_in_booking. All v2 fixes (1-9: extended EditPlan, preserve-or-overwrite, F-CRIT-1 actor resolution, F-CRIT-2 timestamp consistency, service_role-only grant, search_path=public+outbox) are preserved. Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4.';

notify pgrst, 'reload schema';
