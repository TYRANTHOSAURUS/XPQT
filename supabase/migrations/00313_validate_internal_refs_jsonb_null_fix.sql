-- B.0.F follow-up — fix validate_attach_plan_internal_refs JSON-null check.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §8.2 step 6.
--
-- Surfaced by the round-trip smoke probe (B.0.F.1, smoke-outbox-roundtrip.mjs)
-- on first live run against the remote DB:
--
--   POST /reservations with a service line whose rule sets
--   requires_internal_setup=true and effect='allow' (i.e.
--   any_pending_approval=false; setup_emit branch, NOT
--   pending_setup_trigger_args branch) failed at the combined RPC's
--   internal-refs validation with:
--     attach_plan.internal_refs: order_line_items[].pending_setup_trigger_args.oliId mismatch on <uuid>
--
-- Root cause: the TS plan-builder serialises every OLI with
--   `pending_setup_trigger_args: null` (the default field shape, set in
-- bundle.service.ts:797 then optionally overwritten in §9 only when
-- any_pending_approval=true). The JSON wire shape has
--   "pending_setup_trigger_args": null
-- not the field omitted. The 00304 check at step 6:
--
--   where li->'pending_setup_trigger_args' is not null
--
-- distinguishes "missing key" from "key present with JSON null", because
-- `(jsonb '{"a": null}')->'a'` is `jsonb 'null'` which is `IS NOT NULL`
-- in SQL terms (the SQL NULL test only catches missing keys). Then
-- `jsonb null ->> 'oliId'` is SQL NULL, and `NULL::uuid is distinct from <id>`
-- evaluates TRUE. Validation trips on every services-present booking that
-- doesn't go through the deferred-approval branch.
--
-- Fix: replace the `is not null` predicate with
-- `jsonb_typeof(...) = 'object'`. Only check the cross-reference when the
-- value is actually an object (the only legitimate non-null shape per the
-- spec). JSON null and JSON missing key both fall to the no-op branch.
-- Snapshot logic (steps 7a / 7c / 7d) already coalesces internally so it
-- doesn't have the same surface; left untouched.
--
-- This is the contract bug that B.0.F.1 (smoke gate) was designed to catch.
-- Mocked-jest specs in B.0.A–E asserted the helper returned void on a
-- well-formed plan, but the mocks fed jsonb objects, not the wire-shape
-- jsonb that supabase-js produces. Real-DB round-trip is the only place
-- this surfaces.

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

  -- 6. order_line_items[].pending_setup_trigger_args, when present as a
  --    jsonb OBJECT, must reference the same OLI (no cross-contamination
  --    of args between lines). FIX (00313): use jsonb_typeof = 'object'
  --    instead of `is not null`. The TS plan-builder serialises the
  --    field as `null` for OLIs in the setup_emit branch (any_pending
  --    _approval=false), and SQL `is not null` does NOT distinguish
  --    "missing key" from "key present with JSON null" — both pass `is
  --    not null` because supabase-js produces the wire shape with the
  --    field present.
  select (li->>'id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
   where jsonb_typeof(li->'pending_setup_trigger_args') = 'object'
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

  -- 7c. setup_emit.rule_ids[] across all OLIs. Use jsonb_typeof = 'object'
  --     to mirror the §6 fix — TS plan-builder also serialises
  --     `setup_emit: null` on OLIs that don't need a setup emit.
  with snap as (
    select distinct rule_id::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li,
           jsonb_array_elements_text(coalesce(li->'setup_emit'->'rule_ids', '[]'::jsonb)) rule_id
     where jsonb_typeof(li->'setup_emit') = 'object'
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
  'Validates internal cross-references in the AttachPlan + BookingInput payloads. Runs alongside validate_attach_plan_tenant_fks before any insert in create_booking_with_attach_plan. v6-I2 (codex review of v5); v7-I4 added snapshot UUID validation; v8-I3 canonicalised the three-arg signature; 00313 (B.0.F.1 smoke gate) replaced jsonb is-not-null with jsonb_typeof=object so wire-shape JSON nulls do not trip the check. Catches internally-inconsistent plans whose UUIDs all exist in the right tenant but reference each other wrong, plus cross-tenant snapshot UUIDs (rule_ids) that would otherwise bake into immutable audit rows. config_release_id check (spec §8.2 step 7b) is deferred until service_config_releases ships.';
