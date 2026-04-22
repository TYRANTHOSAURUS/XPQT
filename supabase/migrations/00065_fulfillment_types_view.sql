-- 00065_fulfillment_types_view.sql
-- Read-only alias over request_types exposing only internal operational columns
-- (no portal-facing name/description/icon). Phase-2 backend code references this
-- alias so the phase-5 promotion to a real table is non-breaking.
-- See docs/service-catalog-redesign.md §3.8

create view public.fulfillment_types as
  select
    id,
    tenant_id,
    domain,                                   -- legacy text domain
    domain_id,                                -- FK added by 00039
    workflow_definition_id,
    sla_policy_id,
    default_assignment_policy_id,             -- legacy; deprecation noted in 00050
    case_owner_policy_entity_id,              -- routing v2
    child_dispatch_policy_entity_id,          -- routing v2
    fulfillment_strategy,
    requires_asset,
    asset_required,
    asset_type_filter,
    requires_location,
    location_required,
    location_granularity,
    default_team_id,
    default_vendor_id,
    requires_approval,
    approval_approver_team_id,
    approval_approver_person_id,
    active,
    created_at,
    updated_at
  from public.request_types;

comment on view public.fulfillment_types is
  'Read-only alias over request_types exposing only internal operational columns. Phase-5 cutover promotes this to a real table.';
