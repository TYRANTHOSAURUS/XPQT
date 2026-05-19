-- audit-03 deferred-closeout — P2-3 (consolidate the two create_booking RPC
-- families). Step A: extend the combined RPC's step-10 `approvals` INSERT
-- from 7 columns to 11 so the chain-aware columns
-- (`approval_chain_id` / `parallel_group` / `chain_threshold` /
-- `approver_team_id`) can be carried by the plan.
--
-- ── Why this migration exists ────────────────────────────────────────────
--
-- The no-services single-room create path is being cut over from the legacy
-- 20-arg `create_booking` RPC (00277) onto this combined RPC (P2-3). The
-- legacy path created approval rows in TS via `createApprovalRows`, which
-- writes the 4 chain columns (shared `approval_chain_id`, `parallel_group`,
-- `chain_threshold`, `approver_team_id`). The combined RPC's step-10 INSERT
-- only ever wrote 7 columns — it has no way to persist a `approval_chain_id`,
-- so any approval row it created was SILENTLY un-notified (the 00402 inbox
-- trigger `return new`s when `approval_chain_id IS NULL`). To keep the
-- consolidated path notification-correct, the plan must be able to carry the
-- chain columns and the RPC must insert them.
--
-- ── This supersedes 00372 (CREATE OR REPLACE; verbatim body) ─────────────
--
-- Project pattern for RPC supersession is `CREATE OR REPLACE FUNCTION` with
-- the ENTIRE body re-stated (see 00372 header lines 13-26; 00362/00363/00364
-- ticket family). `ALTER FUNCTION` cannot replace a body. The body below is
-- a VERBATIM reproduction of the LIVE 00372
-- `create_booking_with_attach_plan(jsonb,jsonb,uuid,text)` def (confirmed
-- live: it is the last `create or replace` of this signature across
-- 00309/00315/00372; nothing in 00373..00430 re-creates it — 00410/00412/
-- 00413 only reference it in comments) with ONE — and only one — executable
-- delta:
--
--   step 10 `approvals` INSERT: 7 columns → 11 columns.
--     ADDED columns:  approval_chain_id, parallel_group, chain_threshold,
--                      approver_team_id
--     ADDED value exprs (and NOTHING else changed):
--       approval_chain_id  := nullif(v_approval->>'approval_chain_id','')::uuid
--       parallel_group     := nullif(v_approval->>'parallel_group','')::text
--       chain_threshold    := coalesce(nullif(v_approval->>'chain_threshold',''),'all')
--       approver_team_id   := nullif(v_approval->>'approver_team_id','')::uuid
--
-- Every other line — the advisory lock, the attach_operations idempotency
-- gate (md5 hash, in_progress insert, ON CONFLICT branches), any_deny
-- short-circuit, both validators, the booking INSERT, the booking_slots /
-- orders / asset_reservations / order_line_items loops, the guarded
-- setup_work_order.create_required emit loop, the booking.created outbox
-- emit block + its idempotency key, the cached-result assembly, the
-- attach_operations success UPDATE, the security/search_path attributes, the
-- `revoke … from public; grant … to service_role;` footer, the function
-- comment, and the final `notify pgrst` — is byte-for-byte identical to
-- 00372. (Independently diffed: the body delta is exactly the 4 added
-- column names + their 4 value expressions in step 10. Nothing else.)
--
-- ── CRITICAL C1 — the NOT NULL trap (caught pre-coding) ──────────────────
--
-- `public.approvals.chain_threshold` is `text NOT NULL DEFAULT 'all'`
-- (00400:45). The CURRENT 7-column INSERT gets `'all'` ONLY because it
-- OMITS the column entirely (the column default applies). The instant a
-- value expression is added for it, an absent JSON key MUST still yield
-- `'all'` — NOT NULL — or every EXISTING with-services pending-approval
-- booking (whose `assemblePlan` rows have never carried a
-- `chain_threshold` key) would abort with 23502 NOT-NULL violation, a
-- strict P0 regression on a path that works today.
--
-- Therefore `chain_threshold` uses
--   coalesce(nullif(v_approval->>'chain_threshold',''),'all')
-- (absent OR empty-string → 'all'), byte-behaviour-identical to today's
-- column-default behaviour. The 3 genuinely-nullable columns use
-- `nullif(...,'')::T` so an absent key → SQL NULL (the column's pre-existing
-- behaviour: those columns were simply never written by this INSERT, so
-- they defaulted to NULL). Existing with-services `assemblePlan` rows omit
-- all 4 keys ⇒ chain_id/parallel/team → NULL, threshold → 'all' ⇒
-- byte-behaviour-identical to pre-00431. The C2 plan-builder change in the
-- same slice is what STARTS populating these keys for the with-services
-- path; this migration only makes the columns INSERTABLE without regressing
-- the absent-key case.
--
-- ── Forward-only ─────────────────────────────────────────────────────────
--
-- CREATE OR REPLACE is reversible by re-applying 00372's body; no DROP, no
-- data migration, no destructive change. Idempotent + safe to re-run.

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
  v_existing        public.attach_operations;
  v_payload_hash    text;
  v_lock_key        bigint;
  v_booking_id      uuid;
  v_booking_created timestamptz;
  v_slot            jsonb;
  v_order           jsonb;
  v_ar              jsonb;
  v_oli             jsonb;
  v_approval        jsonb;
  v_setup_emit      jsonb;
  v_event_payload   jsonb;
  v_result          jsonb;
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
  )
  returning created_at into v_booking_created;

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
  --
  -- audit-03 P2-3 — chain-aware columns ADDED (the SOLE executable delta vs
  -- 00372). `chain_threshold` MUST coalesce-to-'all' on an absent/empty key
  -- (C1: the column is NOT NULL DEFAULT 'all' (00400:45); an explicit NULL
  -- aborts 23502 and would break every existing with-services approval
  -- booking whose assemblePlan rows omit the key). The 3 genuinely-nullable
  -- columns become SQL NULL on an absent key (their pre-00431 behaviour:
  -- this INSERT never wrote them, so they defaulted to NULL).
  for v_approval in select * from jsonb_array_elements(p_attach_plan->'approvals')
  loop
    insert into public.approvals (
      id, tenant_id, target_entity_type, target_entity_id,
      approver_person_id, status, scope_breakdown,
      approval_chain_id, parallel_group, chain_threshold, approver_team_id
    ) values (
      (v_approval->>'id')::uuid,
      p_tenant_id,
      v_approval->>'target_entity_type',             -- 'booking' canonicalised
      (v_approval->>'target_entity_id')::uuid,
      (v_approval->>'approver_person_id')::uuid,
      v_approval->>'status',                         -- always 'pending' from plan
      coalesce(v_approval->'scope_breakdown', '{}'::jsonb),
      nullif(v_approval->>'approval_chain_id', '')::uuid,
      nullif(v_approval->>'parallel_group', '')::text,
      coalesce(nullif(v_approval->>'chain_threshold', ''), 'all'),
      nullif(v_approval->>'approver_team_id', '')::uuid
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

  -- ── 12.5. Emit booking.created outbox event (Spec 2026-05-12 §3.5) ─────
  --
  -- NEW in 00372. Universal Workflow Architecture Phase 1.A — Tier 2 wake
  -- mechanism subscribes to this event in WorkflowSpawnWakeHandler. Today
  -- only `booking-flow.service.ts:389,582` writes a `booking.created` row
  -- to `audit_events` (TS-side audit, NOT outbox); per spec §1.4 this
  -- migration promotes the create event to the outbox so the wake handler
  -- can subscribe.
  --
  -- Payload includes the resolution targets (location_id, requester_person_id,
  -- host_person_id) so downstream notification handlers don't re-query
  -- bookings for fields the producer already has in hand. Future schema
  -- migrations on `bookings` MUST keep these columns or bump the event
  -- version (00299:166).
  --
  -- Idempotency key is namespaced + booking_id + p_idempotency_key. The
  -- outer attach_operations gate already short-circuits a same-payload
  -- retry at step 2 (returns the cached result without re-executing this
  -- block), so this emit happens at most once per successful create.
  -- Defense-in-depth: outbox.emit's (tenant_id, idempotency_key) ON
  -- CONFLICT (00299:171-178) makes a partial-failure mid-tx + retry safe
  -- — same key + same payload is a silent no-op.
  --
  -- DETERMINISTIC TIMESTAMP — `started_at` reads the booking row's
  -- `created_at` (captured via RETURNING at step 5). NOT `now()`. Reason:
  -- the outbox computes `payload_hash` from the serialised payload; if a
  -- hypothetical re-entry past the dedup gate produced a payload with a
  -- different wall-clock, the ON CONFLICT (tenant_id, idempotency_key)
  -- would raise 23505 on payload_hash mismatch instead of no-op'ing. The
  -- row's `created_at` is stable within the transaction's snapshot, so
  -- retry computes the same hash.
  perform outbox.emit(
    p_tenant_id       => p_tenant_id,
    p_event_type      => 'booking.created',
    p_aggregate_type  => 'booking',
    p_aggregate_id    => v_booking_id,
    p_payload         => jsonb_build_object(
      'tenant_id',            p_tenant_id,
      'booking_id',           v_booking_id,
      'location_id',          (p_booking_input->>'location_id')::uuid,
      'requester_person_id',  (p_booking_input->>'requester_person_id')::uuid,
      'host_person_id',       nullif(p_booking_input->>'host_person_id', '')::uuid,
      'status',               p_booking_input->>'status',
      'started_at',           v_booking_created
    ),
    p_idempotency_key => 'booking.created:' || v_booking_id::text || ':' || p_idempotency_key,
    p_event_version   => 1,
    p_available_at    => null
  );

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
  'Atomic booking + services creation. Single transaction commits booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions. Idempotent on (tenant_id, idempotency_key) via attach_operations table. Spec §7 of docs/superpowers/specs/2026-05-04-domain-outbox-design.md (v6 idempotency, v8.1 internal-refs validator signature). Phase 1.A (00372): emits booking.created outbox event for the universal-workflow Tier 2 wake mechanism (spec 2026-05-12 §3.5). audit-03 P2-3 (00431): step-10 approvals INSERT extended 7→11 cols (approval_chain_id/parallel_group/chain_threshold/approver_team_id) so the consolidated no-services path stays inbox-notified; chain_threshold coalesces to ''all'' on absent key (C1: NOT NULL DEFAULT, byte-identical to the prior column-default behaviour).';

notify pgrst, 'reload schema';
