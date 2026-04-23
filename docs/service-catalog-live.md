# Service Catalog Live Architecture

**Status:** Live source of truth  
**Date:** 2026-04-23  
**Supersedes:** `docs/service-catalog-redesign.md` for catalog/request-type architecture

**Related references:**

- `docs/assignments-routing-fulfillment.md`
- `docs/superpowers/specs/2026-04-17-workflows-visual-editor-design.md`

## 1. Decisions

1. Remove the split `service_items` model completely. No bridge table, no mirror triggers, no compatibility RPCs, no dual admin nouns.
2. Keep exactly one primary entity: `request_types`.
3. `request_types` must answer all of these:
   - what the employee sees
   - who can see/request it
   - where it is offered
   - what intake it requires
   - how it is fulfilled by default
   - what changes by location/group/scope
4. Routing is not catalog visibility. Routing computes the effective handler. Catalog availability is a first-class configuration.
5. Workflow and SLA must support global defaults plus scoped overrides.
6. Case fulfillment and child execution are different concerns and must be modeled separately.
7. The admin surface should expose one thing only. The UI label can be `Service` later if desired, but there must not be a second backend concept for the same thing.

## 2. Problem To Solve

The old split introduced two objects that overlap but do not line up cleanly:

- `service_items` for portal behavior
- `request_types` for fulfillment behavior

That split created:

- duplicate authoring paths
- trigger-based sync
- bridge lookups
- tree UI on `request_types` but portal runtime on `service_items`
- no clean answer for location-scoped workflow/SLA/handler overrides

This is not acceptable for an in-development product. We will collapse back to one model.

## 3. Canonical Mental Model

One `request_type` is one employee-facing service definition.

It has five responsibilities:

1. Identity
   - name, description, icon, search terms, category placement
2. Consumer targeting
   - who can see it
   - who can request it
   - who can request on behalf of whom
3. Coverage
   - where it is offered
4. Intake
   - form variant, location/asset requirements, granularity
5. Fulfillment
   - handler default
   - case workflow default
   - case SLA default
   - child dispatch default
   - approval/default execution behavior

Routing remains a separate engine, but it is a fulfillment dependency, not a second catalog object.

## 4. What `request_types` Must Contain

`request_types` stays the root table and becomes the only source of truth for both portal and operational authoring.

### 4.1 Core fields on `request_types`

- Basics:
  - `name`
  - `description`
  - `icon`
  - `keywords`
  - `kb_link`
  - `disruption_banner`
  - `display_order`
  - `active`
- Intake:
  - `form_schema_id` as default form
  - `requires_location`
  - `location_required`
  - `location_granularity`
  - `requires_asset`
  - `asset_required`
  - `asset_type_filter`
  - `on_behalf_policy`
- Fulfillment defaults:
  - `domain` / `domain_id`
  - `fulfillment_strategy`
  - `default_team_id`
  - `default_vendor_id`
  - `workflow_definition_id`
  - `sla_policy_id` for the parent case SLA
  - `case_owner_policy_entity_id`
  - `child_dispatch_policy_entity_id`
  - approval fields

### 4.2 Supporting tables

These remain, but are request-type scoped only:

- `request_type_categories`
- `criteria_sets`
- `request_type_coverage_rules`
- `request_type_audience_rules`
- `request_type_form_variants`
- `request_type_on_behalf_rules`
- `request_type_scope_overrides`

## 5. New Supporting Tables

### 5.1 `request_type_coverage_rules`

Answers only: where is this request type offered?

Columns:

- `request_type_id`
- `scope_kind` = `tenant | space | space_group`
- `space_id`
- `space_group_id`
- `inherit_to_descendants`
- `starts_at`
- `ends_at`
- `active`

This drives portal visibility by location. It does not assign teams or vendors.

### 5.2 `request_type_audience_rules`

Answers only: who can see/request this?

Columns:

