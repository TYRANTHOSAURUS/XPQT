-- B.0.A.2 — validate_attach_plan_tenant_fks helper.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §8.1
-- (Exhaustive tenant FK validation matrix).
--
-- Validates every tenant-owned UUID in (BookingInput, AttachPlan) against
-- p_tenant_id BEFORE any insert in the combined RPC. Closes the
-- CLAUDE.md #0 "tenant_id is the ultimate rule" gap that PostgreSQL's
-- own REFERENCES clause cannot — REFERENCES checks existence, not tenant.
--
-- Failures raise 42501 'attach_plan.fk_invalid: <field> [<id>]' so the
-- combined RPC's pg_advisory_xact_lock holder can roll the marker insert
-- back along with the rest of the work.
--
-- SECURITY INVOKER — runs in the caller's tx (the combined RPC's tx).
-- The combined RPC itself runs as service_role; this helper trusts that.
--
-- Why batched IN/EXCEPT instead of per-row PERFORM? On large plans
-- (multi-room booking + many lines + many attendees) the per-row form
-- explodes into 50+ round-trips inside a single PL/pgSQL function.
-- Batched form: one CTE per FK category, missing-row scan, single
-- exception with the failing id in the message.

create or replace function public.validate_attach_plan_tenant_fks(
  p_tenant_id     uuid,
  p_booking_input jsonb,
  p_attach_plan   jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_missing uuid;
begin
  -- ── BookingInput fields ────────────────────────────────────────────────

  -- requester_person_id (required) → persons
  perform 1 from public.persons
   where id = (p_booking_input->>'requester_person_id')::uuid
     and tenant_id = p_tenant_id;
  if not found then
    raise exception 'attach_plan.fk_invalid: requester_person_id'
      using errcode = '42501';
  end if;

  -- host_person_id (optional) → persons
  if p_booking_input->>'host_person_id' is not null
     and length(p_booking_input->>'host_person_id') > 0 then
    perform 1 from public.persons
     where id = (p_booking_input->>'host_person_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: host_person_id'
        using errcode = '42501';
    end if;
  end if;

  -- booked_by_user_id (optional) → users
  if p_booking_input->>'booked_by_user_id' is not null
     and length(p_booking_input->>'booked_by_user_id') > 0 then
    perform 1 from public.users
     where id = (p_booking_input->>'booked_by_user_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: booked_by_user_id'
        using errcode = '42501';
    end if;
  end if;

  -- location_id (required) → spaces (bookings.location_id REFERENCES spaces(id) at 00277:41)
  perform 1 from public.spaces
   where id = (p_booking_input->>'location_id')::uuid
     and tenant_id = p_tenant_id;
  if not found then
    raise exception 'attach_plan.fk_invalid: location_id'
      using errcode = '42501';
  end if;

  -- cost_center_id (optional) → cost_centers
  if p_booking_input->>'cost_center_id' is not null
     and length(p_booking_input->>'cost_center_id') > 0 then
    perform 1 from public.cost_centers
     where id = (p_booking_input->>'cost_center_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: cost_center_id'
        using errcode = '42501';
    end if;
  end if;

  -- template_id (optional) → bundle_templates (per spec §8.1; bookings.template_id FK at 00277)
  if p_booking_input->>'template_id' is not null
     and length(p_booking_input->>'template_id') > 0 then
    perform 1 from public.bundle_templates
     where id = (p_booking_input->>'template_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: template_id'
        using errcode = '42501';
    end if;
  end if;

  -- recurrence_series_id (optional) → recurrence_series
  if p_booking_input->>'recurrence_series_id' is not null
     and length(p_booking_input->>'recurrence_series_id') > 0 then
    perform 1 from public.recurrence_series
     where id = (p_booking_input->>'recurrence_series_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: recurrence_series_id'
        using errcode = '42501';
    end if;
  end if;

  -- Slots: space_id (required per slot) → spaces (batched)
  with plan_ids as (
    select distinct (s->>'space_id')::uuid as id
      from jsonb_array_elements(coalesce(p_booking_input->'slots', '[]'::jsonb)) s
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.spaces sp
        where sp.id = pi.id and sp.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: slots[].space_id %', v_missing
      using errcode = '42501';
  end if;

  -- Slots: attendee_person_ids[] (optional, array per slot) → persons (batched)
  with plan_ids as (
    select distinct attendee::uuid as id
      from jsonb_array_elements(coalesce(p_booking_input->'slots', '[]'::jsonb)) s,
           jsonb_array_elements_text(coalesce(s->'attendee_person_ids', '[]'::jsonb)) attendee
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p
        where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: slots[].attendee_person_ids %', v_missing
      using errcode = '42501';
  end if;

  -- ── AttachPlan fields ──────────────────────────────────────────────────

  -- orders[].requester_person_id → persons
  with plan_ids as (
    select distinct (o->>'requester_person_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'orders', '[]'::jsonb)) o
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: orders[].requester_person_id %', v_missing
      using errcode = '42501';
  end if;

  -- orders[].delivery_location_id (optional) → spaces
  with plan_ids as (
    select distinct (o->>'delivery_location_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'orders', '[]'::jsonb)) o
     where o->>'delivery_location_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.spaces sp where sp.id = pi.id and sp.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: orders[].delivery_location_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].catalog_item_id (required) → catalog_items
  with plan_ids as (
    select distinct (li->>'catalog_item_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.catalog_items ci where ci.id = pi.id and ci.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].catalog_item_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].fulfillment_team_id (optional) → teams
  with plan_ids as (
    select distinct (li->>'fulfillment_team_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
     where li->>'fulfillment_team_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.teams t where t.id = pi.id and t.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].fulfillment_team_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].vendor_id (optional) → vendors
  with plan_ids as (
    select distinct (li->>'vendor_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
     where li->>'vendor_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.vendors v where v.id = pi.id and v.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].vendor_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].menu_item_id (optional) → menu_items
  with plan_ids as (
    select distinct (li->>'menu_item_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
     where li->>'menu_item_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.menu_items mi where mi.id = pi.id and mi.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].menu_item_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].linked_asset_id (optional) → assets
  with plan_ids as (
    select distinct (li->>'linked_asset_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'order_line_items', '[]'::jsonb)) li
     where li->>'linked_asset_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.assets a where a.id = pi.id and a.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].linked_asset_id %', v_missing
      using errcode = '42501';
  end if;

  -- asset_reservations[].asset_id (required) → assets
  with plan_ids as (
    select distinct (a->>'asset_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'asset_reservations', '[]'::jsonb)) a
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.assets ast where ast.id = pi.id and ast.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: asset_reservations[].asset_id %', v_missing
      using errcode = '42501';
  end if;

  -- asset_reservations[].requester_person_id (required) → persons
  with plan_ids as (
    select distinct (a->>'requester_person_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'asset_reservations', '[]'::jsonb)) a
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: asset_reservations[].requester_person_id %', v_missing
      using errcode = '42501';
  end if;

  -- approvals[].approver_person_id → persons
  -- (one row per approver_person_id after ApprovalRoutingService.assemblePlan dedup; spec §7.4)
  with plan_ids as (
    select distinct (ap->>'approver_person_id')::uuid as id
      from jsonb_array_elements(coalesce(p_attach_plan->'approvals', '[]'::jsonb)) ap
     where ap->>'approver_person_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: approvals[].approver_person_id %', v_missing
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.validate_attach_plan_tenant_fks(uuid, jsonb, jsonb) from public;
grant  execute on function public.validate_attach_plan_tenant_fks(uuid, jsonb, jsonb) to service_role;

comment on function public.validate_attach_plan_tenant_fks(uuid, jsonb, jsonb) is
  'Validates every tenant-owned UUID in (BookingInput, AttachPlan) against p_tenant_id before any insert in create_booking_with_attach_plan. Outbox spec §8.1. Defense-in-depth against a buggy or compromised TS preflight passing foreign-tenant ids past the supabase-js .eq(tenant_id) filters. SECURITY INVOKER; raises 42501 attach_plan.fk_invalid: <field> [<id>] on first miss.';
