-- B.0.A.3 — validate_attach_plan_internal_refs helper.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §8.2
-- (v6-I2 / v7-I4 / v8-I3).
--
-- Sibling to validate_attach_plan_tenant_fks (00303). Where §8.1 catches a
-- *cross-tenant* leak (a UUID that exists but in the wrong tenant), §8.2
-- catches an *internally-inconsistent plan*: UUIDs that all exist in the
-- right tenant but reference each other wrong (a buggy plan-builder, an
-- attacker mutating the plan in transit between TS and the RPC, a future
-- contributor who misunderstands the plan shape).
--
-- v8-I3 contract: signature is (p_tenant_id, p_booking_input, p_attach_plan).
-- v7 added p_tenant_id implicitly inside the snapshot-validation block but
-- did not update the function definition or the §7.6 call site. v8 fixes
-- the drift.
--
-- v7-I4 fold: snapshot UUIDs (applied_rule_ids[], setup_emit.rule_ids[],
-- approvals[].reasons[].rule_id) are batch-validated against tenant-scoped
-- service_rules. config_release_id check is OMITTED here — the
-- service_config_releases table does not exist in remote yet (no migration
-- has shipped it). When that table lands, append the 7b check from spec
-- §8.2.
--
-- Failures raise 22023 (internal_refs) or 42501 (snapshot UUIDs in wrong
-- tenant) per spec.

