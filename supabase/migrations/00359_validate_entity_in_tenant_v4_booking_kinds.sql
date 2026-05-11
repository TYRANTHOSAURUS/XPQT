-- B.4.A.2 — validate_entity_in_tenant v4 adds 'booking_rule' + 'cost_center'.
--
-- Spec:        docs/follow-ups/b4-booking-edit-pipeline.md
--                §0.1 (sticky FKs incl. cost_center_id),
--                §1   (mutable field table — applied_rule_ids + cost_center_id),
--                §3.3 (TS plan-build → FKs the RPC will see),
--                §3.4 step 4 ("Tenant-validate every FK in p_plan via
--                             validate_entity_in_tenant").
-- Replaces:    00340 (v3 added 'routing_rule'; 00321 v2 added 'person';
--              00318 v1 was the initial allowlist).
-- Companion:   the upcoming edit_booking RPC (B.4.A.3) will be the first
--              caller of the new branches; v4 lands first so the helper
--              is in place before the RPC ships.
--
-- ── Why this revision ───────────────────────────────────────────────────
--
-- Spec §3.4 step 6.2 has the edit_booking RPC writing two FK families
-- that no current §3.0/§3.1/§3.2/§3.3/§3.4 RPC writes, and that the v3
-- allowlist therefore can't cover:
--
--   1) `bookings.applied_rule_ids uuid[]` (00277:64, originally 00122:35).
--      Each element references `public.room_booking_rules.id` —
--      `RuleResolverService.matchedRules.map(r => r.id)` is the
--      production source (apps/api/src/modules/reservations/
--      booking-flow.service.ts:275, :902, :1404). PG enforces NO per-
--      element FK on uuid[] columns, and `room_booking_rules.id` is the
--      primary key on a tenant-scoped row (00121:5-7: `tenant_id uuid
--      not null references public.tenants(id)`). Same defense-in-depth
--      shape as v3's `routing_rule` branch: the underlying row is
--      tenant-scoped, but the column-level FK can't enforce that, so the
--      tenant check has to live in the RPC's preflight.
--
--      Spec label is `booking_rule` (B.4 §0.1 narrative + §1 mutable-field
--      table). Underlying table is `public.room_booking_rules`. Same
--      label-vs-table asymmetry as v2's `scope_override` →
--      `request_type_scope_overrides`; preserved here for spec parity.
--
--   2) `bookings.cost_center_id` (00277:61 → fk on `public.cost_centers`
--      at 00140:74-76, FK declared 00140:99-100). B.4 §3.4 step 6.2
--      ("cost_center_id if host's default differs by building"): the edit
--      may rewrite this FK when the host changes. The FK itself is a
--      plain single-column reference to a tenant-scoped row, so a
--      malicious / forged payload could otherwise commit `bookings.cost_center_id`
--      pointing at another tenant's cost center. Same defense-in-depth
--      class as the rest of the allowlist.
--
-- Both additions follow the v3 'routing_rule' pattern exactly — the
-- allowlist gate gains the new labels and two new CASE branches are
-- appended before the else-raise; error codes mirror the existing
-- `<kind>_not_in_tenant` shape with errcode '42501' so
-- mapRpcErrorToAppError routes them to 404 (see map-rpc-error.ts
-- STATUS_BY_CODE addition in this PR).
--
-- Idempotent: CREATE OR REPLACE FUNCTION rebuilds in place. Body mirrors
-- 00340 verbatim — only the allowlist gate gains 'booking_rule' +
-- 'cost_center' and two new CASE branches are appended before the
-- else-raise. The destructive-default invariant for booking subsystem
-- migrations doesn't apply here (helper function, no booking-table
-- schema mutation).

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
  -- Allowlist — v4 (00359) adds 'booking_rule' + 'cost_center' for the
  -- B.4 edit_booking RPC. Per B.4 §3.4 step 6.2 the RPC writes
  -- `bookings.applied_rule_ids[]` (each element → public.room_booking_rules)
  -- and may rewrite `bookings.cost_center_id` (→ public.cost_centers).
  -- Neither column carries per-element / multi-tenant FK enforcement,
  -- so the tenant check has to live here.
  if p_kind not in (
    'case', 'work_order', 'asset', 'space',
    'request_type', 'scope_override',
    'workflow_definition', 'sla_policy',
    'person',
    'routing_rule',
    'booking_rule',
    'cost_center'
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

    -- v4 (00359) — booking_rule branch. Label is the spec narrative
    -- name (B.4 §0.1 / §1); the underlying table is
    -- public.room_booking_rules (00121:5-7). Same label-vs-table
    -- asymmetry as 'scope_override' → request_type_scope_overrides.
    -- `bookings.applied_rule_ids[]` carries each element here; PG
    -- enforces no per-element FK on uuid[] so tenant ownership is
    -- defense-in-depth at this helper.
    when 'booking_rule' then
      perform 1 from public.room_booking_rules
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.booking_rule_not_in_tenant: % does not reference a known booking_rule in tenant %', p_id, p_tenant_id
          using errcode = '42501';
      end if;

    -- v4 (00359) — cost_center branch. `public.cost_centers` is
    -- tenant-scoped (00140:74-76); `bookings.cost_center_id` (00277:61)
    -- is a plain single-column FK to its primary key. B.4 §3.4 step
    -- 6.2 has the edit_booking RPC rewriting this FK when the host's
    -- default differs by building, so the new value must be
    -- tenant-validated before the UPDATE commits.
    when 'cost_center' then
      perform 1 from public.cost_centers
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.cost_center_not_in_tenant: % does not reference a known cost_center in tenant %', p_id, p_tenant_id
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
  'v4 (00359) — Validates a tenant-owned entity referenced by a B.2 / B.4 combined RPC. Allowlisted kinds: case, work_order, asset, space, request_type, scope_override, workflow_definition, sla_policy, person, routing_rule, booking_rule, cost_center. Unknown kind raises 42501 ''validate_entity_in_tenant.unknown_kind''. Missing row raises 42501 ''validate_entity_in_tenant.<kind>_not_in_tenant''. case → public.tickets; work_order → public.work_orders (post step1c polymorphic split, migrations 00213-00233); person → public.persons; routing_rule → public.routing_rules (00018; routing_decisions.rule_id FK is GLOBAL per 00027:67); booking_rule → public.room_booking_rules (00121:5-7; bookings.applied_rule_ids[] has no per-element FK enforcement); cost_center → public.cost_centers (00140:74-76; bookings.cost_center_id is a single-col FK with no tenant join). SECURITY DEFINER, search_path locked. Spec: docs/follow-ups/b2-survey-and-design.md §3.8 + docs/follow-ups/b4-booking-edit-pipeline.md §3.4. v4 (00359) adds booking_rule + cost_center for the §3.4 edit_booking RPC.';

notify pgrst, 'reload schema';
