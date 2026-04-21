# Claude Brief: Fix the Service Catalog, Request Type, Routing, and Admin Model

## Purpose

This document is a direct brief for Claude.

The current implementation is not good enough. It has major product-model gaps, misleading admin UX, and several places where the shipped behavior does not match what a serious service management product needs.

Do not approach this as a lean pass, a low-effort cleanup, or a "good enough for now" iteration.

Non-negotiable:

- No lean version.
- No slack version.
- No half-implemented admin surfaces that pretend a feature exists when it does not.
- No fragmented CRUD-only configuration experience.
- No shipping misleading fields that are not authoritative at runtime.
- The target is top-tier, production-grade, admin-trustworthy service management UX and behavior.

The product should aim to become the best in its category for service catalog + workplace/FM routing + execution, not a weaker copy of Jira, Freshservice, or a generic helpdesk.

---

## Executive Summary

The current product has a structural mismatch:

- The portal does not properly know which request types a user should see.
- Request types do not cleanly model visibility, routing, ownership, dispatch, SLA, and workflow as one coherent service definition.
- Admin routing UX is fragmented across multiple low-level pages and exposes implementation details instead of operational outcomes.
- Some currently exposed fields are misleading or not truly authoritative.
- Runtime behavior is more capable than the admin UX in some places, while in other places the UX suggests capabilities that are not actually wired correctly.

This creates four serious product problems:

1. Employees can be shown request types that are not relevant or should not be available.
2. Admins cannot confidently predict what will happen when a ticket is submitted.
3. Routing configuration is too low-level and too fragmented to scale.
4. The product is behind best-in-class competitors on portal targeting and not yet differentiated enough on workplace/FM-native execution.

The solution is not a small patch. It is a coherent redesign around:

- scope-aware catalog availability
- clear separation of case ownership vs child dispatch
- request-type-centric service modeling
- simulator-first admin trust
- authoritative, unified admin UX

---

## What Is Wrong Right Now

### 1. The portal request type list is not scope-aware

Current behavior:

- The request type picker loads `/service-catalog/tree` and `/request-types` tenant-wide.
- The request type endpoint only supports a `domain` query filter.
- There is no authoritative portal-scoped endpoint that says "for this user, at this location, these are the request types they may raise".

Relevant files:

- `apps/web/src/components/request-type-picker.tsx`
- `apps/web/src/pages/portal/submit-request.tsx`
- `apps/api/src/modules/config-engine/request-type.controller.ts`
- `apps/api/src/modules/config-engine/request-type.service.ts`
- `apps/api/src/modules/config-engine/service-catalog.service.ts`

Why this is wrong:

- A serious service portal must not simply show all active request types in the tenant.
- Availability is part of the service definition, not a frontend afterthought.
- Routing depends heavily on location and scope, so the catalog must be scope-aware before the ticket is submitted, not only after.

### 2. There is no first-class model for "current location" vs "authorized locations"

Current behavior:

- There is no proper employee portal context for:
  - current location
  - home/default location
  - authorized location set
- `persons` do not currently carry a usable home/default location model.
- `user_role_assignments.location_scope` exists, but the portal does not use it to drive catalog visibility.
- The auth provider only loads role names, not usable scope context.

Relevant files:

- `supabase/migrations/00003_people_users_roles.sql`
- `apps/web/src/providers/auth-provider.tsx`
- `apps/api/src/modules/user-management/user-management.service.ts`
- `apps/web/src/components/location-combobox.tsx`
- `apps/api/src/modules/space/space.service.ts`

Why this is wrong:

- Workplace/FM-heavy service management needs location context at the start of the request journey.
- Employees should be able to submit for:
  - their current/default location
  - other locations they are explicitly allowed to act for
- Without this, the portal is noisy and routing is less trustworthy.

### 3. Request type availability is not enforced on submit

Current behavior:

- Ticket creation accepts `ticket_type_id`, `location_id`, and `requester_person_id`.
- The service then runs routing after insert.
- There is no authoritative validation that the selected request type is available to that requester at that location.

Relevant file:

- `apps/api/src/modules/ticket/ticket.service.ts`

Why this is wrong:

- Visibility rules must not live only in the portal UI.
- API-level validation is required.
- If the product later adds chat, API, virtual agent, or imported requests, availability rules must still be enforceable.

### 4. The request type editor exposes misleading routing concepts

Current behavior:

- The request type dialog exposes `Linked Routing Rule (override)`.
- This strongly suggests a request-type-scoped override model.
- Runtime resolver behavior does not actually operate as "this request type has its own ordered set of rules".

Relevant file:

- `apps/web/src/components/admin/request-type-dialog.tsx`

Why this is wrong:

- This is misleading configuration.
- Admins will assume this field governs routing for that request type in a clean and predictable way.
- If a field is not authoritative in runtime behavior, it should not be presented as a primary control.

