-- B.0.A.4 — validate_setup_wo_fks helper.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.8.2
-- (v8-C1 / v8.1-C1).
--
-- Validates every tenant-owned FK in a setup-WO row payload before INSERT.
-- Folds two codex findings on top of v7's create_setup_work_order_from_event:
--
--   v8-C1: the v7 RPC trusted p_wo_row_data for identity. v8 derives the
--   identity (oli_id, booking_id) from the outbox.events chain instead and
--   validates every tenant-owned FK in the row JSON via this helper.
--
--   v8.1-C1: requester_person_id MUST be NULL for setup WOs. Legacy contract
--   at apps/api/src/modules/ticket/ticket.service.ts:1889 sets this NULL
--   explicitly to keep internal facilities tasks out of the requester portal.
--   persons.id is tenant-owned (00003_people_users_roles.sql:4), so a forged
--   value can also be cross-tenant. Reject early.
--
-- SECURITY INVOKER — runs in the caller's tx (the create_setup_work_order_from_event
-- RPC's tx). Failures roll back the WO insert + dedup row insert with the
-- rest of the work.
--
-- p_booking_id is the chain-derived value (caller obtained it via
-- order_line_items.order_id → orders.booking_id). It's accepted here for
-- future identity cross-checks; the v8.1 body uses tenant_id only on
-- per-FK checks since each FK validates against its own tenant-scoped
-- table directly.

create or replace function public.validate_setup_wo_fks(
  p_tenant_id   uuid,
  p_booking_id  uuid,
  p_wo_row_data jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- v8.1-C1: requester_person_id MUST be NULL for setup WOs.
  -- Setup WOs are internal facilities tasks; surfacing them via the requester
  -- portal (which keys on requester_person_id) would change visibility semantics.
  -- Legacy contract is set explicitly at ticket.service.ts:1889
  -- ("Intentionally NOT set: ... would leak this internal operational task into
  -- the requester's portal 'My Requests' view."). persons.id is tenant-owned
  -- (00003_people_users_roles.sql:4), so a forged value can also be cross-tenant.
  if (p_wo_row_data->>'requester_person_id') is not null then
    raise exception 'setup_wo.requester_person_id_not_allowed'
      using errcode = 'P0001',
            hint = 'Setup WOs must have requester_person_id NULL; visibility hygiene per legacy contract.';
  end if;

  -- location_id (optional) → spaces tenant
  v_id := nullif(p_wo_row_data->>'location_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.spaces where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: location_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- assigned_team_id (optional) → teams tenant
  v_id := nullif(p_wo_row_data->>'assigned_team_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.teams where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: assigned_team_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- assigned_user_id (optional) → users tenant
  v_id := nullif(p_wo_row_data->>'assigned_user_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.users where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: assigned_user_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- assigned_vendor_id (optional) → vendors tenant
  v_id := nullif(p_wo_row_data->>'assigned_vendor_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.vendors where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: assigned_vendor_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- sla_id (optional) → sla_policies tenant
  v_id := nullif(p_wo_row_data->>'sla_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.sla_policies where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: sla_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- request_type_id (optional) → request_types tenant
  if p_wo_row_data ? 'request_type_id' then
    v_id := nullif(p_wo_row_data->>'request_type_id', '')::uuid;
    if v_id is not null then
      perform 1 from public.request_types where id = v_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'setup_wo.fk_invalid: request_type_id %', v_id
          using errcode = '42501';
      end if;
    end if;
  end if;
end;
$$;

revoke execute on function public.validate_setup_wo_fks(uuid, uuid, jsonb) from public;
grant  execute on function public.validate_setup_wo_fks(uuid, uuid, jsonb) to service_role;

comment on function public.validate_setup_wo_fks(uuid, uuid, jsonb) is
  'Validates every tenant-owned FK in a setup WO row payload before INSERT. Folds v8-C1 of the outbox spec — closes the hole where create_setup_work_order_from_event trusted FK fields from p_wo_row_data without tenant validation. v8.1-C1: also rejects non-null requester_person_id to preserve the legacy visibility contract (setup WOs are internal-only; persons.id is tenant-owned, so a forged requester would either leak cross-tenant or surface the WO in the requester portal). SECURITY INVOKER; raises P0001 setup_wo.requester_person_id_not_allowed or 42501 setup_wo.fk_invalid: <field> [<id>].';