create or replace function public.validate_attach_plan_internal_refs(
  p_tenant_id     uuid,
  p_booking_input jsonb,
  p_attach_plan   jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_order_ids  uuid[];
  v_oli_ids    uuid[];
  v_ar_ids     uuid[];
  v_slot_ids   uuid[];
  v_bad        uuid;
  v_bad_text   text;
begin
  v_booking_id := nullif(p_booking_input->>'booking_id', '')::uuid;
  if v_booking_id is null then
    raise exception 'attach_plan.internal_refs: booking_id missing'
      using errcode = '22023';
  end if;

  -- Collect plan-row id sets once for cheap membership checks.
  v_slot_ids := coalesce(
    (select array_agg((s->>'id')::uuid)
       from jsonb_array_elements(coalesce(p_booking_input->'slots', '[]'::jsonb)) s),
    '{}'::uuid[]);
  v_order_ids := coalesce(
    (select array_agg((o->>'id')::uuid)
       from jsonb_array_elements(coalesce(p_attach_plan->'orders', '[]'::jsonb)) o),
    '{}'::uuid[]);
  v_oli_ids := coalesce(
    (select array_agg((li->>'id')::uuid)
       from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li),
    '{}'::uuid[]);
  v_ar_ids := coalesce(
    (select array_agg((ar->>'id')::uuid)
       from jsonb_array_elements(coalesce(p_attach_plan->'asset_reservations', '[]'::jsonb)) ar),
    '{}'::uuid[]);

  -- 1. order_line_items[].order_id must reference plan.orders[].id
  select (li->>'order_id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
   where (li->>'order_id')::uuid <> all(v_order_ids)
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: order_line_items[].order_id % not in plan.orders[]', v_bad
      using errcode = '22023';
  end if;

  -- 2. order_line_items[].linked_asset_reservation_id (when set) must
  --    reference plan.asset_reservations[].id
  select (li->>'linked_asset_reservation_id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
   where li->>'linked_asset_reservation_id' is not null
     and (li->>'linked_asset_reservation_id')::uuid <> all(v_ar_ids)
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: order_line_items[].linked_asset_reservation_id % not in plan.asset_reservations[]', v_bad
      using errcode = '22023';
  end if;

  -- 3. asset_reservations[].booking_id must equal booking_input.booking_id
  select (ar->>'booking_id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_attach_plan->'asset_reservations', '[]'::jsonb)) ar
   where (ar->>'booking_id')::uuid <> v_booking_id
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: asset_reservations[].booking_id % does not match booking_input.booking_id', v_bad
      using errcode = '22023';
  end if;

  -- 4. approvals[].target_entity_id must equal booking_input.booking_id
  --    (approvals target the booking; spec §7.4 has target_entity_type='booking')
  select (ap->>'target_entity_id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_attach_plan->'approvals', '[]'::jsonb)) ap
   where (ap->>'target_entity_id')::uuid <> v_booking_id
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: approvals[].target_entity_id % does not match booking_input.booking_id', v_bad
      using errcode = '22023';
  end if;

  -- 5. bundle_audit_payload internal references (defense-in-depth — the
  --    audit row is part of the plan and downstream readers depend on it)
  select id_text into v_bad_text
    from jsonb_array_elements_text(coalesce(p_attach_plan->'bundle_audit_payload'->'order_ids', '[]'::jsonb)) id_text
   where id_text::uuid <> all(v_order_ids)
   limit 1;
  if v_bad_text is not null then
    raise exception 'attach_plan.internal_refs: bundle_audit_payload.order_ids % not in plan.orders[]', v_bad_text
      using errcode = '22023';
  end if;
  select id_text into v_bad_text
    from jsonb_array_elements_text(coalesce(p_attach_plan->'bundle_audit_payload'->'order_line_item_ids', '[]'::jsonb)) id_text
   where id_text::uuid <> all(v_oli_ids)
   limit 1;
  if v_bad_text is not null then
    raise exception 'attach_plan.internal_refs: bundle_audit_payload.order_line_item_ids % not in plan.order_line_items[]', v_bad_text
      using errcode = '22023';
  end if;

  -- 6. order_line_items[].pending_setup_trigger_args, when present, must
  --    reference the same OLI (no cross-contamination of args between lines).
  select (li->>'id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
   where li->'pending_setup_trigger_args' is not null
     and (li->'pending_setup_trigger_args'->>'oliId')::uuid is distinct from (li->>'id')::uuid
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: order_line_items[].pending_setup_trigger_args.oliId mismatch on %', v_bad
      using errcode = '22023';
  end if;

  -- ── 7. Snapshot UUIDs (v7-I4 / v8-I3) ────────────────────────────────
  --
  -- applied_rule_ids[], setup_emit.rule_ids[], approvals[].reasons[].rule_id
  -- are write-once snapshots that bake into the audit trail forever; a
  -- cross-tenant id smuggled here is permanent corruption. Cheap to
  -- validate at plan time; impossible to backfill once persisted.
  --
  -- config_release_id check (spec §8.2 step 7b) is OMITTED here because
  -- public.service_config_releases does not exist in remote yet. Append
  -- the 7b block when that table ships in a follow-up migration.

  -- 7a. booking_input.applied_rule_ids[]
  with snap as (
    select distinct value::uuid as id
      from jsonb_array_elements_text(coalesce(p_booking_input->'applied_rule_ids', '[]'::jsonb))
  ), missing as (
    select s.id from snap s
     where not exists (
       select 1 from public.service_rules sr
        where sr.id = s.id and sr.tenant_id = p_tenant_id
     )
  )
  select id into v_bad from missing limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: applied_rule_ids[] % not in tenant service_rules', v_bad
      using errcode = '42501';
  end if;

  -- 7c. setup_emit.rule_ids[] across all OLIs
  with snap as (
    select distinct rule_id::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li,
           jsonb_array_elements_text(coalesce(li->'setup_emit'->'rule_ids', '[]'::jsonb)) rule_id
     where li->'setup_emit' is not null
  ), missing as (
    select s.id from snap s
     where not exists (
       select 1 from public.service_rules sr
        where sr.id = s.id and sr.tenant_id = p_tenant_id
     )
  )
  select id into v_bad from missing limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: setup_emit.rule_ids[] % not in tenant service_rules', v_bad
      using errcode = '42501';
  end if;

  -- 7d. approvals[].scope_breakdown.reasons[].rule_id across all approvals
  with snap as (
    select distinct (reason->>'rule_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'approvals', '[]'::jsonb)) ap,
           jsonb_array_elements(coalesce(ap->'scope_breakdown'->'reasons', '[]'::jsonb)) reason
     where reason->>'rule_id' is not null
  ), missing as (
    select s.id from snap s
     where not exists (
       select 1 from public.service_rules sr
        where sr.id = s.id and sr.tenant_id = p_tenant_id
     )
  )
  select id into v_bad from missing limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: approvals[].reasons[].rule_id % not in tenant service_rules', v_bad
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.validate_attach_plan_internal_refs(uuid, jsonb, jsonb) from public;
grant  execute on function public.validate_attach_plan_internal_refs(uuid, jsonb, jsonb) to service_role;

comment on function public.validate_attach_plan_internal_refs(uuid, jsonb, jsonb) is
  'Validates internal cross-references in the AttachPlan + BookingInput payloads. Runs alongside validate_attach_plan_tenant_fks before any insert in create_booking_with_attach_plan. v6-I2 (codex review of v5); v7-I4 added snapshot UUID validation; v8-I3 canonicalised the three-arg signature. Catches internally-inconsistent plans whose UUIDs all exist in the right tenant but reference each other wrong, plus cross-tenant snapshot UUIDs (rule_ids) that would otherwise bake into immutable audit rows. config_release_id check (spec §8.2 step 7b) is deferred until service_config_releases ships.';