### 5. Routing rules admin is too weak for the complexity of the engine

Current behavior:

- Routing rules page only supports a single condition row in the UI.
- It only exposes team assignment in the current editor.
- Runtime can evaluate multiple conditions and also supports user-target rules.
- Vendor targeting is missing from rules.

Relevant files:

- `apps/web/src/pages/admin/routing-rules.tsx`
- `apps/api/src/modules/routing/resolver.service.ts`
- `apps/api/src/modules/routing/resolver.types.ts`
- `supabase/migrations/00018_routing_rules.sql`

Why this is wrong:

- The UI under-expresses the runtime model.
- Some capabilities are hidden, some are incomplete, and some are absent.
- Admins are forced to reason through backend behavior instead of using a trustworthy configuration surface.

### 6. Routing admin is fragmented into low-level pages instead of one operational model

Current admin setup is split across separate pages for:

- request types
- routing rules
- location teams
- space groups
- domain parents
- SLA policies
- workflows

Why this is wrong:

- This forces admins to mentally stitch together one operational policy from many unrelated CRUD pages.
- It is not how real service operations teams think.
- The correct question is not "which row do I edit?" but:
  - what can this user request?
  - who owns it?
  - who executes it?
  - which SLA applies?
  - what happens by location, asset, or exception?

### 7. Portal and category/request type flow has correctness issues

Current behavior:

- Category pages use category-linked request types.
- Submit page also fetches `/request-types?domain=${categoryId}`, which mixes category and domain concepts incorrectly.

Relevant files:

- `apps/web/src/pages/portal/catalog-category.tsx`
- `apps/web/src/pages/portal/submit-request.tsx`

Why this is wrong:

- Category and domain are different concepts.
- Service catalog browsing should be category-driven.
- Routing should be domain-driven.
- The current mixing of those concerns is a product-model smell.

### 8. The product spec already points to richer catalog visibility than the implementation

The spec already expects catalog visibility by:

- location
- role
- department

Relevant file:

- `docs/spec.md`

This expectation is correct. The implementation is behind it.

---

## What We Are Missing

These are not "nice to have" features. Many are table stakes or essential differentiators.

### Portal and catalog

- request type availability policies
- current location defaulting
- authorized-location switching
- per-user scoped portal catalog endpoint
- role/department/location-based request type visibility
- explanation of why an item is or is not available
- backend validation of availability on submit

### Request type model

- one coherent model for:
  - availability
  - intake requirements
  - ownership routing
  - execution routing / dispatch
  - SLA
  - workflow
  - approval
  - overrides
- request type versioning / publish lifecycle
- real request-type-scoped policy surfaces instead of misleading references

### Routing and execution

- request-type-scoped advanced overrides
- multi-condition rule builder
- vendor-capable rule targeting where appropriate
- explicit separation of parent case owner vs child executor
- dispatch templates / child dispatch policy
- route simulator with trace and warning system
- coverage and conflict detection

### Admin UX

- one unified routing/service-definition studio
- matrix-first coverage view
- relationship map
- simulator
- impact preview before publish
- warnings for broken or partial configs
- defaults/inheritance/overrides displayed clearly
- authoritative summary of runtime behavior per request type

### Governance

- draft vs published config
- version history and diff
- rollback
- validation gates before publish
- stable read model for admin tooling

---

## Strategic Direction: How We Become the Best

Do not try to beat competitors by copying their weak spots.

The winning strategy is:

### 1. Match parity where parity matters

At minimum, reach parity on:

- request type visibility restrictions
- scoped catalog visibility
- proper request type hiding
- cleaner self-service targeting
- robust routing confidence

This is table stakes.

### 2. Win where workplace/FM service management is weak in competitors

The main differentiation should be:

- location-native service modeling
- hierarchical scope awareness
- authorized location switching
- case ownership vs execution split
- vendor dispatch as first-class execution, not a bolt-on
- one operational model across portal, desk, workflow, routing, and SLA

This is where generic ITSM tools often become awkward.

### 3. Build admin trust, not just configurability

Best-in-class does not mean "many fields".
It means:

- admins understand what they configured
- admins can preview outcomes
- admins can spot gaps before go-live
- admins do not need to understand internal tables

If an admin cannot answer "what happens when an Amsterdam employee raises this from New York for Vendor X?" in one or two clicks, the admin UX is not good enough.

---

## Design Principles

### Principle 1: Scope is first-class

Scope should be consistently modeled across:

- portal availability
- request type selection
- routing
- SLA
- workflow
- visibility

Scope is not just a routing input. It is a product-wide organizing concept.

### Principle 2: Request type is the service definition

A request type should be the main service object, not a loose bag of references.

It should answer:

- who can raise this
- from where
- what data is required
- who owns the case
- how execution is dispatched
- what SLA applies
- which workflow runs
- what exceptions exist

### Principle 3: Separate ownership from execution

Do not force one routing concept to do everything.

Keep these separate:

- portal availability
- parent case owner
- child work order dispatch
- visibility

### Principle 4: Simulator before trust

Every complex service/routing config must be previewable.

### Principle 5: Remove misleading UI

If a field is not authoritative, hide it.
If a concept is not fully supported, do not present it as a finished primary control.

---

## Target Product Model

Introduce a coherent service-definition model with these conceptual pieces:

### A. Portal Availability Policy

Per request type:

- availability mode:
  - everyone
  - current_location_only
  - authorized_locations
  - explicit_locations
  - role_based
  - department_based
  - composed policy
- optional allow rules
- optional deny rules
- optional explanation / admin note

### B. Intake Policy

Per request type:

- required location?
- required asset?
- allowed asset types?
- request for self vs for location vs for another person?
- prefilled/default location behavior

### C. Case Ownership Policy

Per request type:

- fixed team
- by location
- by asset
- by asset then location
- advanced override rules
- fallback target

### D. Child Dispatch Policy

Per request type:

- none
- manual
- workflow-driven
- template-driven
- vendor / team / user targets
- one child vs many children
- split by scope or task template

### E. SLA Policy

- case SLA
- child SLA resolution rules
- warnings for missing defaults

### F. Workflow Policy

- workflow binding
- approval gate
- dispatch templates
- post-create / approval-trigger behavior

---

## What The Admin UX Should Become

Do not keep the current fragmented pages as the primary authoring experience.

Build one top-level experience:

## Routing Studio / Service Definition Studio

Primary sections:

### 1. Routing Map

Main landing view.

Use a matrix:

- rows:
  - request types
  - or request type groups
- columns:
  - default owner
  - location coverage
  - execution policy
  - SLA
  - workflow
  - warnings

This should instantly show:

- what is covered
- what is missing
- what is inconsistent

### 2. Request Type Inspector

Selecting a request type opens a right-hand inspector or detail view showing:

- availability
- intake requirements
- owner routing
- child dispatch
- SLA
- workflow
- approvals
- advanced overrides
- simulator

### 3. Advanced Overrides

This is where the existing routing rules concept should live.

Not as a standalone primary admin surface.
Not as a fake single "linked rule" field in request type setup.

Advanced overrides should be:

- attached to a request type or clear scope
- ordered
- multi-condition
- human-readable
- validated
- previewable

### 4. Simulator

Inputs:

- requester
- current location
- acting-for location
- request type
- asset
- priority
- time window

Outputs:

- visible or not visible in portal
- why
- owner routing result
- dispatch result
- SLA result
- workflow result
- full trace
- warnings / conflicts / missing defaults

### 5. Coverage Warnings

Examples:

- request type visible in Amsterdam but no owner route exists there
- request type requires location but no authorized-location selection policy exists
- request type routes to vendor without child dispatch policy
- no after-hours owner configured
- location-based service has uncovered locations

---

## Concrete UX/Design Improvements

### Request Type Admin

Change the request type editor from a flat CRUD modal into a structured service-definition editor.

Must include:

- summary header with plain-language sentence:
  - "Visible to Amsterdam employees at their current or authorized locations. Owned by Workplace Ops by location. Dispatches janitorial vendors via workflow. 4h/24h case SLA."
- explicit availability section
- explicit ownership section
- explicit execution section
- explicit defaults and fallbacks
- warning badges
- simulator entry point

Remove or hide:

- misleading routing fields
- raw IDs in text inputs
- anything that implies runtime behavior the system does not actually follow

### Routing Rule Authoring

Replace the current single-condition form with:

- repeatable conditions
- grouped AND/OR support if possible
- request type condition
- location condition
- asset condition
- domain condition
- priority condition
- time-window condition later
- clear target selection
- readable preview sentence

### Portal UX

Portal must feel personalized and obvious:

- show current location selector near the top of the request journey
- allow switching to other authorized locations
- scope categories and request types based on selected location + policy
- show only relevant request types by default
- avoid dead generic lists
- if no items available for current location, guide the user

Examples:

- "Showing services for Amsterdam HQ"
- "You can also request for New York Office"
- "This service is only available at locations with catering support"

### Copy and Interaction Standards

- no vague config labels
- no implementation language as the primary UX
- no modal overload for complex policy editing
- no giant BPMN spaghetti canvas for all routing
- no hidden inheritance rules
- no disconnected config pages without outcome summaries

---

## Specific Changes Claude Should Make or Plan

### Immediate cleanup

