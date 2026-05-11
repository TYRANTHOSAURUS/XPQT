-- B.4.A.2 (codex remediation) — validate_entity_in_tenant v5 adds 'team'.
--
-- Spec:        docs/follow-ups/b4-booking-edit-pipeline.md
--                §3.4 step 4 ("Tenant-validate every FK in p_plan via
--                              validate_entity_in_tenant"),
--                §3.6.5 (Approval reconciliation decision table — INSERT
--                        new approvals chain on transitions into
--                        require_approval and on different-config
--                        terminal-approved supersession).
-- Replaces:    00359 (v4 added 'booking_rule' + 'cost_center';
--              00340 v3 added 'routing_rule';
--              00321 v2 added 'person';
--              00318 v1 was the initial allowlist).
-- Companion:   the upcoming edit_booking RPC (B.4.A.3) will be the first
--              caller of the new branch; v5 lands first so the helper
--              is in place before the RPC ships.
--
-- ── Why this revision (codex finding) ───────────────────────────────────
--
-- Codex caught a class of leak shaped exactly like the v3 routing_rule
-- gap (Codex-S8-I1) and identical to the booking_rule pattern v4 just
-- closed: a cross-table FK to a tenant-scoped row whose column-level FK
-- DOES NOT join through tenant_id.
--
-- `public.approvals.approver_team_id` is declared at 00012:12 as:
--
--   approver_team_id uuid references public.teams(id),
--
-- That FK is GLOBAL — it constrains approver_team_id to an existing
-- `teams.id` but says nothing about `teams.tenant_id`. The `teams`
-- table itself is tenant-scoped (00003:100, `tenant_id uuid not null
-- references public.tenants(id)`), but the cross-table FK from
-- approvals can't enforce that join.
--
-- The B.4 edit_booking RPC §3.6.5 has multiple INSERT-new-approvals-chain
-- transitions (allow→require_approval; require_approval→require_approval
-- with different chain config; terminal_approved→require_approval with
-- different chain config). The TS plan-build mirrors today's
-- `BookingFlowService.createApprovalRows` at
-- apps/api/src/modules/reservations/booking-flow.service.ts:1266-1287,
-- which writes:
--
--   approver_team_id: a.type === 'team' ? a.id : null
--
-- from `ApprovalConfig.required_approvers: Array<{ type: 'team' |
-- 'person'; id: string }>` (apps/api/src/modules/room-booking-rules/
-- dto/index.ts:24-27). A forged or stale plan with team_id pointing at
-- tenant A's team — INSERTed into a tenant B row — would commit a
-- cross-tenant approver-of-record. Same defense-in-depth class as v3
-- routing_rule and v4 booking_rule/cost_center.
--
-- The fix follows the v4 pattern exactly: allowlist gate gains 'team',
-- one new CASE branch is appended before the else-raise, error code
-- mirrors the existing `<kind>_not_in_tenant` shape with errcode '42501'
-- so mapRpcErrorToAppError routes it to 404 (see map-rpc-error.ts
-- STATUS_BY_CODE addition in this PR).
--
-- Note on existing INSERT path (`createApprovalRows` at booking-flow.
-- service.ts:1266-1287): that legacy path is non-atomic supabase-js
-- batch insert and is itself a Phase 6 hardening target. The edit_booking
-- RPC will inline the equivalent INSERTs inside the PL/pgSQL body and
-- run `validate_entity_in_tenant('team', team_id)` on each approver
-- row before INSERT, closing the gap.
--
-- Idempotent: CREATE OR REPLACE FUNCTION rebuilds in place. Body mirrors
-- 00359 verbatim — only the allowlist gate gains 'team' and one new
-- CASE branch is appended before the else-raise. The destructive-default
-- invariant for booking subsystem migrations doesn't apply here (helper
-- function, no booking-table schema mutation).
--
-- Drop v4 explicitly before recreate to keep the upgrade path
-- audit-visible (the CREATE OR REPLACE would also work but the explicit
-- drop matches the v3 → v4 transition shape).

drop function if exists public.validate_entity_in_tenant(uuid, text, uuid);

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
  -- Allowlist — v5 (00360) adds 'team' for the B.4 edit_booking RPC's
  -- §3.6.5 approval-chain INSERTs. `approvals.approver_team_id`
  -- (00012:12) references `teams.id` GLOBALLY — the FK does not join
  -- through `teams.tenant_id` (00003:100), so a malicious or stale
  -- plan could otherwise commit `approver_team_id` pointing at
  -- another tenant's team. Same defense-in-depth class as v3
  -- routing_rule and v4 booking_rule + cost_center.
  if p_kind not in (
    'case', 'work_order', 'asset', 'space',
    'request_type', 'scope_override',
    'workflow_definition', 'sla_policy',
    'person',
    'routing_rule',
    'booking_rule',
    'cost_center',
    'team'
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

    -- v5 (00360) — team branch. codex finding.
    -- citation: 00012:12 `approvals.approver_team_id uuid references
    -- public.teams(id)` (GLOBAL FK) + 00003:100 `teams.tenant_id`
    -- (tenant-scoped, but cross-table FK can't enforce that join).
    -- The B.4 edit_booking RPC §3.6.5 INSERTs new approval rows on
    -- chain transitions; today's pattern at booking-flow.service.ts:
    -- 1275-1283 writes approver_team_id from
    -- `ApprovalConfig.required_approvers: Array<{type: 'team'|'person';
    -- id: string}>` (room-booking-rules/dto/index.ts:24-27). A forged
    -- plan could otherwise smuggle tenant A's team_id into tenant B's
    -- approval row.
    when 'team' then
      perform 1 from public.teams
       where id = p_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'validate_entity_in_tenant.team_not_in_tenant: % does not reference a known team in tenant %', p_id, p_tenant_id
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
  'v5 (00360) — Validates a tenant-owned entity referenced by a B.2 / B.4 combined RPC. Allowlisted kinds: case, work_order, asset, space, request_type, scope_override, workflow_definition, sla_policy, person, routing_rule, booking_rule, cost_center, team. Unknown kind raises 42501 ''validate_entity_in_tenant.unknown_kind''. Missing row raises 42501 ''validate_entity_in_tenant.<kind>_not_in_tenant''. case → public.tickets; work_order → public.work_orders (post step1c polymorphic split, migrations 00213-00233); person → public.persons; routing_rule → public.routing_rules (00018; routing_decisions.rule_id FK is GLOBAL per 00027:67); booking_rule → public.room_booking_rules (00121:5-7; bookings.applied_rule_ids[] has no per-element FK enforcement); cost_center → public.cost_centers (00140:74-76; bookings.cost_center_id is a single-col FK with no tenant join); team → public.teams (00003:98-113; approvals.approver_team_id at 00012:12 is a GLOBAL FK with no tenant join). SECURITY DEFINER, search_path locked. Spec: docs/follow-ups/b2-survey-and-design.md §3.8 + docs/follow-ups/b4-booking-edit-pipeline.md §3.4 + §3.6.5. v5 (00360) adds team for the §3.6.5 edit_booking approval-chain INSERTs (codex finding — same shape as Codex-S8-I1 routing_rule leak).';

notify pgrst, 'reload schema';
