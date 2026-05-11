-- B.4.A.3 — edit_booking RPC v1 (skeleton; approval reconciliation deferred).
--
-- Spec: docs/follow-ups/b4-booking-edit-pipeline.md
--         §3.2 (signature),
--         §3.4 (body — steps 1-11 except §3.6.5),
--         §0.1 (source-of-truth contract — every committed field is
--                sticky after this RPC returns),
--         §3.6.5 (approval reconciliation decision table — DEFERRED to
--                  B.4.A.4. v1 raises edit_booking.approval_reconciliation_required
--                  on any plan with approval_outcome_changed=true).
--
-- Sibling RPCs (template for body shape + F-CRIT compliance):
--   - 00309_create_booking_with_attach_plan_rpc.sql — booking-side canonical
--     (row lock pattern, FK validation pattern, atomic write block, outbox
--     emit; signature + comment header style).
--   - 00310_grant_booking_approval_rpc.sql — approval-side canonical
--     (idempotency-wrap pattern + audit_events insert shape).
--   - 00335_update_entity_combined_v5.sql — B.2.A orchestrator template
--     (command_operations gate, payload-hash mismatch handling, multi-
--     branch atomic-write block style, post-write audit event shape).
--   - 00358_grant_ticket_approval_v3.sql — F-CRIT-1 actor resolution
--     (auth_uid → users.id ONCE at top, never pass auth_uid where users.id
--     is expected) + F-CRIT-2 (v_started_at constant captured ONCE).
--   - 00352_start_sla_timers_v2.sql — started_at-as-explicit-parameter
--     pattern for downstream outbox emits.
--
-- ── What this RPC does (v1 / skeleton) ───────────────────────────────────
--
-- One atomic transaction that:
--   1. Resolves the caller's auth_uid → users.id ONCE (F-CRIT-1).
--   2. Captures `started_at = now()` ONCE (F-CRIT-2) for outbox + domain
--      event timestamps so the persisted clock is internally consistent.
--   3. Validates the EditPlan jsonb shape (top-level keys present).
--   4. Acquires a per-(tenant, idempotency_key) advisory lock and a
--      per-booking row lock via SELECT ... FOR UPDATE (mirrors
--      00292:75-83 + 00294:74-80; serialises concurrent edits and
--      concurrent edit-vs-delete).
--   5. Rejects edits on cancelled bookings → booking.cancelled_cannot_edit (422).
--   6. command_operations idempotency gate (same key + same payload →
--      cached_result; same key + different payload → 409
--      command_operations.payload_mismatch). Mirrors 00310's pattern.
--   7. Tenant-validates every FK in the plan via validate_entity_in_tenant
--      v5 (00360): space (slot.space_id + booking.location_id),
--      booking_rule (applied_rule_ids[]), cost_center (booking.cost_center_id),
--      asset (asset_reservation patches), work_order (sla patches). Order
--      patches verify tenant membership inline (orders aren't a kind today).
--   8. Semantic re-derivation gate — compares MAX(room_booking_rules.updated_at)
--      against p_plan._resolution_at. If rules shifted since plan-build → 409
--      automation_plan.stale_resolution (TS caller refetches the plan).
--   9. Approval-flip deferral guard — raises edit_booking.approval_reconciliation_required
--      (422) when p_plan.approval_outcome_changed=true. This is the explicit
--      boundary between v1 and v2: §3.6.5 (terminal_approved with different
--      chain config; allow→require_approval; require_approval→allow with
--      partial chain; etc.) all need careful approval table writes that B.4.A.4
--      will own. The boundary is loud + explicit so callers see the deferral.
--  10. Atomic write block (in order):
--      a. UPDATE booking_slots per slot_patch.
--      b. UPDATE bookings (location, window, cost snapshot, policy snapshot,
--         applied_rule_ids, cost_center_id, calendar_etag, updated_at).
--      c. UPDATE asset_reservations per patch (start_at, end_at; the
--         generated time_range column re-computes automatically per
--         00142:13).
--      d. UPDATE orders per patch (delivery_location_id,
--         requested_for_start_at, requested_for_end_at).
--      e. UPDATE work_orders per sla patch (planned_start_at,
--         sla_resolution_due_at; column name is `sla_resolution_due_at`
--         per 00213:89, NOT the spec's narrative `sla_due_at`).
--  11. Audit row → public.audit_events with aggregate_type='booking'
--      (the logical entity — NOT 'reservation', NOT 'booking_bundle');
--      details payload carries {before, after} diff of every field
--      that changed.
--  12. Domain event → public.domain_events ('booking.edited').
--  13. Outbox events emitted via outbox.emit() (00299):
--      - booking.location_changed if location_id changed.
--      - booking.cost_changed if cost_amount_snapshot delta non-zero.
--      - sla.timer_repointed_required for each WO patch with
--        needs_repoint=true (existing handler is ticket-specific per
--        apps/api/src/modules/outbox/handlers/sla-timer-repoint.handler.ts:74-100
--        — extending it to work_orders is a B.4.A.4 follow-up; the
--        emit shape stays per spec).
--  14. UPDATE command_operations.outcome='success' + cached_result.
--  15. Return { booking, follow_ups }.
--
-- ── EditPlan jsonb contract ──────────────────────────────────────────────
--
-- TS layer builds this from the plan-build phase (reservation.service.ts
-- editOne / editSlot will be rewritten on top of this RPC). Shape:
--
--   {
--     "_resolution_at":            "2026-05-12T13:00:00Z",
--     "rule_outcome_fingerprint":  "<sha256 of {final, matched_rule_ids[], effects}>",
--     "client_request_id":         "<crid>",
--     "approval_outcome_changed":  false,
--
--     "booking": {
--       "location_id":          uuid,           -- primary slot's space_id
--       "start_at":             iso timestamptz, -- MIN(slot.start_at)
--       "end_at":               iso timestamptz, -- MAX(slot.end_at)
--       "cost_amount_snapshot": numeric,
--       "policy_snapshot":      jsonb,
--       "applied_rule_ids":     [uuid],
--       "cost_center_id":       uuid | null,
--       "calendar_etag":        text             -- bumped every edit
--     },
--
--     "slot_patches": [
--       { "slot_id":                 uuid,
--         "space_id":                uuid,
--         "start_at":                iso,
--         "end_at":                  iso,
--         "setup_buffer_minutes":    int,
--         "teardown_buffer_minutes": int,
--         "attendee_count":          int | null,
--         "attendee_person_ids":     [uuid] | null }
--     ],
--
--     "asset_reservation_patches": [
--       { "id": uuid, "start_at": iso, "end_at": iso }
--     ],
--
--     "order_patches": [
--       { "id": uuid,
--         "delivery_location_id":   uuid | null,
--         "requested_for_start_at": iso | null,
--         "requested_for_end_at":   iso | null }
--     ],
--
--     "work_order_sla_patches": [
--       { "id": uuid,
--         "planned_start_at":       iso,
--         "sla_due_at":             iso | null,   -- maps to sla_resolution_due_at
--         "needs_repoint":          boolean }
--     ]
--   }
--
-- ── Raise codes (every one registered in packages/shared/src/error-codes.ts) ─
--
--   edit_booking.actor_not_found                       (404) — auth_uid has no users row
--   edit_booking.not_found                             (404) — booking row missing or wrong tenant
--   edit_booking.invalid_plan_shape                    (400) — top-level p_plan keys missing
--   edit_booking.approval_reconciliation_required      (422) — v1 deferral; B.4.A.4 will REMOVE this
--   booking.cancelled_cannot_edit                      (422) — pre-registered
--   command_operations.payload_mismatch                (409) — pre-registered
--   command_operations.unexpected_state                (500) — pre-registered
--   automation_plan.stale_resolution                   (409) — pre-registered
--   validate_entity_in_tenant.*_not_in_tenant          (404) — pre-registered (00321/00340/00359/00360)
--
-- ── SECURITY DEFINER + search_path ───────────────────────────────────────
--
-- SECURITY DEFINER, search_path = public, pg_catalog (mirrors 00360 /
-- 00358 — the canonical lockdown for any RPC the service-role caller
-- triggers). RLS bypass is acceptable because the helper validates every
-- FK against p_tenant_id explicitly.

create or replace function public.edit_booking(
  p_booking_id      uuid,
  p_plan            jsonb,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, outbox
as $$
declare
  -- F-CRIT-2 — captured ONCE; reused for every persisted timestamp
  -- (audit_events / domain_events created_at, outbox event started_at,
  -- bookings.updated_at on the body UPDATE). Without this, multi-row
  -- writes can interleave with later `now()` reads and produce
  -- internally-inconsistent log entries.
  v_started_at         constant timestamptz := now();

  v_existing           public.command_operations;
  v_payload_hash       text;
  v_lock_key           bigint;

  -- F-CRIT-1 — auth_uid (p_actor_user_id) is the JWT subject. The
  -- users.id required for domain_events.actor_user_id (00019:11) +
  -- audit_events.actor_user_id (00019:30) lives in public.users.id;
  -- the resolution happens ONCE here so a buggy intermediate assignment
  -- can't substitute auth_uid for users.id.
  v_actor_users_id     uuid;

  -- Pre-edit snapshot — for the audit-event diff.
  v_booking            record;

  -- Plan sub-objects.
  v_booking_patch      jsonb;
  v_slot_patches       jsonb;
  v_asset_patches      jsonb;
  v_order_patches      jsonb;
  v_wo_patches         jsonb;

  -- Iteration cursors.
  v_slot               jsonb;
  v_asset              jsonb;
  v_order              jsonb;
  v_wo                 jsonb;
  v_rule_id            uuid;

  -- Derived values from the booking patch.
  v_new_location_id        uuid;
  v_new_start_at           timestamptz;
  v_new_end_at             timestamptz;
  v_new_cost_snapshot      numeric(10,2);
  v_new_policy_snapshot    jsonb;
  v_new_applied_rule_ids   uuid[];
  v_new_cost_center_id     uuid;
  v_new_calendar_etag      text;
  v_resolution_at_ts       timestamptz;

  -- Semantic re-derivation gate.
  v_rules_max_updated_at   timestamptz;

  -- After / before snapshots for the audit row.
  v_audit_before           jsonb;
  v_audit_after            jsonb;

  -- Outbox emit bookkeeping.
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

  -- Required top-level keys: booking (object), slot_patches (array),
  -- _resolution_at (string), approval_outcome_changed (boolean).
  -- The other arrays default to empty if absent.
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

  -- ── 1. F-CRIT-1: actor resolution. auth_uid → users.id ONCE.
  -- Mirrors 00358:112-118. Without this, the audit_events / domain_events
  -- inserts below would FK-violate on actor_user_id because both columns
  -- reference public.users.id, not auth.uid().
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
  -- Mirrors 00335:175-177. Concurrent retries with the same key serialise;
  -- the second waits, then reads the in-progress / success marker and
  -- short-circuits (or detects payload mismatch).
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
  -- Mirrors 00292:75-83 (delete_booking_with_guard) + 00294:74-80
  -- (edit_booking_slot_lock). FOR UPDATE serialises with concurrent
  -- edits AND concurrent deletes — both paths take the same row lock.
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

  -- ── 6. Semantic re-derivation gate (spec §3.4 step 5) ────────────────
  -- If room_booking_rules for this tenant moved since the TS plan-build
  -- snapshot, the operator's plan reflects stale rules → 409 +
  -- TS caller retries. PG-side check is necessary because TS can't
  -- guarantee a serialisable read across plan-build and RPC entry; the
  -- row lock above prevents another writer from racing PAST this gate.
  v_resolution_at_ts := (p_plan->>'_resolution_at')::timestamptz;
  select max(updated_at)
    into v_rules_max_updated_at
    from public.room_booking_rules
   where tenant_id = p_tenant_id;

  if v_rules_max_updated_at is not null
     and v_rules_max_updated_at > v_resolution_at_ts then
    raise exception 'automation_plan.stale_resolution: room_booking_rules.updated_at=% > plan._resolution_at=%',
      v_rules_max_updated_at, v_resolution_at_ts
      using errcode = 'P0001',
            hint = 'The booking rule set changed since the plan was built. Refetch and retry.';
  end if;

  -- ── 7. Approval-flip deferral guard (B.4.A.4 boundary) ───────────────
  -- §3.6.5 covers the 10-row decision table for approval reconciliation
  -- on rule-outcome change (terminal_approved with different chain config
  -- is the dangerous gap codex flagged; allow→require_approval needs a
  -- fresh chain INSERT; require_approval→allow with partial chain needs
  -- chain expiry with comments='superseded_by_edit'). All of that lands
  -- in B.4.A.4. v1 explicitly bails with a registered code so callers
  -- see the deferral instead of a silent half-commit.
  if coalesce((p_plan->>'approval_outcome_changed')::boolean, false) then
    raise exception 'edit_booking.approval_reconciliation_required: plan reports approval_outcome_changed=true; reconciliation lands in B.4.A.4'
      using errcode = 'P0001',
            hint = 'This edit changes the rule outcome''s approval requirement. Retry after B.4.A.4 ships, or revert the change that crosses the approval boundary.';
  end if;

  -- ── 8. Tenant-validate every FK in the plan ──────────────────────────
  -- Each call to validate_entity_in_tenant (v5, 00360) raises 42501
  -- with `<kind>_not_in_tenant` on first miss; map-rpc-error.ts routes
  -- those to 404.
  perform public.validate_entity_in_tenant(
    p_tenant_id, 'space', (v_booking_patch->>'location_id')::uuid
  );

  if (v_booking_patch ? 'cost_center_id')
     and jsonb_typeof(v_booking_patch->'cost_center_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'cost_center', (v_booking_patch->>'cost_center_id')::uuid
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
    -- asset_reservations is the table; the FK kind is 'asset' (the
    -- asset_reservation.id itself isn't an allowlisted kind — tenant
    -- ownership is verified inline below at UPDATE time via the
    -- `tenant_id = p_tenant_id` predicate, and the asset_id FK is
    -- explicitly tenant-checked here).
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
  end loop;

  -- Orders aren't in the validate_entity_in_tenant allowlist (00360:94-102);
  -- verify tenant membership inline. Same defense-in-depth class as the
  -- "no per-element FK on uuid[]" pattern v4 closed.
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
  end loop;

  -- ── 9. Derive new booking values from the patch ──────────────────────
  v_new_location_id    := (v_booking_patch->>'location_id')::uuid;
  v_new_start_at       := (v_booking_patch->>'start_at')::timestamptz;
  v_new_end_at         := (v_booking_patch->>'end_at')::timestamptz;
  v_new_cost_snapshot  := nullif(v_booking_patch->>'cost_amount_snapshot', '')::numeric(10,2);
  v_new_policy_snapshot := coalesce(v_booking_patch->'policy_snapshot', '{}'::jsonb);
  v_new_cost_center_id := nullif(v_booking_patch->>'cost_center_id', '')::uuid;
  v_new_calendar_etag  := v_booking_patch->>'calendar_etag';
  v_new_applied_rule_ids := coalesce(
    (select array_agg(value::uuid)
       from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')),
    v_booking.applied_rule_ids
  );

  -- ── 10. Atomic write block (in spec §3.4 step 6 order) ───────────────

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

  -- 10.b — bookings (location + window + snapshots + etag).
  update public.bookings
     set location_id          = v_new_location_id,
         start_at             = v_new_start_at,
         end_at               = v_new_end_at,
         cost_amount_snapshot = v_new_cost_snapshot,
         policy_snapshot      = v_new_policy_snapshot,
         applied_rule_ids     = v_new_applied_rule_ids,
         cost_center_id       = v_new_cost_center_id,
         calendar_etag        = v_new_calendar_etag,
         updated_at           = v_started_at
   where id        = p_booking_id
     and tenant_id = p_tenant_id;

  -- 10.c — asset_reservations.
  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    update public.asset_reservations
       set start_at = (v_asset->>'start_at')::timestamptz,
           end_at   = (v_asset->>'end_at')::timestamptz
     where id        = (v_asset->>'id')::uuid
       and tenant_id = p_tenant_id;
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
       and tenant_id = p_tenant_id;
    get diagnostics v_row_count = row_count;
    v_orders_updated := v_orders_updated + v_row_count;
  end loop;

  -- 10.e — work_orders sla patches.
  -- Column is `sla_resolution_due_at` per 00213:89; the plan's
  -- narrative name `sla_due_at` maps here.
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
       and tenant_id = p_tenant_id;
    get diagnostics v_row_count = row_count;
    v_wo_updated := v_wo_updated + v_row_count;
  end loop;

  -- ── 11. audit_events insert ──────────────────────────────────────────
  -- aggregate_type='booking' — F-CRIT lesson from the retro: use the
  -- LOGICAL entity name, NOT the legacy synonym ('reservation',
  -- 'booking_bundle'). Spec §3.4 step 7.
  v_audit_before := jsonb_build_object(
    'location_id',          v_booking.location_id,
    'start_at',             v_booking.start_at,
    'end_at',               v_booking.end_at,
    'cost_amount_snapshot', v_booking.cost_amount_snapshot,
    'cost_center_id',       v_booking.cost_center_id,
    'calendar_etag',        v_booking.calendar_etag,
    'applied_rule_ids',     to_jsonb(v_booking.applied_rule_ids),
    'policy_snapshot',      v_booking.policy_snapshot
  );
  v_audit_after := jsonb_build_object(
    'location_id',          v_new_location_id,
    'start_at',             v_new_start_at,
    'end_at',               v_new_end_at,
    'cost_amount_snapshot', v_new_cost_snapshot,
    'cost_center_id',       v_new_cost_center_id,
    'calendar_etag',        v_new_calendar_etag,
    'applied_rule_ids',     to_jsonb(v_new_applied_rule_ids),
    'policy_snapshot',      v_new_policy_snapshot
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
  --
  -- booking.location_changed — fires when the primary slot's space (and
  -- therefore bookings.location_id) moved. Calendar sync + visibility
  -- predicates depend on this.
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

  -- booking.cost_changed — fires when the snapshot delta is non-zero.
  -- IS DISTINCT FROM handles the null↔non-null transitions cleanly.
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
  -- The existing handler is ticket-specific (see
  -- apps/api/src/modules/outbox/handlers/sla-timer-repoint.handler.ts:74-100
  -- — it re-reads tickets.sla_id and calls repoint_sla_timer); extending
  -- the handler to work_orders is a B.4.A.4 follow-up. The emit shape
  -- stays per spec so the future handler picks up these events without
  -- a producer rewrite.
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
      'id',                   p_booking_id,
      'tenant_id',            p_tenant_id,
      'location_id',          v_new_location_id,
      'start_at',             v_new_start_at,
      'end_at',               v_new_end_at,
      'cost_amount_snapshot', v_new_cost_snapshot,
      'cost_center_id',       v_new_cost_center_id,
      'calendar_etag',        v_new_calendar_etag,
      'applied_rule_ids',     to_jsonb(v_new_applied_rule_ids),
      'policy_snapshot',      v_new_policy_snapshot,
      'status',               v_booking.status,
      'updated_at',           v_started_at
    ),
    'follow_ups',  v_emitted,
    'slots_updated',  v_slots_updated,
    'assets_updated', v_assets_updated,
    'orders_updated', v_orders_updated,
    'wo_updated',     v_wo_updated
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke all on function public.edit_booking(uuid, jsonb, uuid, uuid, text) from public;
grant  execute on function public.edit_booking(uuid, jsonb, uuid, uuid, text) to service_role, authenticated;

comment on function public.edit_booking(uuid, jsonb, uuid, uuid, text) is
  'B.4.A.3 — edit_booking RPC v1 (skeleton, approval reconciliation deferred to B.4.A.4). Single atomic transaction commits booking + slots + asset_reservations + orders + work_orders SLA fields, then emits booking.location_changed / booking.cost_changed / sla.timer_repointed_required outbox events. F-CRIT-1: auth_uid → users.id once at top. F-CRIT-2: v_started_at captured once. aggregate_type=''booking'' on audit_events and domain_events (not ''reservation'' or ''booking_bundle''). v1 defers §3.6.5 approval reconciliation — when p_plan.approval_outcome_changed=true the RPC raises edit_booking.approval_reconciliation_required (422) so the boundary is loud. Idempotent on (tenant_id, p_idempotency_key) via command_operations (00316). Tenant-validates every FK via validate_entity_in_tenant v5 (00360). Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4 (steps 1-11 except 6.5).';

notify pgrst, 'reload schema';
