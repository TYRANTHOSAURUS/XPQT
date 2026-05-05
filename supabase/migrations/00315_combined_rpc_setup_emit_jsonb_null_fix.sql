-- B.0.F follow-up — fix create_booking_with_attach_plan setup_emit JSON-null check.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.6 step 12.
--
-- Surfaced by the round-trip smoke probe (B.0.F.1) on the third live
-- run after fixing 00313 (validator) and 00314 (grant):
--
--   POST /reservations succeeded; outbox event emitted with
--     service_category=null, rule_ids=null, lead_time_override_minutes=null
--   on an OLI whose rule did NOT actually emit setup (i.e. the OLI's
--   setup_emit was JSON null in the plan, not a real emit hint).
--
-- Root cause: same JSON-null vs SQL-null confusion as 00313. The TS
-- plan-builder serialises every OLI with `setup_emit: null` (default
-- field shape, optionally overwritten in §9 only when the rule outcome
-- has requires_internal_setup=true AND any_pending_approval=false). The
-- 00309 step-12 guard at line 309:
--
--   if v_oli ? 'setup_emit' and (v_oli->'setup_emit') is not null then
--
-- enters the branch when the field is JSON null because:
--   - `?` returns true (key is present in the object)
--   - `(v_oli->'setup_emit') is not null` returns true (jsonb null is
--     NOT SQL NULL)
-- Inside the branch, `v_setup_emit->>'service_category'` returns SQL
-- NULL. Result: a phantom outbox event with all-null fields gets
-- emitted for every OLI that doesn't need a setup emit. The handler
-- then either emits a misconfigured WO or silently no-ops on the empty
-- rule_ids[] check (depending on the routing matrix).
--
-- Fix: replace the `is not null` predicate with
-- `jsonb_typeof = 'object'` — only emit when setup_emit is actually a
-- jsonb object (the only legitimate non-null shape per spec §7.4).
-- JSON null and JSON missing key both fall to the no-op branch.
--
-- This is a sibling of 00313 (the validator's pending_setup_trigger_args
-- check). Both are JSON-null leaks the spec assumed away because the v6
-- spec body said "setup_emit is null on lines that don't need an emit"
-- without distinguishing JSON null from SQL null. Mocked unit tests fed
-- jsonb objects directly (which preserve the distinction), but the
-- supabase-js wire shape stamps `null` literally.

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
      raise exception 'attach_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.attach_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 3. any_deny short-circuit ─────────────────────────────────────────
  if coalesce((p_attach_plan->>'any_deny')::boolean, false) then
    raise exception 'service_rule_deny: %',
      coalesce(p_attach_plan->'deny_messages'->>0, 'A service rule denied this booking.')
      using errcode = 'P0001';
  end if;

  -- ── 4. Validate every FK in both payloads ────────────────────────────
  perform public.validate_attach_plan_tenant_fks(p_tenant_id, p_booking_input, p_attach_plan);
  perform public.validate_attach_plan_internal_refs(p_tenant_id, p_booking_input, p_attach_plan);

  -- ── 5. INSERT booking ────────────────────────────────────────────────
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
      p_booking_input->>'status',
      coalesce((v_slot->>'check_in_required')::boolean, false),
      coalesce((v_slot->>'check_in_grace_minutes')::int, 15),
      coalesce((v_slot->>'display_order')::int, 0)
    );
  end loop;

  -- ── 7. INSERT orders ──────────────────────────────────────────────────
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
      nullif(v_order->>'linked_slot_id', '')::uuid,
      nullif(v_order->>'delivery_location_id', '')::uuid,
      nullif(v_order->>'delivery_date', '')::date,
      nullif(v_order->>'requested_for_start_at', '')::timestamptz,
      nullif(v_order->>'requested_for_end_at', '')::timestamptz,
      v_order->>'initial_status',
      coalesce(v_order->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 8. INSERT asset_reservations ─────────────────────────────────────
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
      v_ar->>'status',
      (v_ar->>'requester_person_id')::uuid,
      v_booking_id
    );
  end loop;

  -- ── 9. INSERT order_line_items ───────────────────────────────────────
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
      -- Filter JSON-null too: if pending_setup_trigger_args was
      -- serialised as `null` from TS (which it is by default), store
      -- SQL NULL on the column so subsequent reads behave correctly.
      case when jsonb_typeof(v_oli->'pending_setup_trigger_args') = 'object'
           then v_oli->'pending_setup_trigger_args'
           else null end,
      coalesce(v_oli->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 10. INSERT approvals ─────────────────────────────────────────────
  for v_approval in select * from jsonb_array_elements(p_attach_plan->'approvals')
  loop
    insert into public.approvals (
      id, tenant_id, target_entity_type, target_entity_id,
      approver_person_id, status, scope_breakdown
    ) values (
      (v_approval->>'id')::uuid,
      p_tenant_id,
      v_approval->>'target_entity_type',
      (v_approval->>'target_entity_id')::uuid,
      (v_approval->>'approver_person_id')::uuid,
      v_approval->>'status',
      coalesce(v_approval->'scope_breakdown', '{}'::jsonb)
    );
  end loop;

  -- ── 11. UPDATE orders.status ────────────────────────────────────────
  -- No-op in v5+; kept as a comment for parity with bundle.service.ts:367-373.

  -- ── 12. Emit setup_work_order.create_required outbox events ────────────
  -- FIX (00315): only emit when setup_emit is a real jsonb OBJECT, not when
  -- it's JSON null (which is the TS default field shape). The pre-fix guard
  --   `v_oli ? 'setup_emit' and (v_oli->'setup_emit') is not null`
  -- entered the branch on JSON null because jsonb null IS NOT SQL NULL.
  -- Result: phantom outbox events with service_category=null, rule_ids=null.
  if not coalesce((p_attach_plan->>'any_pending_approval')::boolean, false) then
    for v_oli in select * from jsonb_array_elements(p_attach_plan->'order_line_items')
    loop
      if jsonb_typeof(v_oli->'setup_emit') = 'object' then
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
  'Atomic booking + services creation. Single transaction commits booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions. Idempotent on (tenant_id, idempotency_key) via attach_operations table. 00315 (B.0.F.1 smoke gate) replaced jsonb is-not-null guards with jsonb_typeof=object so wire-shape JSON nulls (the TS default field shape for setup_emit and pending_setup_trigger_args on inert OLIs) do not trip step 12 emission or persist as bogus jsonb on order_line_items. Spec §7 of docs/superpowers/specs/2026-05-04-domain-outbox-design.md.';

notify pgrst, 'reload schema';