- `request_type_id`
- `criteria_set_id`
- `mode` = `visible_allow | visible_deny | request_allow | request_deny`
- `starts_at`
- `ends_at`
- `active`

### 5.3 `request_type_form_variants`

Answers only: which form variant applies?

Columns:

- `request_type_id`
- `criteria_set_id` nullable for default
- `form_schema_id`
- `priority`
- `starts_at`
- `ends_at`
- `active`

### 5.4 `request_type_on_behalf_rules`

Answers only: who may submit on behalf of whom?

Columns:

- `request_type_id`
- `role` = `actor | target`
- `criteria_set_id`

### 5.5 `request_type_scope_overrides`

Answers: what fulfillment behavior changes at a scope?

Columns:

- `request_type_id`
- `scope_kind` = `tenant | space | space_group`
- `space_id`
- `space_group_id`
- `inherit_to_descendants`
- `active`
- `starts_at`
- `ends_at`
- optional override fields:
  - `handler_kind`
  - `handler_team_id`
  - `handler_vendor_id`
  - `workflow_definition_id`
  - `case_sla_policy_id`
  - `case_owner_policy_entity_id`
  - `child_dispatch_policy_entity_id`
  - `executor_sla_policy_id`

This table is request-type-specific. It exists because generic routing tables are too broad when exceptions apply to one request type but not another in the same domain.

## 6. Runtime Rules

### 6.1 Visibility

`visible(request_type, actor, selected_location)` is true only if:

1. request type is active
2. actor is authorized for the selected location
3. a coverage rule matches the selected location
4. audience rules pass

### 6.2 Requestability

`requestable(request_type, actor, requested_for, location, asset)` is true only if:

1. visible is true
2. on-behalf rules pass
3. intake requirements pass
4. form variant resolution succeeds

### 6.3 Effective fulfillment resolution

For a given request type and location, the effective values resolve in this order:

1. exact `request_type_scope_overrides` match
2. inherited ancestor `request_type_scope_overrides` match
3. `space_group` override match
4. tenant override
5. request type default
6. generic routing/handler defaults where applicable

### 6.4 Effective handler

Handler resolution order:

1. explicit request-type scoped handler override
2. routing rules
3. asset override / asset type default
4. location-based routing (`location_teams`, domain chain, group chain)
5. request type default handler
6. unassigned

The coverage matrix should display the computed handler from this stack. Admins may then create a request-type-specific exception on top of it.

## 7. Workflow, Dispatch, And SLA

### 7.1 Case workflow

Case workflow should be request-type-specific by default and location-specific only when the business process itself differs.

Resolution order:

1. scoped workflow override
2. `request_types.workflow_definition_id`

Rule:

- Do not create separate workflows only because the executor changes by location.
- If only the handler changes, routing or child dispatch policy should absorb that difference.
- Use a workflow override only when the process, approval path, or task graph actually differs.

### 7.2 Child execution

Child executor selection should not be hardcoded into the workflow graph for location-specific vendor differences.

Use:

1. scoped `child_dispatch_policy_entity_id` override
2. request type default `child_dispatch_policy_entity_id`
3. child dispatch engine

That is the correct place to handle per-location vendor/team selection for generated child work.

#### Workflow branching rule

Do **not** solve location-specific execution by:

- copying the same workflow once per location
- adding large chains of location `if` nodes whose only purpose is to change assignees
- hardcoding vendor/team ids into child-task nodes for every site exception

That makes the workflow graph carry routing data and becomes unmaintainable.

Use this decision rule instead:

1. Same process, same child tasks, different assignee by location  
   Keep one workflow. Let child dispatch resolve the assignee by location/policy.
2. Same process, same child tasks, different child SLA by location or contract  
   Keep one workflow. Use scoped executor-SLA overrides.
3. Same process, but one site has a small exception for one child task target  
   Keep one workflow. Add a scoped child-dispatch override for that request type + scope.
4. Different process graph, approvals, mandatory steps, or materially different child-task set  
   Use a separate scoped workflow override.

Short version:

