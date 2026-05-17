-- Booking-audit remediation Slice 5 — atomic attach-services-to-existing-
-- booking RPC. Audit: docs/follow-ups/audits/03-booking-reservation.md P1-3.
--
-- Replaces the non-atomic TS-orchestrated `BundleService.attachServicesToBooking`
-- (N supabase-js writes + a reverse-order TS `Cleanup` undo-queue — the same
-- data-loss class the P0-1 cancel bug exposed) with one PL/pgSQL function
-- whose body MIRRORS the attach half of the LIVE
-- `create_booking_with_attach_plan` (verified on remote via
-- pg_get_functiondef — the post-00372 live body; NOT the 00309 base file)
-- with the bookings + booking_slots INSERTs and the slot_ids result key
-- DROPPED. The booking already exists; this RPC only attaches services.
--
-- What it does, in one transaction:
--   1. p_tenant_id / p_idempotency_key required (mirrors live create:21-26).
--   2. Advisory xact lock on hashtextextended(tenant||':'||key,0)
--      (IDENTICAL to live create:28-30).
--   3. attach_operations idempotency gate — payload_hash is
--      md5(coalesce(p_attach_plan::text,'')) — see HASH NOTE below. Gate
--      shape (found→success+hash-match→return cached / mismatch→raise
--      payload_mismatch / else→unexpected_state / insert in_progress) is
--      IDENTICAL to live create:32-60.
--   4. any_deny short-circuit (raise `service_rule_deny: <msg>`, errcode
--      P0001 — IDENTICAL to live create:62-67).
--   5. Resolve + lock the EXISTING booking row (tenant-scoped, FOR UPDATE)
--      and build a faithful `v_booking_input` jsonb projection from it so
--      BOTH validators validate the real booking (NOT a bare stub). See
--      VALIDATOR NOTE below for exactly which fields each validator reads.
--   6. validate_attach_plan_tenant_fks + validate_attach_plan_internal_refs
--      (IDENTICAL call pair to live create:69-71) against v_booking_input.
--   7. INSERT orders / asset_reservations / order_line_items / approvals —
--      column-lists copied BYTE-FOR-BYTE from live create:147-239 (steps
--      7/8/9/10). v_booking_id is the existing booking id (NOT minted).
--   8. setup_work_order.create_required outbox emit, guarded by
--      NOT any_pending_approval — copied EXACTLY from live create:245-277
--      (step 12). location_id read from the real booking row.
--   9. Build cached_result (orders/OLIs/AR/approvals + any_pending_approval;
--      NO slot_ids, NO booking_id-minting), finalize attach_operations to
--      'success' (IDENTICAL to live create:329-349).
--
-- What it deliberately does NOT do (vs the live create RPC):
--   - NO INSERT into public.bookings (step 5 of the create RPC).
--   - NO INSERT into public.booking_slots (step 6 of the create RPC).
--   - NO `booking.created` outbox emit (step 12.5 of the create RPC) — the
--     booking already exists; its create event fired when it was created.
--     Emitting a second booking.created here would double-fire the
--     Universal-Workflow Tier-2 wake handler for an existing booking.
--   - NO slot_ids / booking_id in the result (no booking/slot was created).
--   - NEVER writes public.visitors (single-write-path trigger 00270 owns
--     that surface) — orders/OLIs/AR/approvals + the setup-WO emit ONLY.
--
-- HASH NOTE (D-5 lesson — verify, don't invent):
--   The live create RPC computes
--     md5(coalesce(p_booking_input::text,'') || '|' ||
--         coalesce(p_attach_plan::text,''))   -- live create:33-34
--   Here `p_booking_input` is NOT a caller argument — it's derived from the
--   DB row at execution time. The idempotency boundary for attach is
--   (booking_id, attach plan): the booking row is already immutable for the
--   purpose of an attach (we don't mutate it), so hashing the derived
--   projection would (a) re-hash a server-snapshot value and (b) make the
--   payload-mismatch gate depend on booking-row drift unrelated to the
--   caller's request. The caller's intent is fully captured by
--   `p_attach_plan` (the plan-builder is pure + deterministic on
--   X-Client-Request-Id — bundle.service.ts:594-964; every UUID via
--   planUuid(idempotency_key)). So the hash is
--     md5(coalesce(p_attach_plan::text, ''))
--   — the SAME md5 primitive the live create RPC uses, scoped to the only
--   caller-supplied payload this RPC takes. A same-key replay with an
--   identical plan hashes identically → cached result returned, ZERO
--   duplicate rows. A same-key replay with a DIFFERENT plan (different
--   services) → hash differs → payload_mismatch raised. This is the exact
--   property the smoke gate's (b) determinism + (c) payload-mismatch probes
--   operationalise.
--
-- VALIDATOR NOTE (the one real correctness risk — D-5: verify, not assume):
--   Read in this session:
--     supabase/migrations/00303_validate_attach_plan_tenant_fks.sql
--     LIVE validate_attach_plan_internal_refs (pg_get_functiondef on
--       remote, post-00410 body).
--   validate_attach_plan_tenant_fks dereferences from p_booking_input:
--     requester_person_id (required → persons), host_person_id (opt →
--     persons), booked_by_user_id (opt → users), location_id (required →
--     spaces), cost_center_id (opt → cost_centers), template_id (opt →
--     bundle_templates), recurrence_series_id (opt → recurrence_series),
--     slots[].space_id + slots[].attendee_person_ids[] (iterates
--     coalesce(...->'slots','[]') — vacuous when 'slots' absent). It does
--     NOT touch booking_id and does NOT check the booking exists.
--   validate_attach_plan_internal_refs dereferences from p_booking_input:
--     booking_id (required — raises 22023 if null) and applied_rule_ids[]
--     (§7a — validated against public.room_booking_rules ONLY when the
--     array is non-empty; an attach plan whose booking has no applied room
--     rules passes §7a vacuously — confirmed: the `snap` CTE is empty so
--     `missing` is empty so v_bad stays null). Everything else it reads is
--     attach_plan-internal (orders/OLIs/AR/approvals cross-refs).
--   Therefore v_booking_input MUST be a faithful projection of the REAL,
--   tenant-scoped booking row (NOT a {booking_id} stub) carrying:
--     booking_id, requester_person_id, host_person_id, booked_by_user_id,
--     location_id, cost_center_id, template_id, recurrence_series_id,
--     applied_rule_ids. We OMIT 'slots' on purpose: the booking's slots
--     already exist + were validated at create time, and this RPC creates
--     no slots — passing them would re-run a no-op tenant check; omitting
--     them lets the tenant_fks slot loops iterate the empty default,
--     correct for attach-to-existing. Every projected field comes from the
--     authoritative row under FOR UPDATE, so both validators validate the
--     true booking — provably correct (a foreign-tenant or stale id can't
--     reach here: the booking SELECT is `where id=p_booking_id and
--     tenant_id=p_tenant_id`; a miss raises notfound BEFORE either
--     validator runs).
--
-- security/search_path/revoke/grant IDENTICAL to the live create RPC
-- (SECURITY DEFINER is the live create RPC's posture — pg_get_functiondef
-- shows `SET search_path TO 'public','outbox'` and the function is owned by
-- the migration role / executes with definer rights; revoke-from-public +
-- grant-to-service_role mirrors validate_attach_plan_*).
--
-- Citations (every named symbol Read in this session):
--   - LIVE create_booking_with_attach_plan body: pg_get_functiondef on
--     remote (352 lines) — steps 7/8/9/10 = lines 147-239; step 12 (setup
--     emit) = lines 245-277; gate = lines 28-60; deny = lines 62-67;
--     validators = lines 69-71; finalize = lines 329-349.
--   - supabase/migrations/00302_attach_operations_table.sql (attach_operations).
--   - supabase/migrations/00303_validate_attach_plan_tenant_fks.sql.
--   - LIVE validate_attach_plan_internal_refs (pg_get_functiondef, post-00410).
--   - apps/api/src/modules/booking-bundles/bundle.service.ts:594-964
--     (buildAttachPlan — pure/deterministic plan source).

create or replace function public.attach_services_to_existing_booking(
  p_booking_id      uuid,
  p_attach_plan     jsonb,
  p_tenant_id       uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'outbox'
as $function$
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
$function$;

revoke execute on function public.attach_services_to_existing_booking(uuid, jsonb, uuid, text) from public;
grant  execute on function public.attach_services_to_existing_booking(uuid, jsonb, uuid, text) to service_role;

comment on function public.attach_services_to_existing_booking(uuid, jsonb, uuid, text) is
  'Booking-audit Slice 5 (audit 03 P1-3). Atomic replacement for the non-atomic TS attachServicesToBooking + Cleanup undo-queue. Mirrors the attach half of the LIVE create_booking_with_attach_plan (post-00372 body) WITHOUT booking/slot creation: gate on attach_operations (md5 of p_attach_plan), any_deny short-circuit, validate_attach_plan_tenant_fks + validate_attach_plan_internal_refs against a faithful projection of the FOR-UPDATE-locked existing bookings row, then INSERT orders/asset_reservations/order_line_items/approvals + the guarded setup_work_order.create_required outbox emit — all in one transaction. Never writes bookings/booking_slots/visitors. SECURITY DEFINER; revoke-from-public + grant-to-service_role.';
