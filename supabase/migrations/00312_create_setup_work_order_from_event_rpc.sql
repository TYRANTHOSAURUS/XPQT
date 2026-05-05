-- B.0.B.4 — create_setup_work_order_from_event RPC.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.8.2
-- (v8-C1 fix: derive identity from outbox.events, not row JSON; v8.1-C1
-- enforces requester_person_id NULL via validate_setup_wo_fks at 00305).
--
-- Handler-side RPC for setup_work_order.create_required outbox events. One
-- transaction commits the work_orders row + setup_work_order_emissions
-- dedup row + domain_events + audit_events row. Replaces the legacy
-- TicketService.createBookingOriginWorkOrder choreography (insert WO →
-- addActivity → logDomainEvent → audit log; four sequential HTTP calls
-- where the activity log can land while the WO insert fails — exactly the
-- split-write pattern this whole spec exists to eliminate).
--
-- v8-C1 — chain-derived identity (the v7 hole).
--   v7 trusted p_wo_row_data for linked_order_line_item_id, location_id,
--   assigned_team_id, sla_id, etc. A buggy row-builder or compromised
--   handler could pass an OLI id from a different event's aggregate OR
--   cross-tenant FK values. v8 stops trusting the row JSON for identity:
--     1. Load the outbox.events row (event_id + tenant + event_type guard).
--     2. v_oli_id := event.aggregate_id.
--     3. Validate OLI → order → booking chain under tenant; v_booking_id is
--        DERIVED from the chain.
--     4. Cross-check the row JSON's linked_order_line_item_id and (if
--        present) booking_id against the chain-derived ids. Disagreement
--        raises setup_wo.row_oli_mismatch / setup_wo.row_booking_mismatch
--        BEFORE any insert.
--     5. validate_setup_wo_fks (00305) checks every tenant-owned FK in the
--        row JSON (location_id, assigned_team_id, assigned_user_id,
--        assigned_vendor_id, sla_id, request_type_id) + rejects non-null
--        requester_person_id (v8.1-C1 visibility hygiene).
--     6. Identity values written to public.work_orders come from the chain
--        (v_booking_id, v_oli_id); the row JSON only contributes title,
--        description, priority, assigned_*, sla_*, audit_metadata.
--
-- v8-I4 (already in 00307): setup_work_order_emissions.work_order_id is
--   ON DELETE SET NULL, so admin WO deletion leaves a TOMBSTONE row
--   (work_order_id = NULL). The handler treats tombstones as
--   already_handled_tombstone (NOT a re-create signal). To explicitly reset
--   setup-WO creation for an OLI, admins DELETE the dedup row.
--
-- Inputs:
--   p_event_id        — outbox.events.id (worker-claimed; verified here).
--   p_tenant_id       — tenant scope (cross-checked against event.tenant_id).
--   p_wo_row_data     — SetupWorkOrderRowData jsonb. Identity fields are
--                        CROSS-CHECKED against the chain, not trusted; non-
--                        identity fields (title/description/priority/team/
--                        sla/audit_metadata) are inserted as-is after FK
--                        validation.
--   p_idempotency_key — 'setup_work_order:<oli_id>'; unused for SQL-side
--                        dedup (the (tenant_id, oli_id) PK on
--                        setup_work_order_emissions is the source of truth);
--                        retained on the contract for audit/observability.
--
-- Outputs (jsonb):
--   { kind: 'created' | 'already_created' | 'already_handled_tombstone',
--     work_order_id: uuid | null }
--
-- SECURITY INVOKER, service-role grant only. Called by the outbox worker
-- (B.0.E) after the row-builder produces SetupWorkOrderRowData TS-side.

