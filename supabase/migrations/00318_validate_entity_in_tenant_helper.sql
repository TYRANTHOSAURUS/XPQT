-- B.2.A.3 — validate_entity_in_tenant helper.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.8 (line 2408) +
-- §4 (line 3102, v8 / I3 consolidation).
--
-- Single SECURITY DEFINER function that checks any entity referenced
-- by a B.2 combined RPC belongs to p_tenant_id. The kind allowlist
-- prevents SQL injection and unknown kinds raise immediately.
--
-- Why one function with CASE rather than per-kind functions: keeps the
-- B.2 combined-RPC call sites uniform — every RPC validates its
-- entities through a single helper signature regardless of kind.
-- Allowlist is enforced at function entry; CASE inside the body keeps
-- table names hard-coded (no dynamic SQL, no injection vector).
--
-- Schema reality (v8 / I3 deviation from earlier spec drafts): step1c
-- polymorphic-cutover (migrations 00213-00240, finalised in 00233)
-- split case-side and work-order-side rows into TWO physical tables —
-- public.tickets (case rows) and public.work_orders (work-order rows).
-- There is NO `tickets.ticket_kind` column on the live schema. Per
-- the spec's intent ("ensures (tickets|work_orders).id = p_entity_id
-- and tenant_id matches"), this helper dispatches:
--   'case'       → public.tickets       WHERE id = p_id AND tenant_id = p_tenant_id
--   'work_order' → public.work_orders   WHERE id = p_id AND tenant_id = p_tenant_id
-- The other kinds (asset, space, request_type, scope_override,
-- workflow_definition, sla_policy) hit their own tables exactly as
-- spec'd.
--
-- SECURITY DEFINER with search_path locked to (public, pg_catalog).
-- Failures raise 42501 with stable code-style messages:
--   'validate_entity_in_tenant.unknown_kind'
--   'validate_entity_in_tenant.<kind>_not_in_tenant'

create or replace function public.validate_entity_in_tenant(
  p_tenant_id uuid,
  p_kind      text,
  p_id        uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Allowlist — reject unknown kinds before touching any table.
  if p_kind not in (
    'case', 'work_order', 'asset', 'space',
    'request_type', 'scope_override',
    'workflow_definition', 'sla_policy'
  ) then
    raise exception 'validate_entity_in_tenant.unknown_kind: %', p_kind
      using errcode = '42501';
  end if;

  case p_kind
    when 'case' then
      perform 1 from public.tickets
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.case_not_in_tenant: % does not reference a known case in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'work_order' then
      perform 1 from public.work_orders
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.work_order_not_in_tenant: % does not reference a known work_order in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'asset' then
      perform 1 from public.assets
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.asset_not_in_tenant: % does not reference a known asset in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'space' then
      perform 1 from public.spaces
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.space_not_in_tenant: % does not reference a known space in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'request_type' then
      perform 1 from public.request_types
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.request_type_not_in_tenant: % does not reference a known request_type in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'scope_override' then
      perform 1 from public.request_type_scope_overrides
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.scope_override_not_in_tenant: % does not reference a known scope_override in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'workflow_definition' then
      perform 1 from public.workflow_definitions
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.workflow_definition_not_in_tenant: % does not reference a known workflow_definition in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'sla_policy' then
      perform 1 from public.sla_policies
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.sla_policy_not_in_tenant: % does not reference a known sla_policy in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;
  end case;
end;
$$;

revoke execute on function public.validate_entity_in_tenant(uuid, text, uuid) from public;
grant  execute on function public.validate_entity_in_tenant(uuid, text, uuid) to service_role;

comment on function public.validate_entity_in_tenant(uuid, text, uuid) is
  'Validates a tenant-owned entity referenced by a B.2 combined RPC. Allowlisted kinds: case, work_order, asset, space, request_type, scope_override, workflow_definition, sla_policy. Unknown kind raises 42501 ''validate_entity_in_tenant.unknown_kind''. Missing row raises 42501 ''validate_entity_in_tenant.<kind>_not_in_tenant''. case → public.tickets; work_order → public.work_orders (post step1c polymorphic split, migrations 00213-00233); other kinds hit their named tables. SECURITY DEFINER, search_path locked. Spec: docs/follow-ups/b2-survey-and-design.md §3.8.';