1. Remove or hide the request type `Linked Routing Rule (override)` control until there is real, request-type-scoped authoritative behavior.
2. Stop showing `routing_rule_id` as a primary request type concept in the admin list.
3. Stop mixing category and domain filtering in the portal submit flow.
4. Stop using tenant-global request type lists for portal selection.
5. Add a real portal-scoped request type availability endpoint.

### Portal and API work

1. Add a portal context endpoint or `/me`-style endpoint that returns:
   - person
   - user
   - role scopes
   - authorized location scope
   - default/current location info
2. Add request type availability evaluation on the backend.
3. Add request type availability validation on ticket create.
4. Scope `/service-catalog/tree` or add a dedicated `/portal/catalog` endpoint that is availability-aware.
5. Scope `/spaces` for portal use or add a dedicated authorized-location endpoint.

### Data model work

Add a real model for:

- request type availability policy
- optionally person default/home location
- maybe per-user preferred/current portal location
- request type-scoped advanced override policies

### Admin UX work

1. Create a Routing Studio shell.
2. Make matrix-first coverage the landing page.
3. Move low-level routing tables under advanced configuration, not primary UX.
4. Add simulator and warnings before adding more power.

### Runtime work

1. Keep routing resolution deterministic and auditable.
2. Separate parent ownership from child execution more clearly.
3. Support vendor-aware execution patterns intentionally, not implicitly.

---

## File-Level Starting Points

Current code that should be treated as transition-state, not final design:

- `apps/web/src/components/admin/request-type-dialog.tsx`
- `apps/web/src/pages/admin/request-types.tsx`
- `apps/web/src/pages/admin/routing-rules.tsx`
- `apps/web/src/pages/admin/location-teams.tsx`
- `apps/web/src/components/request-type-picker.tsx`
- `apps/web/src/pages/portal/submit-request.tsx`
- `apps/web/src/pages/portal/catalog-category.tsx`
- `apps/web/src/providers/auth-provider.tsx`
- `apps/api/src/modules/config-engine/request-type.controller.ts`
- `apps/api/src/modules/config-engine/request-type.service.ts`
- `apps/api/src/modules/config-engine/service-catalog.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts`
- `apps/api/src/modules/routing/resolver.service.ts`
- `apps/api/src/modules/user-management/user-management.service.ts`
- `apps/api/src/modules/space/space.service.ts`

---

## Competitive Reference

Do not blindly copy competitors, but be aware of where they already set the baseline.

### ServiceNow

Baseline:

- user criteria can target role, department, group, location, and company
- catalog item and category visibility can be controlled via criteria
- location/department-driven visibility is already standard there

Why this matters:

- we must not be behind on core targeting of catalog/request visibility

### Jira Service Management

Baseline:

- request types can be restricted so users without access do not see them as raisable options
- request types and portal grouping are cleaner than our current state

Why this matters:

- access-controlled request raising is table stakes

### Freshservice

Baseline:

- service catalog visibility can be restricted, often via requester groups
- location-based visibility is achievable, but group-driven and less elegant

Why this matters:

- we can beat this by making location/scope native instead of group-hack-driven

### TOPdesk

Baseline:

- strong self-service portal positioning
- strong automatic delivery/routing messaging
- clearer FM/workplace-adjacent story than generic ITSM tools

Why this matters:

- our differentiation should be a better operational model and better admin confidence, not just nicer forms

---

## Quality Bar

Claude should optimize for:

- coherence over patchwork
- operational clarity over schema exposure
- admin trust over raw flexibility
- workplace/FM-native scope modeling over generic helpdesk abstractions
- simulator-backed confidence over hidden logic

Do not optimize for:

- smallest possible change set
- preserving misleading legacy UX
- shallow parity
- fragmented CRUD pages as the final answer

If a proposal still requires the admin to mentally combine 5 different pages to understand one request type, it is not good enough.

If a portal user can still see request types that are irrelevant to their location/scope, it is not good enough.

If routing remains understandable only by reading backend code, it is not good enough.

---

## Success Criteria

We are done when:

1. An employee sees only request types that are actually available to them for their current or authorized location context.
2. Request type availability is enforced in the backend, not only in the UI.
3. Admins can configure a realistic service definition from one coherent surface.
4. Admins can simulate visibility, routing, SLA, and workflow outcomes before publishing.
5. Ownership and execution are clearly separated.
6. Misleading legacy fields are removed or demoted.
7. The product clearly surpasses generic ITSM tools in location-aware workplace/FM service modeling.

---

## Final Instruction

Treat this as a product correction, not a polish pass.

The current system contains real conceptual flaws, missing core capabilities, and several UX patterns that should not survive into the serious version of the product.

Be decisive.
Remove misleading surfaces.
Unify the model.
Make scope first-class.
Build the admin experience around outcomes, not tables.
Make the product feel like the best choice for organizations with real-world locations, services, operators, and vendors.