create or replace function public.create_setup_work_order_from_event(
  p_event_id        uuid,
  p_tenant_id       uuid,
  p_wo_row_data     jsonb,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_event            outbox.events%rowtype;
  v_oli_id           uuid;
  v_order_id         uuid;
  v_booking_id       uuid;
  v_existing_wo_id   uuid;
  v_existed          boolean;
  v_lock_key         bigint;
  v_work_order_id    uuid;
  v_audit_metadata   jsonb;
  v_row_oli_id       uuid;
begin
  if p_tenant_id is null then
    raise exception 'create_setup_work_order_from_event: p_tenant_id required';
  end if;

  -- ── 1. Load the outbox event row (canonical source of identity, v8-C1). ─
  -- The row's tenant_id MUST match p_tenant_id; the event_type MUST be the
  -- setup-WO type. Either failure is a bug in the worker (claimed the wrong
  -- event for this RPC) and aborts before any side effect.
  select * into v_event
    from outbox.events
   where id = p_event_id
     and tenant_id = p_tenant_id
     and event_type = 'setup_work_order.create_required';
  if not found then
    raise exception 'setup_wo.event_not_found event_id=% tenant_id=%',
      p_event_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  v_oli_id := v_event.aggregate_id;
  if v_oli_id is null then
    raise exception 'setup_wo.event_missing_aggregate event_id=%', p_event_id
      using errcode = 'P0002';
  end if;

  -- ── 2. Validate OLI → order → booking chain under tenant. v_booking_id is
  -- DERIVED from the chain; we do not trust p_wo_row_data->>'booking_id'.
  select oli.order_id, o.booking_id
    into v_order_id, v_booking_id
    from public.order_line_items oli
    join public.orders            o on o.id = oli.order_id
   where oli.id        = v_oli_id
     and oli.tenant_id = p_tenant_id
     and o.tenant_id   = p_tenant_id;
  if not found then
    raise exception 'setup_wo.oli_chain_invalid oli_id=% tenant_id=%',
      v_oli_id, p_tenant_id
      using errcode = 'P0002',
            detail = 'OLI does not exist in tenant or order chain is broken';
  end if;

  -- ── 3. Cross-check the row JSON's identity fields against the derived
  -- ids. If they disagree, the row-builder is buggy/compromised — raise
  -- LOUDLY and roll back before any side effect.
  v_row_oli_id := nullif(p_wo_row_data->>'linked_order_line_item_id', '')::uuid;
  if v_row_oli_id is null then
    raise exception 'setup_wo.row_oli_missing'
      using errcode = 'P0001';
  end if;
  if v_row_oli_id <> v_oli_id then
    raise exception 'setup_wo.row_oli_mismatch row=% event_aggregate=%',
      v_row_oli_id, v_oli_id
      using errcode = 'P0001',
            hint = 'Row-builder produced an OLI id that does not match the event aggregate. Fix the builder.';
  end if;
  -- booking_id: if present in the row JSON, must agree with the chain.
  if p_wo_row_data ? 'booking_id'
     and p_wo_row_data->>'booking_id' is not null
     and length(p_wo_row_data->>'booking_id') > 0
     and (p_wo_row_data->>'booking_id')::uuid <> v_booking_id then
    raise exception 'setup_wo.row_booking_mismatch row=% chain=%',
      (p_wo_row_data->>'booking_id')::uuid, v_booking_id
      using errcode = 'P0001';
  end if;

  -- ── 4. Validate every tenant-owned FK field in the row JSON (v8-C1)
  -- via the 00305 helper. Also rejects non-null requester_person_id
  -- (v8.1-C1 visibility hygiene per ticket.service.ts:1889).
  perform public.validate_setup_wo_fks(p_tenant_id, v_booking_id, p_wo_row_data);

  -- ── 5. Per-OLI advisory lock — serialises concurrent handler retries.
  v_lock_key := hashtextextended(p_tenant_id::text || ':setup_wo:' || v_oli_id::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 6. Already created? v8-I4: ON DELETE SET NULL means a row with
  -- work_order_id IS NULL is a TOMBSTONE (admin deleted the WO). Treat as
  -- already_handled — admin must explicitly DELETE the dedup row to allow
  -- re-creation. See 00307 + spec §2.5.
  select work_order_id into v_existing_wo_id
    from public.setup_work_order_emissions
   where tenant_id = p_tenant_id and oli_id = v_oli_id
   for update;
  v_existed := found;
  if v_existed then
    return jsonb_build_object(
      'kind',          case when v_existing_wo_id is null then 'already_handled_tombstone'
                            else 'already_created' end,
      'work_order_id', v_existing_wo_id
    );
  end if;

  -- ── 7. INSERT the work order. Identity fields use the DERIVED values
  -- (v_booking_id, v_oli_id), NOT p_wo_row_data. Tenant_id is stamped from
  -- p_tenant_id. Non-identity row fields (title, description, priority,
  -- assigned_team_id, sla_id, etc.) come from p_wo_row_data after step 4
  -- validated them.
  v_work_order_id := gen_random_uuid();
  v_audit_metadata := coalesce(p_wo_row_data->'audit_metadata', '{}'::jsonb);

  insert into public.work_orders (
    id, tenant_id,
    parent_kind, parent_ticket_id,
    booking_id, linked_order_line_item_id,
    title, description, priority,
    interaction_mode, status, status_category,
    requester_person_id, location_id,
    assigned_team_id, assigned_user_id, assigned_vendor_id,
    sla_id, sla_resolution_due_at,
    source_channel
  ) values (
    v_work_order_id, p_tenant_id,
    p_wo_row_data->>'parent_kind',
    nullif(p_wo_row_data->>'parent_ticket_id', '')::uuid,
    v_booking_id,                                        -- DERIVED, v8-C1
    v_oli_id,                                            -- DERIVED, v8-C1
    p_wo_row_data->>'title',
    nullif(p_wo_row_data->>'description', ''),
    coalesce(p_wo_row_data->>'priority', 'medium'),
    p_wo_row_data->>'interaction_mode',
    p_wo_row_data->>'status',
    p_wo_row_data->>'status_category',
    nullif(p_wo_row_data->>'requester_person_id', '')::uuid,  -- always NULL after 00305 reject
    nullif(p_wo_row_data->>'location_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_team_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_user_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_vendor_id', '')::uuid,
    nullif(p_wo_row_data->>'sla_id', '')::uuid,
    nullif(p_wo_row_data->>'sla_resolution_due_at', '')::timestamptz,
    p_wo_row_data->>'source_channel'
  );

  -- ── 8. INSERT the dedup row in the SAME tx. PK is (tenant_id, oli_id);
  -- a concurrent handler that somehow inserted before us (shouldn't happen
  -- with the advisory lock, defensive) raises 23505 and rolls the WHOLE tx
  -- back. The exception handler at the bottom converts to already_created.
  insert into public.setup_work_order_emissions (
    tenant_id, oli_id, work_order_id, outbox_event_id
  ) values (
    p_tenant_id, v_oli_id, v_work_order_id, p_event_id
  );

  -- ── 9. Domain event + audit row in same tx. Mirrors the legacy
  -- TicketService.createBookingOriginWorkOrder writes (addActivity +
  -- logDomainEvent + audit) so the activity feed and audit timeline see the
  -- same shape regardless of whether the WO was created via the legacy path
  -- or the RPC. Parity is validated by the §15.5 test suite.
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  ) values (
    p_tenant_id,
    'booking_origin_work_order_created',
    'work_order',
    v_work_order_id,
    jsonb_build_object(
      'work_order_id',              v_work_order_id,
      'booking_id',                 v_booking_id,
      'linked_order_line_item_id',  v_oli_id,
      'audit_metadata',             v_audit_metadata
    )
  );

  insert into public.audit_events (
    tenant_id, event_type, entity_type, entity_id, details
  ) values (
    p_tenant_id,
    'setup_work_order_created',
    'work_order',
    v_work_order_id,
    jsonb_build_object(
      'event_id',      p_event_id,
      'oli_id',        v_oli_id,
      'team_id',       nullif(p_wo_row_data->>'assigned_team_id', '')::uuid,
      'due_at',        nullif(p_wo_row_data->>'sla_resolution_due_at', '')::timestamptz,
      'sla_policy_id', nullif(p_wo_row_data->>'sla_id', '')::uuid,
      'metadata',      v_audit_metadata
    )
  );

  return jsonb_build_object(
    'kind',          'created',
    'work_order_id', v_work_order_id
  );

exception
  when unique_violation then
    -- A concurrent handler raced past the advisory lock (defensive — should
    -- not happen with a healthy hash). Re-read and return.
    select work_order_id into v_existing_wo_id
      from public.setup_work_order_emissions
     where tenant_id = p_tenant_id and oli_id = v_oli_id;
    if not found then
      -- The unique_violation was on something else (e.g. a work_orders
      -- constraint we don't expect). Re-raise so the worker retries.
      raise;
    end if;
    return jsonb_build_object(
      'kind',          case when v_existing_wo_id is null then 'already_handled_tombstone'
                            else 'already_created' end,
      'work_order_id', v_existing_wo_id
    );
end;
$$;

revoke execute on function public.create_setup_work_order_from_event(uuid, uuid, jsonb, text) from public;
grant  execute on function public.create_setup_work_order_from_event(uuid, uuid, jsonb, text) to service_role;

comment on function public.create_setup_work_order_from_event(uuid, uuid, jsonb, text) is
  'Atomic WO insert + dedup row insert + domain_events + audit_events row for setup_work_order.create_required outbox events. Single tx; identity (oli_id, booking_id) DERIVED from outbox.events.aggregate_id + chain join (NOT from p_wo_row_data — v8-C1). FK fields validated via validate_setup_wo_fks (00305). Idempotent on (tenant_id, oli_id) via setup_work_order_emissions; tombstone semantics via ON DELETE SET NULL (v8-I4). Folds v7-C3 + v8-C1 + v8.1-C1 of the outbox spec (§7.8.2).';

notify pgrst, 'reload schema';
