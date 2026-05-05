-- B.0.B.1 — create_booking_with_attach_plan RPC.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.6 (full
-- RPC body — v6 idempotency, v8.1 internal-refs validator signature).
--
-- The single atomic write path for booking + services creation. Replaces the
-- old TS-orchestrated choreography (create_booking RPC → bundle.service.ts
-- attachServicesToBooking → orders/OLIs/asset_reservations/approvals → outbox
-- emit) with one transaction owned by Postgres.
--
-- Inputs:
--   p_booking_input  — BookingInput jsonb (§7.4); booking_id is pre-generated
--                       TS-side (deterministic uuidv5 from idempotency_key).
--   p_attach_plan    — AttachPlan jsonb (§7.4); orders/OLIs/asset_reservations/
--                       approvals all carry pre-generated UUIDs derived from
--                       the same idempotency seed.
--   p_tenant_id      — tenant scope (matches every UUID in both payloads).
--   p_idempotency_key — operation-level key. Same key + same payload_hash
--                       returns the cached result; same key + different
--                       payload raises attach_operations.payload_mismatch.
--
-- Outputs (jsonb cached_result):
--   { booking_id, slot_ids[], order_ids[], order_line_item_ids[],
--     asset_reservation_ids[], approval_ids[], any_pending_approval }
--
-- Concurrency contract (v6 §7.3):
--   1. pg_advisory_xact_lock keyed on (tenant_id, idempotency_key) so two
--      retries on the same key serialise. The second waits, re-reads
--      attach_operations on entry, finds outcome='success', and returns the
--      cached_result.
--   2. attach_operations row is INSERTed inside this tx with outcome
--      ='in_progress'; if any insert below raises (GiST conflict, FK
--      validation, unique_violation), the tx rolls back and the marker goes
--      with it. v6 dropped the 'failed' state — there are no stale rows to
--      clean up; a retry sees an empty attach_operations and starts fresh.
--
-- Validation (§8.1 + §8.2):
--   - validate_attach_plan_tenant_fks (00303) — every UUID exists in tenant.
--   - validate_attach_plan_internal_refs (00304) — every internal cross-ref
--     resolves (e.g. orders[].id === order_line_items[].order_id; v8 sig
--     gained p_tenant_id at 00304:24, called accordingly here).
--
-- Setup-WO outbox emit (§7.6 step 12 + v6-C4):
--   For every OLI in the plan that carries a setup_emit hint AND
--   any_pending_approval=false on the plan, emit one
--   setup_work_order.create_required event via outbox.emit(). Atomic with the
--   inserts above; rollback rolls everything back. When any_pending_approval
--   is true, the OLI's pending_setup_trigger_args column carries the snapshot
--   for approve_booking_setup_trigger (B.0.B.3) to re-emit on grant.
--
-- SECURITY INVOKER, p_tenant_id explicit. Service-role admin client
-- (BookingFlowService) is the only production caller; RLS still applies for
-- any non-service-role caller.

