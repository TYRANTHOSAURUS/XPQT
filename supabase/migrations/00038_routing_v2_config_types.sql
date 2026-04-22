-- 00038_routing_v2_config_types.sql
-- Workstream 0 / Artifact A.6 + Artifact B:
-- 1. Extend config_entities.config_type allowed list with the Routing Studio v2 policy types.
-- 2. Add nullable policy-entity FK columns on request_types (required-by-cutover, not now).
--
-- Additive only. No existing rows change. No runtime behavior change.

-- ── 1. Extend allowed config types ───────────────────────────────
-- Postgres doesn't support altering a check constraint in place; drop and recreate.
alter table public.config_entities
  drop constraint if exists config_entities_config_type_check;

alter table public.config_entities
  add constraint config_entities_config_type_check
  check (config_type in (
    'request_type', 'form_schema', 'workflow', 'sla_policy',
    'routing_rule', 'notification_template', 'branding', 'terminology',
    'booking_rule', 'approval_rule', 'assignment_policy',
    -- Routing Studio v2:
    'case_owner_policy', 'child_dispatch_policy', 'domain_registry', 'space_levels'
  ));

-- ── 2. request_types policy references (nullable during migration) ──
alter table public.request_types
  add column if not exists case_owner_policy_entity_id uuid
    references public.config_entities(id),
  add column if not exists child_dispatch_policy_entity_id uuid
    references public.config_entities(id);

create index if not exists idx_request_types_case_owner_policy
  on public.request_types (case_owner_policy_entity_id)
  where case_owner_policy_entity_id is not null;

create index if not exists idx_request_types_child_dispatch_policy
  on public.request_types (child_dispatch_policy_entity_id)
  where child_dispatch_policy_entity_id is not null;

comment on column public.request_types.case_owner_policy_entity_id is
  'Routing Studio v2: case_owner_policy config entity. Nullable during dual-run; required after v2_only cutover.';
comment on column public.request_types.child_dispatch_policy_entity_id is
  'Routing Studio v2: child_dispatch_policy config entity. Nullable during dual-run; required after v2_only cutover.';