- assignee differences -> dispatch policy / matrix
- SLA differences -> scoped SLA override
- process differences -> different workflow

#### Child-task node design

The child-task node should primarily describe **what work must be created**, not **which exact vendor/team gets it** at each location.

Preferred node payload:

- task title / description
- interaction mode
- optional explicit SLA override
- optional dispatch hint such as:
  - `dispatch_role`
  - `vendor_service`
  - `capability`
  - `domain_override`

The child-dispatch engine should combine that hint with:

- request type
- location
- asset
- scoped overrides
- routing policy

to resolve the actual assignee.

Hardcoded `assigned_team_id` / `assigned_vendor_id` should remain available only for truly fixed tasks that never vary by scope.

### 7.3 Case SLA

Case SLA is the requester-facing promise.

Resolution order:

1. scoped `case_sla_policy_id`
2. `request_types.sla_policy_id`

Case SLA should be allowed to vary by location because the promised response window can differ by site, country, contract, or support model.

### 7.4 Child / executor SLA

Child SLA is not the same as case SLA.

Resolution order:

1. explicit workflow task SLA
2. scoped `executor_sla_policy_id`
3. vendor default SLA
4. team default SLA
5. assigned user's team default SLA
6. null

This keeps the executor SLA contract tied to the actual assignee while still allowing request-type + location exceptions.

## 8. Admin UX

The correct admin surface is the catalog hierarchy plus side panel.

Tree:

- categories
- request types directly under categories

Panel tabs:

1. Basics
2. Audience
3. Coverage Matrix
4. Intake
5. Fulfillment Defaults

The Coverage Matrix becomes the main operational sheet. Each row should show:

- location/group
- offered or not offered
- effective handler
- handler override
- effective case workflow
- workflow override
- effective case SLA
- SLA override
- effective child dispatch policy
- dispatch override
- effective executor SLA
- executor SLA override

Clicking a row should open a detail panel with:

- matched coverage rule
- matched audience state
- matched scoped override
- effective routing trace
- inheritance path

## 9. What Gets Deleted

Delete completely:

- `service_items`
- `service_item_categories`
- `service_item_offerings`
- `service_item_criteria`
- `service_item_form_variants`
- `service_item_on_behalf_rules`
- `request_type_service_item_bridge`
- `fulfillment_types` view
- mirror triggers and compat triggers for request type/service item sync
- service-item admin pages, controllers, services, and RPCs
- compatibility portal functions built around service-item ids

Rename or recreate as request-type-native:

- `service_item_offerings` -> `request_type_coverage_rules`
- `service_item_criteria` -> `request_type_audience_rules`
- `service_item_form_variants` -> `request_type_form_variants`
- `service_item_on_behalf_rules` -> `request_type_on_behalf_rules`

The portal, admin tree, submit path, and simulator should all operate directly on `request_type_id`.

## 10. API / RPC Direction

Canonical endpoints should become request-type-native:

- `GET /request-types`
- `GET /request-types/:id`
- `PATCH /request-types/:id`
- `PUT /request-types/:id/categories`
- `PUT /request-types/:id/coverage`
- `PUT /request-types/:id/audience`
- `PUT /request-types/:id/form-variants`
- `PUT /request-types/:id/on-behalf-rules`
- `PUT /request-types/:id/scope-overrides`
- `GET /request-types/:id/coverage-matrix`

Canonical portal functions should become:

- `portal_visible_request_type_ids`
- `portal_requestable_trace`
- `portal_onboardable_request_type_locations`

These are primary APIs again, not wrappers.

## 11. Implementation Plan

### Phase 1: Stop the split

1. Declare this doc the source of truth.
2. Stop building new behavior on `service_items`.
3. Remove admin navigation to standalone service-item surfaces.

### Phase 2: Collapse schema

1. Move any remaining portal-only columns needed onto `request_types`.
2. Replace service-item-scoped tables with request-type-scoped tables.
3. Migrate existing service-item data back onto request types.
4. Drop bridge tables, views, and mirror triggers.

