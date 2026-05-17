-- 00413_attach_services_invoker_align.sql
--
-- Booking-audit Slice 5 — debt #15 closure, full-review finding I1.
--
-- WHAT: Re-create public.attach_services_to_existing_booking with the SOLE
-- executable delta `SECURITY DEFINER` -> `SECURITY INVOKER`, aligning it to
-- the canonical create-family template `create_booking_with_attach_plan`.
--
-- WHY: The Slice-5 2-agent full-review (I1) found 00412 shipped as
-- `SECURITY DEFINER` while its declared template `create_booking_with_attach
-- _plan` is `SECURITY INVOKER`. Verified against live remote on 2026-05-17:
--   select proname, prosecdef from pg_proc
--     where proname in
--       ('attach_services_to_existing_booking','create_booking_with_attach_plan');
--   -> attach_services_to_existing_booking | t   (SECURITY DEFINER)
--   -> create_booking_with_attach_plan     | f   (SECURITY INVOKER)
-- The 00412 header + decision doc claimed the security posture was
-- "IDENTICAL to the live create RPC" — that claim was factually false and is
-- exactly the pattern-drift the booking-canonicalization audit exists to
-- kill. There is NO behavioral need for DEFINER: the function is granted to
-- `service_role` ONLY and called via `supabase.admin` (service_role bypasses
-- RLS regardless of definer/invoker); tenant isolation is enforced
-- explicitly by `where tenant_id = p_tenant_id` on every read/write. The
-- SECURITY INVOKER `create_booking_with_attach_plan` template emits to the
-- `outbox` schema successfully under the same service_role caller (it is
-- shipped + smoke-gated), proving invoker+service_role can emit to outbox —
-- so invoker is behaviorally equivalent here. Aligning to the template is
-- the best-in-class outcome (one pattern, no drift).
--
-- VERBATIM-REPRO DISCIPLINE: the body below is the EXACT current live
-- 00412 body (captured via
--   pg_get_functiondef('public.attach_services_to_existing_booking
--     (uuid,jsonb,uuid,text)'::regprocedure)
-- on remote 2026-05-17, 251 source lines), reproduced line-for-line. The
-- ONLY executable change is line 4 of the function definition:
--   `SECURITY DEFINER`  ->  `SECURITY INVOKER`
-- Every other line — signature, search_path, declares, the idempotency
-- gate, the FOR-UPDATE booking projection, both validator calls, the
-- orders/asset_reservations/order_line_items/approvals INSERT loops, the
-- guarded setup_work_order.create_required emit, the cached-result build +
-- finalize — is byte-identical to what is deployed. Diff-prove: a `diff`
-- of this CREATE OR REPLACE body against /tmp/live_00412.sql shows exactly
-- one changed line (line 4). The revoke-from-public + grant-to-service_role
-- are re-asserted verbatim from 00412:383-384 (pg_get_functiondef omits
-- ACL); the comment is corrected (the only doc delta) to state the true
-- SECURITY INVOKER posture instead of the false "SECURITY DEFINER" /
-- "IDENTICAL" claim.
--
-- NOT IN SCOPE: the producer-determinism hole (full-review C1 -> discovered
-- finding D-6: buildAttachPlan/hydrateLines bakes Date.now()-derived
-- lead_time_remaining_hours into the hashed plan; same class as D-5/debt
-- #14; shared with the create path). D-6 is deferred-with-owner, bundled
-- with #14 into the producer-determinism slice — see audit 03 Closure
-- Ledger + docs/follow-ups/slice5-attach-services-decision.md. This
-- migration does NOT attempt to fix D-6.

CREATE OR REPLACE FUNCTION public.attach_services_to_existing_booking(p_booking_id uuid, p_attach_plan jsonb, p_tenant_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'outbox'
AS $function$
declare
  v_existing        public.attach_operations;
  v_payload_hash    text;
  v_lock_key        bigint;
  v_booking         public.bookings;
  v_booking_input   jsonb;
  v_order           jsonb;
  v_ar              jsonb;
  v_oli             jsonb;
  v_approval        jsonb;
  v_setup_emit      jsonb;
  v_event_payload   jsonb;
  v_result          jsonb;
begin
  if p_tenant_id is null then
    raise exception 'attach_services_to_existing_booking: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'attach_services_to_existing_booking: p_idempotency_key required';
  end if;
  if p_booking_id is null then
    raise exception 'attach_services_to_existing_booking: p_booking_id required';
  end if;

  -- ── 1. Advisory lock (mirrors live create:28-30) ────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. attach_operations idempotency gate (mirrors live create:32-60) ───
  -- HASH NOTE (header): p_booking_input is server-derived here, so the
  -- caller-supplied payload boundary is p_attach_plan alone. Same md5
  -- primitive the live create RPC uses (live create:33).
  v_payload_hash := md5(coalesce(p_attach_plan::text, ''));

  select * into v_existing
    from public.attach_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash <> v_payload_hash then
      raise exception 'attach_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different attach plan — mint a fresh X-Client-Request-Id';
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

  -- ── 3. any_deny short-circuit (mirrors live create:62-67) ───────────────
  if coalesce((p_attach_plan->>'any_deny')::boolean, false) then
    raise exception 'service_rule_deny: %',
      coalesce(p_attach_plan->'deny_messages'->>0, 'A service rule denied this booking.')
      using errcode = 'P0001';
  end if;

  -- ── 4. Resolve + lock the EXISTING booking (tenant-scoped) ──────────────
  -- FOR UPDATE: serialise concurrent attaches against the same booking and
  -- guarantee the projected fields can't drift between validation + insert.
  -- A foreign-tenant / stale id is rejected HERE, before either validator
  -- runs (the `where tenant_id` clause is the #0-invariant gate).
  select * into v_booking
    from public.bookings
   where id = p_booking_id and tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception 'attach_services_to_existing_booking.booking_not_found: %', p_booking_id
      using errcode = 'P0001';
  end if;

  -- Faithful booking_input projection (VALIDATOR NOTE in header). Carries
  -- exactly the fields validate_attach_plan_tenant_fks +
  -- validate_attach_plan_internal_refs dereference; 'slots' deliberately
  -- omitted (no slots created here; the tenant_fks slot loops then iterate
  -- the empty default — correct for attach-to-existing).
  v_booking_input := jsonb_build_object(
    'booking_id',           v_booking.id,
    'requester_person_id',  v_booking.requester_person_id,
    'host_person_id',       v_booking.host_person_id,
    'booked_by_user_id',    v_booking.booked_by_user_id,
    'location_id',          v_booking.location_id,
    'cost_center_id',       v_booking.cost_center_id,
    'template_id',          v_booking.template_id,
    'recurrence_series_id', v_booking.recurrence_series_id,
    'applied_rule_ids',     coalesce(
                              to_jsonb(v_booking.applied_rule_ids),
                              '[]'::jsonb)
  );

  -- ── 5. Validate every FK in both payloads (mirrors live create:69-71) ───
  perform public.validate_attach_plan_tenant_fks(p_tenant_id, v_booking_input, p_attach_plan);
  perform public.validate_attach_plan_internal_refs(p_tenant_id, v_booking_input, p_attach_plan);

  -- ── 6. INSERT orders (mirrors live create:147-167 step 7) ───────────────
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
      v_booking.id,
      nullif(v_order->>'linked_slot_id', '')::uuid,
      nullif(v_order->>'delivery_location_id', '')::uuid,
      nullif(v_order->>'delivery_date', '')::date,
      nullif(v_order->>'requested_for_start_at', '')::timestamptz,
      nullif(v_order->>'requested_for_end_at', '')::timestamptz,
      v_order->>'initial_status',
      coalesce(v_order->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 7. INSERT asset_reservations (mirrors live create:169-185 step 8) ───
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
      v_booking.id
    );
  end loop;

  -- ── 8. INSERT order_line_items (mirrors live create:187-217 step 9) ─────
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

  -- ── 9. INSERT approvals (mirrors live create:219-239 step 10) ───────────
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

  -- ── 10. Emit setup_work_order.create_required (mirrors live create:245-277
  -- step 12). One event per OLI with setup_emit AND any_pending_approval
  -- false. location_id from the real booking row (live create reads
  -- p_booking_input->>'location_id'; we read the authoritative column).
  if not coalesce((p_attach_plan->>'any_pending_approval')::boolean, false) then
    for v_oli in select * from jsonb_array_elements(p_attach_plan->'order_line_items')
    loop
      if v_oli ? 'setup_emit' and (v_oli->'setup_emit') is not null then
        v_setup_emit := v_oli->'setup_emit';
        v_event_payload := jsonb_build_object(
          'booking_id',                v_booking.id,
          'oli_id',                    (v_oli->>'id')::uuid,
          'service_category',          v_setup_emit->>'service_category',
          'service_window_start_at',   v_oli->>'service_window_start_at',
          'location_id',               v_booking.location_id,
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

  -- ── 11. Build cached result, finalize (mirrors live create:329-349 — but
  -- NO slot_ids / NO booking-create result; the booking already existed).
  v_result := jsonb_build_object(
    'booking_id',             v_booking.id,
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
$function$
;

-- ACL re-asserted verbatim from 00412:383-384 (pg_get_functiondef omits it;
-- CREATE OR REPLACE does not drop existing ACL, but we re-assert to keep the
-- grant authoritative in this migration).
revoke execute on function public.attach_services_to_existing_booking(uuid, jsonb, uuid, text) from public;
grant  execute on function public.attach_services_to_existing_booking(uuid, jsonb, uuid, text) to service_role;

-- Comment corrected (the I1 doc delta): the prior comment asserted
-- "SECURITY DEFINER" — now SECURITY INVOKER, matching the SECURITY INVOKER
-- create_booking_with_attach_plan template (no behavioral change; verified
-- equivalent under the service_role-only grant).
comment on function public.attach_services_to_existing_booking(uuid, jsonb, uuid, text) is
  'Booking-audit Slice 5 (audit 03 P1-3). Atomic replacement for the non-atomic TS attachServicesToBooking + Cleanup undo-queue. Mirrors the attach half of the LIVE create_booking_with_attach_plan (post-00372 body) WITHOUT booking/slot creation: gate on attach_operations (md5 of p_attach_plan), any_deny short-circuit, validate_attach_plan_tenant_fks + validate_attach_plan_internal_refs against a faithful projection of the FOR-UPDATE-locked existing bookings row, then INSERT orders/asset_reservations/order_line_items/approvals + the guarded setup_work_order.create_required outbox emit — all in one transaction. Never writes bookings/booking_slots/visitors. SECURITY INVOKER (00413 — matches the SECURITY INVOKER create_booking_with_attach_plan template; service_role-only grant, tenant isolation enforced explicitly by p_tenant_id on every read/write); revoke-from-public + grant-to-service_role. Known deferred: full-review C1/D-6 producer-determinism (Date.now()-derived lead_time_remaining_hours in the hashed plan via buildAttachPlan; same class as D-5/#14; bundled into the producer-determinism slice — see audit 03 Closure Ledger).';

notify pgrst, 'reload schema';