create or replace function public.create_booking_with_attach_plan(
  p_booking_input  jsonb,
  p_attach_plan    jsonb,
  p_tenant_id      uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing       public.attach_operations;
  v_payload_hash   text;
  v_lock_key       bigint;
  v_booking_id     uuid;
  v_slot           jsonb;
  v_order          jsonb;
  v_ar             jsonb;
  v_oli            jsonb;
  v_approval       jsonb;
  v_setup_emit     jsonb;
  v_event_payload  jsonb;
  v_result         jsonb;
begin
  if p_tenant_id is null then
    raise exception 'create_booking_with_attach_plan: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'create_booking_with_attach_plan: p_idempotency_key required';
  end if;

  -- ── 1. Advisory lock (v6-C2) ────────────────────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. attach_operations idempotency gate (§7.3 / 00302) ────────────────
  v_payload_hash := md5(coalesce(p_booking_input::text, '') || '|' ||
                        coalesce(p_attach_plan::text, ''));

  select * into v_existing
    from public.attach_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash <> v_payload_hash then
      raise exception 'attach_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload — see §7.4 for plan UUID derivation';
    else
      -- v6 contract: 'failed' rows do not materialise (rolled back with the
      -- failing tx). Reaching this branch means either an in-flight retry
      -- (would have blocked on the advisory lock above) or a corrupt row.
      raise exception 'attach_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.attach_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 3. any_deny short-circuit (TS plan-builder pre-merged any rule denies)
  if coalesce((p_attach_plan->>'any_deny')::boolean, false) then
    raise exception 'service_rule_deny: %',
      coalesce(p_attach_plan->'deny_messages'->>0, 'A service rule denied this booking.')
      using errcode = 'P0001';
  end if;

  -- ── 4. Validate every FK in both payloads (§8.1 tenant + §8.2 internal) ─
  perform public.validate_attach_plan_tenant_fks(p_tenant_id, p_booking_input, p_attach_plan);
  perform public.validate_attach_plan_internal_refs(p_tenant_id, p_booking_input, p_attach_plan);

  -- ── 5. INSERT booking ────────────────────────────────────────────────
  -- Mirrors create_booking RPC body at 00277:278-296 with TS-pre-generated id.
  v_booking_id := (p_booking_input->>'booking_id')::uuid;
  if v_booking_id is null then
    raise exception 'create_booking_with_attach_plan: booking_input.booking_id required';
  end if;

  insert into public.bookings (
    id, tenant_id, title, description,
    requester_person_id, host_person_id, booked_by_user_id,
    location_id, start_at, end_at, timezone,
    status, source,
    cost_center_id, cost_amount_snapshot,
    policy_snapshot, applied_rule_ids, config_release_id,
    recurrence_series_id, recurrence_index, template_id
  ) values (
    v_booking_id, p_tenant_id,
    p_booking_input->>'title', p_booking_input->>'description',
    (p_booking_input->>'requester_person_id')::uuid,
    nullif(p_booking_input->>'host_person_id', '')::uuid,
    nullif(p_booking_input->>'booked_by_user_id', '')::uuid,
    (p_booking_input->>'location_id')::uuid,
    (p_booking_input->>'start_at')::timestamptz,
    (p_booking_input->>'end_at')::timestamptz,
    coalesce(p_booking_input->>'timezone', 'UTC'),
    p_booking_input->>'status',
    p_booking_input->>'source',
    nullif(p_booking_input->>'cost_center_id', '')::uuid,
    nullif(p_booking_input->>'cost_amount_snapshot', '')::numeric,
    coalesce(p_booking_input->'policy_snapshot', '{}'::jsonb),
    coalesce(
      (select array_agg(value::uuid)
         from jsonb_array_elements_text(p_booking_input->'applied_rule_ids')),
      '{}'),
    nullif(p_booking_input->>'config_release_id', '')::uuid,
    nullif(p_booking_input->>'recurrence_series_id', '')::uuid,
    nullif(p_booking_input->>'recurrence_index', '')::int,
    nullif(p_booking_input->>'template_id', '')::uuid
  );

  -- ── 6. INSERT booking_slots ──────────────────────────────────────────
  -- Mirrors 00277:301-329. The booking_slots_no_overlap GiST exclusion at
  -- 00277:212-217 fires here on conflict (errcode 23P01); whole tx rolls
  -- back, idempotency row goes with it.
  for v_slot in select * from jsonb_array_elements(p_booking_input->'slots')
  loop
    insert into public.booking_slots (
      id, tenant_id, booking_id,
      slot_type, space_id, start_at, end_at,
      attendee_count, attendee_person_ids,
      setup_buffer_minutes, teardown_buffer_minutes,
      status, check_in_required, check_in_grace_minutes,
      display_order
    ) values (
      (v_slot->>'id')::uuid, p_tenant_id, v_booking_id,
      v_slot->>'slot_type',
      (v_slot->>'space_id')::uuid,
      (v_slot->>'start_at')::timestamptz,
      (v_slot->>'end_at')::timestamptz,
      nullif(v_slot->>'attendee_count', '')::int,
      coalesce(
        (select array_agg(value::uuid)
           from jsonb_array_elements_text(v_slot->'attendee_person_ids')),
        '{}'),
      coalesce((v_slot->>'setup_buffer_minutes')::int, 0),
      coalesce((v_slot->>'teardown_buffer_minutes')::int, 0),
      p_booking_input->>'status',                 -- slot status mirrors booking on create
      coalesce((v_slot->>'check_in_required')::boolean, false),
      coalesce((v_slot->>'check_in_grace_minutes')::int, 15),
      coalesce((v_slot->>'display_order')::int, 0)
    );
  end loop;

  -- ── 7. INSERT orders (one per service-type group; bundle.service.ts:213-220)
  for v_order in select * from jsonb_array_elements(p_attach_plan->'orders')
  loop
    insert into public.orders (
      id, tenant_id, requester_person_id, booking_id, linked_slot_id,
      delivery_location_id, delivery_date,
      requested_for_start_at, requested_for_end_at,
      status, policy_snapshot
    ) values (
      (v_order->>'id')::uuid, p_tenant_id,
      (v_order->>'requester_person_id')::uuid,
      v_booking_id,
      nullif(v_order->>'linked_slot_id', '')::uuid,  -- multi-slot tracking deferred (bundle.service.ts:1240) — null in plan today
      nullif(v_order->>'delivery_location_id', '')::uuid,
      nullif(v_order->>'delivery_date', '')::date,
      nullif(v_order->>'requested_for_start_at', '')::timestamptz,
      nullif(v_order->>'requested_for_end_at', '')::timestamptz,
      v_order->>'initial_status',                    -- 'submitted' or 'approved' from plan
      coalesce(v_order->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 8. INSERT asset_reservations (GiST exclusion fires here)
  -- (bundle.service.ts:1316-1330)
  for v_ar in select * from jsonb_array_elements(p_attach_plan->'asset_reservations')
  loop
    insert into public.asset_reservations (
      id, tenant_id, asset_id, start_at, end_at,
      status, requester_person_id, booking_id
    ) values (
      (v_ar->>'id')::uuid, p_tenant_id,
      (v_ar->>'asset_id')::uuid,
      (v_ar->>'start_at')::timestamptz,
      (v_ar->>'end_at')::timestamptz,
      v_ar->>'status',                               -- always 'confirmed' from plan
      (v_ar->>'requester_person_id')::uuid,
      v_booking_id
    );
  end loop;

  -- ── 9. INSERT order_line_items (bundle.service.ts:1260-1287)
  for v_oli in select * from jsonb_array_elements(p_attach_plan->'order_line_items')
  loop
    insert into public.order_line_items (
      id, order_id, tenant_id,
      catalog_item_id, quantity, unit_price, line_total,
      fulfillment_status, fulfillment_team_id, vendor_id,
      menu_item_id, linked_asset_id, linked_asset_reservation_id,
      service_window_start_at, service_window_end_at, repeats_with_series,
      pending_setup_trigger_args, policy_snapshot
    ) values (
      (v_oli->>'id')::uuid,
      (v_oli->>'order_id')::uuid,
      p_tenant_id,
      (v_oli->>'catalog_item_id')::uuid,
      (v_oli->>'quantity')::int,
      nullif(v_oli->>'unit_price', '')::numeric,
      nullif(v_oli->>'line_total', '')::numeric,
      v_oli->>'fulfillment_status',
      nullif(v_oli->>'fulfillment_team_id', '')::uuid,
      nullif(v_oli->>'vendor_id', '')::uuid,
      nullif(v_oli->>'menu_item_id', '')::uuid,
      nullif(v_oli->>'linked_asset_id', '')::uuid,
      nullif(v_oli->>'linked_asset_reservation_id', '')::uuid,
      nullif(v_oli->>'service_window_start_at', '')::timestamptz,
      nullif(v_oli->>'service_window_end_at', '')::timestamptz,
      coalesce((v_oli->>'repeats_with_series')::boolean, true),
      v_oli->'pending_setup_trigger_args',
      coalesce(v_oli->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 10. INSERT approvals (deduped + pre-merged in TS plan; §7.5) ──────
  -- The unique partial index on (target_entity_id, approver_person_id) WHERE
  -- status='pending' enforces dedup at insert time. Plan should already be
  -- deduped, so this should never fire — but if it does, the whole tx rolls
  -- back (correct: a clear failure is better than a silent merge that
  -- contradicts the plan).
  for v_approval in select * from jsonb_array_elements(p_attach_plan->'approvals')
  loop
    insert into public.approvals (
      id, tenant_id, target_entity_type, target_entity_id,
      approver_person_id, status, scope_breakdown
    ) values (
      (v_approval->>'id')::uuid,
      p_tenant_id,
      v_approval->>'target_entity_type',             -- 'booking' canonicalised
      (v_approval->>'target_entity_id')::uuid,
      (v_approval->>'approver_person_id')::uuid,
      v_approval->>'status',                         -- always 'pending' from plan
      coalesce(v_approval->'scope_breakdown', '{}'::jsonb)
    );
  end loop;

  -- ── 11. UPDATE orders.status from 'draft' to 'submitted'/'approved'
  -- No-op in v5+ (initial_status was inserted directly in step 7). Kept as
  -- a comment for parity with the legacy bundle.service.ts:367-373 sequence.

  -- ── 12. Emit setup_work_order.create_required outbox events ────────────
  -- One event per OLI that has setup_emit hint AND any_pending_approval=false.
  -- v6 defense-in-depth: explicit guard so a misbehaving preflight that
  -- forwards setup_emit on a pending plan cannot bypass the approval gate.
  if not coalesce((p_attach_plan->>'any_pending_approval')::boolean, false) then
    for v_oli in select * from jsonb_array_elements(p_attach_plan->'order_line_items')
    loop
      if v_oli ? 'setup_emit' and (v_oli->'setup_emit') is not null then
        v_setup_emit := v_oli->'setup_emit';
        v_event_payload := jsonb_build_object(
          'booking_id',                v_booking_id,
          'oli_id',                    (v_oli->>'id')::uuid,
          'service_category',          v_setup_emit->>'service_category',
          'service_window_start_at',   v_oli->>'service_window_start_at',
          'location_id',               p_booking_input->>'location_id',
          'rule_ids',                  v_setup_emit->'rule_ids',
          'lead_time_override_minutes', nullif(v_setup_emit->>'lead_time_override_minutes','')::int,
          'origin_surface',            'bundle',
          'requires_approval',         coalesce((p_attach_plan->>'any_pending_approval')::boolean, false)
        );
        perform outbox.emit(
          p_tenant_id      => p_tenant_id,
          p_event_type     => 'setup_work_order.create_required',
          p_aggregate_type => 'order_line_item',
          p_aggregate_id   => (v_oli->>'id')::uuid,
          p_payload        => v_event_payload,
          p_idempotency_key => 'setup_work_order.create_required:' || (v_oli->>'id')::text,
          p_event_version  => 1,
          p_available_at   => null
        );
      end if;
    end loop;
  end if;

  -- ── 13. Build cached result, mark operation success ────────────────────
  v_result := jsonb_build_object(
    'booking_id',             v_booking_id,
    'slot_ids',               (select coalesce(jsonb_agg(s->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_booking_input->'slots') s),
    'order_ids',              (select coalesce(jsonb_agg(o->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'orders') o),
    'order_line_item_ids',    (select coalesce(jsonb_agg(li->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'order_line_items') li),
    'asset_reservation_ids',  (select coalesce(jsonb_agg(a->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'asset_reservations') a),
    'approval_ids',           (select coalesce(jsonb_agg(ap->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'approvals') ap),
    'any_pending_approval',   coalesce((p_attach_plan->>'any_pending_approval')::boolean, false)
  );

  update public.attach_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text) from public;
grant  execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text) to service_role;

comment on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text) is
  'Atomic booking + services creation. Single transaction commits booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions. Idempotent on (tenant_id, idempotency_key) via attach_operations table. Spec §7 of docs/superpowers/specs/2026-05-04-domain-outbox-design.md (v6 idempotency, v8.1 internal-refs validator signature).';

notify pgrst, 'reload schema';