### Phase 3: Rewire runtime

1. Portal catalog reads request types directly.
2. Portal submit validates request types directly.
3. Coverage matrix computes effective handler/workflow/SLA using the new override stack.
4. Admin simulator traces request type availability and fulfillment directly.

### Phase 4: Rewire admin UX

1. Keep one tree page only.
2. Rename the primary admin noun if wanted, but keep one concept only.
3. Add full CRUD for audience, form variants, on-behalf rules, and scope overrides.

### Phase 5: Hard cleanup

1. Delete dead service-item codepaths.
2. Delete compatibility SQL functions.
3. Delete old docs that describe the split model or mark them superseded.

## 12. Performance And Quality Guardrails

This architecture is strong and competitive **only if implemented set-based and with bounded runtime resolution**.

### 12.1 What good looks like

1. Build a normalized runtime context once per request or ticket:
   - effective location
   - site/building ancestry
   - asset type
   - requester/requested-for attributes
   - assignment state
2. Evaluate portal visibility and requestability in SQL/RPC, not by looping in the API over request types.
3. Resolve scope overrides by precedence with indexed lookups, not repeated ad hoc queries.
4. Preload routing candidates for the full location/domain chain in one query per evaluation, then resolve in memory.
5. Cache published workflow definitions and routing-policy definitions by version.
6. Keep workflow conditions typed and metadata-driven, with real-value pickers rather than free-text ids.

### 12.2 What to avoid

1. N+1 queries across request types, criteria sets, locations, or overrides.
2. Workflow graphs carrying routing data for every site/vendor exception.
3. Per-node or per-branch DB lookups during condition evaluation when a normalized context could have been built once.
4. Recomputing location ancestry or domain chains repeatedly inside nested loops.
5. Using routing reachability as the primary catalog visibility rule.

### 12.3 Required indexing shape

At minimum:

- `request_type_coverage_rules`
  - `(tenant_id, request_type_id, active)`
  - `(tenant_id, scope_kind, space_id)` where `space_id is not null`
  - `(tenant_id, scope_kind, space_group_id)` where `space_group_id is not null`
- `request_type_audience_rules`
  - `(tenant_id, request_type_id, mode, active)`
- `request_type_form_variants`
  - `(tenant_id, request_type_id, active, priority desc)`
- `request_type_scope_overrides`
  - `(tenant_id, request_type_id, active, scope_kind)`
  - partial indexes for `space_id` and `space_group_id`
- `location_teams`
  - `(tenant_id, space_id, domain)`
  - `(tenant_id, space_group_id, domain)` where `space_group_id is not null`

### 12.4 Best-in-class claim

For the target segment, this architecture is best-in-class **if** all of the following remain true:

1. One primary admin concept only.
2. Visibility, fulfillment, workflow, and SLA are separated cleanly.
3. Location-aware exceptions are explicit and traceable.
4. Runtime evaluation stays bounded and explainable.
5. Admin UI exposes effective behavior and provenance, not hidden implicit magic.

If the implementation drifts back into trigger-sync models, duplicated nouns, free-text workflow conditions, or N+1 runtime lookups, it will stop being best-in-class even if the schema looks good on paper.

## 13. Guardrails

1. Do not use routing as visibility.
2. Do not use workflow to encode per-location vendor selection when dispatch policy should do it.
3. Do not treat case SLA and child SLA as the same field.
4. Do not reintroduce a second catalog noun.
5. Do not hide scoped overrides in generic routing tables when the exception is request-type-specific.

## 14. Short Answer

Yes:

- the request type must contain consumer targeting
- the fulfillment view should show routing-derived defaults
- exceptions should be editable from the coverage matrix
- workflow may be location-specific, but only when process differs
- case SLA may be location-specific
- child SLA should be executor-aware and may also be overridden by request type + scope

But all of that must live under one request-type-centered model, not a split `service_items` architecture.
