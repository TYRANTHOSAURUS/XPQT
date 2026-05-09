-- B.2.A foundation fix — add 'person' to validate_entity_in_tenant allowlist.
--
-- 00318 shipped without 'person' in the allowlist. Spec at
-- docs/follow-ups/b2-survey-and-design.md §3.0 / §3.5 / §3.8 / §3.10 /
-- §3.11 has the TS plan-builders calling
--   validate_entity_in_tenant(p_tenant_id, 'person', requester_person_id)
-- which would currently hit 'unknown_kind' instead of the semantic
-- 'person_not_in_tenant'. This migration extends the allowlist and adds
-- an else-raise in the CASE so a future allowlist/dispatch drift
-- surfaces loudly rather than silently no-op'ing.
--
-- Label asymmetry (intentional): the spec uses 'scope_override' as the
-- kind label even though the underlying table is
-- request_type_scope_overrides. Every other label is the table-name
-- singular; 'scope_override' is the spec contract per §3.8/§4 and we
-- preserve it to avoid breaking RPC call sites. Documented inline.
--
-- Idempotent: CREATE OR REPLACE FUNCTION rebuilds in place. Body kept
-- in lockstep with 00318 — same errcode='42501', same perform/found
-- pattern, same long-form message — so v1 vs v2 differs only on the
-- allowlist + the new branch + the else-raise.

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
  -- Allowlist — reject unknown kinds before touching any table. v2
  -- (00321) adds 'person' to support the requester_person_id checks
  -- in the §3.0/§3.5/§3.10/§3.11 combined RPCs.
  if p_kind not in (
    'case', 'work_order', 'asset', 'space',
    'request_type', 'scope_override',
    'workflow_definition', 'sla_policy',
    'person'
  ) then
    raise exception 'validate_entity_in_tenant.unknown_kind: %', p_kind
      using errcode = '42501';
  end if;

  -- 'scope_override' is the spec's label even though the table is
  -- request_type_scope_overrides. Keep the label per spec §3.8/§4 to
  -- avoid breaking RPC call sites. The asymmetry is intentional.
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

    when 'person' then
      perform 1 from public.persons
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.person_not_in_tenant: % does not reference a known person in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    else
      -- Defense-in-depth: if the allowlist gate above is bypassed
      -- (future typo, partial migration, etc.) fail loudly here too
      -- rather than silently returning success on an unknown kind.
      raise exception 'validate_entity_in_tenant.dispatch_missing: %', p_kind
        using errcode = '42501';
  end case;
end;
$$;

revoke execute on function public.validate_entity_in_tenant(uuid, text, uuid) from public;
grant  execute on function public.validate_entity_in_tenant(uuid, text, uuid) to service_role;

comment on function public.validate_entity_in_tenant(uuid, text, uuid) is
  'Validates a tenant-owned entity referenced by a B.2 combined RPC. Allowlisted kinds: case, work_order, asset, space, request_type, scope_override, workflow_definition, sla_policy, person. Unknown kind raises 42501 ''validate_entity_in_tenant.unknown_kind''. Missing row raises 42501 ''validate_entity_in_tenant.<kind>_not_in_tenant''. case → public.tickets; work_order → public.work_orders (post step1c polymorphic split, migrations 00213-00233); person → public.persons; other kinds hit their named tables. SECURITY DEFINER, search_path locked. Spec: docs/follow-ups/b2-survey-and-design.md §3.8. v2 (00321) adds person + else-raise defense.';
