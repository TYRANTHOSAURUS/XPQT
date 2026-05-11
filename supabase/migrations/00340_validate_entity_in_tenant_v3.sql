-- B.2.A.Step8 codex remediation — validate_entity_in_tenant v3 adds 'routing_rule'.
--
-- Spec:        docs/follow-ups/b2-survey-and-design.md §3.8 (helper contract).
-- Replaces:    00321 (v2 added 'person'; 00318 v1 was the initial allowlist).
-- Companion:   00341 / 00342 (dispatch RPCs that consume the new branch).
--
-- ── Why this revision ───────────────────────────────────────────────────
--
-- Codex finding F-IMP-1 (codex-S8-I1) flagged that
-- 00338:163 / 00339:217 parsed `routing_rule_id` from the dispatch payload
-- and INSERTed it into `routing_decisions.rule_id` WITHOUT validating
-- that the rule belongs to the calling tenant. `routing_decisions.rule_id`'s
-- FK on `public.routing_rules(id)` is GLOBAL (00027:67) — no tenant_id
-- composite — so a forged or internal-bug payload could write tenant A's
-- routing audit row pointing at tenant B's rule. Cross-tenant leak in
-- audit data.
--
-- Fix: extend `validate_entity_in_tenant`'s allowlist + dispatch with a
-- 'routing_rule' branch so the dispatch RPCs can defense-in-depth before
-- inserting into `routing_decisions`. `public.routing_rules` is tenant-
-- scoped at the row level (00018:5 `tenant_id uuid not null references
-- public.tenants(id)`).
--
-- Idempotent: CREATE OR REPLACE FUNCTION rebuilds in place. Body mirrors
-- 00321 exactly — only the allowlist gate gains 'routing_rule' and a new
-- CASE branch is appended before the else-raise.

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
  -- Allowlist — v3 (00340) adds 'routing_rule' for the §3.4 dispatch
  -- RPCs (00341 / 00342) which write `routing_decisions.rule_id`. The
  -- underlying FK is GLOBAL (00027:67) so the tenant check has to live
  -- here.
  if p_kind not in (
    'case', 'work_order', 'asset', 'space',
    'request_type', 'scope_override',
    'workflow_definition', 'sla_policy',
    'person',
    'routing_rule'
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

    when 'person' then
      perform 1 from public.persons
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.person_not_in_tenant: % does not reference a known person in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    when 'routing_rule' then
      perform 1 from public.routing_rules
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.routing_rule_not_in_tenant: % does not reference a known routing_rule in tenant %', p_id, p_tenant_id
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
  'v3 (00340) — Validates a tenant-owned entity referenced by a B.2 combined RPC. Allowlisted kinds: case, work_order, asset, space, request_type, scope_override, workflow_definition, sla_policy, person, routing_rule. Unknown kind raises 42501 ''validate_entity_in_tenant.unknown_kind''. Missing row raises 42501 ''validate_entity_in_tenant.<kind>_not_in_tenant''. case → public.tickets; work_order → public.work_orders (post step1c polymorphic split, migrations 00213-00233); person → public.persons; routing_rule → public.routing_rules (00018, tenant-scoped row; routing_decisions.rule_id FK is GLOBAL per 00027:67 so this is the only tenant gate); other kinds hit their named tables. SECURITY DEFINER, search_path locked. Spec: docs/follow-ups/b2-survey-and-design.md §3.8. v3 (00340) adds routing_rule for the §3.4 dispatch RPCs.';

notify pgrst, 'reload schema';
