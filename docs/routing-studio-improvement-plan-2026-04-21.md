# Routing Studio Improvement Plan

> **Status as of 2026-04-28 — substantially shipped.** The studio ships at `apps/web/src/pages/admin/routing-studio.tsx` with the seven proposed top-level tabs (`Routing Map`, `Case Ownership`, `Child Dispatch`, `Visibility`, `Simulator`, `Advanced Overrides`, `Audit`). The `Rules → Advanced Overrides` rename landed. Open work remaining at this date: `apps/web/src/components/admin/routing-studio/visibility-tab.tsx` is still a placeholder. Operational reference for shipped behaviour: [`docs/assignments-routing-fulfillment.md`](./assignments-routing-fulfillment.md) §23. Prose below describes the *plan* state at 2026-04-21 and is preserved as a benchmark — references to "the current branch" and "feat/routing-studio" are historical.

## Goal

Redesign the routing studio so it matches how service operations actually work:

- `Parent case` handles intake, triage, requester communication, and accountability.
- `Child work orders` handle execution by internal specialists or external vendors.
- `Visibility` is configured independently from assignment.

The current routing foundation is technically capable, but the admin experience exposes too many low-level concepts separately and does not clearly distinguish ownership from execution.

## Scope Note

This is no longer just a UX cleanup plan.

It combines:

- a routing-studio UX redesign
- runtime extensions for scope source, split behavior, and time-window routing
- data-model hardening
- policy lifecycle integration with the existing config engine

That distinction matters for delivery planning:

- some parts are pure UI reframing
- some parts require schema and resolver changes
- some parts require orchestration changes outside the resolver

This document is written against the current checked-out branch, where routing admin is still split across separate pages.

However, there is already a feature-flagged `feat/routing-studio` branch with:

- `Overview`
- `Simulator`
- `Rules`
- `Coverage`
- `Mappings`
- `Groups`
- `Fallbacks`
- `Audit`

The full program should treat that branch as the starting point for Workstream E, not as throwaway work.

## Routing Studio Branch Reconciliation

The existing `feat/routing-studio` branch should be extended in place.

Recommended mapping:

- keep and extend:
  - `Overview`
  - `Simulator`
  - `Coverage`
  - `Audit`
- rename:
  - `Rules` -> `Advanced Overrides`
- absorb into `Child Dispatch`:
  - `Mappings`
  - `Groups`
  - `Fallbacks`
- add:
  - `Case Ownership`
  - `Visibility`

This means Workstream E is an evolution of the current studio branch, not a greenfield rebuild.

Important UX correction:

- the current branch is still too spread and too implementation-shaped
- the final studio should not preserve eight peer tabs as the end-state
- `Mappings`, `Groups`, and `Fallbacks` are editing mechanisms, not top-level mental models
- the final admin experience should be task-oriented:
  - who owns the case?
  - does work split?
  - where does each child go?
  - who can see it?
  - why did it route this way?

## Keep, Extend, Replace

This is not a ground-up rewrite of all routing internals.

### Keep

- the core resolver approach for picking one target from one normalized context
- `routing_decisions` as the audit trail
- `location_teams`, `space_groups`, and `domain_parents` as useful runtime building blocks
- parent case and child work-order ticket model
- the existing config engine (`config_entities`, `config_versions`) as the versioning lifecycle

### Extend

- request-type policy model
- intake scoping before routing
- resolver inputs for time-window-aware routing
- dispatch/orchestration for declarative child splitting
- simulator and coverage capabilities

### Replace

- fragmented routing admin pages as the primary authoring experience
- ambiguous request-type routing UI fields
- free-text domain authoring as the long-term model

## Current Problems

### Product model problems

- "Routing" is treated as one concept, but operationally it is three:
  - case ownership
  - child dispatch
  - visibility
- The system supports parent cases and child work orders, but the admin UI does not reflect that split clearly.
- Complex execution routing is mixed into the same mental model as requester-facing case assignment.

### UX problems

- The routing setup is fragmented across separate admin pages:
  - `Routing Rules`
  - `Location Teams`
  - `Space Groups`
  - `Domain Hierarchy`
  - parts of `Request Types`
- Admins must understand internal implementation details before they can configure a realistic routing flow.
- There is no single "simulate this request" view that explains where a case or child ticket will go and why.
- Coverage gaps are hard to see:
  - missing default owners
  - missing location coverage
  - dead rules
  - unreachable fallbacks
  - conflicting mappings

### Logic problems

- Parent case routing and child execution routing are not modeled as separate first-class steps.
- Visibility is too easy to confuse with assignment.
- Rules are globally powerful but locally hard to reason about.
- Asset-based routing exists in the resolver, but the admin surface for configuring asset defaults and overrides is incomplete.
- Domain management relies too much on exact text values instead of a controlled registry.
- Split/orchestration behavior is not separated clearly enough from assignee resolution.
- Policy lifecycle is not aligned with the existing config engine.

## Design Principles

1. `Cases are owned, work orders are executed.`
2. `Vendors should usually receive child work orders, not the parent case.`
3. `Visibility is policy-based, not assignee-based.`
4. `Request type is the main configuration entry point.`
5. `Most customers should succeed without touching advanced rules.`
6. `Every routing decision should be previewable before it is trusted.`
7. `The source of scope must be explicit.`
8. `Time matters.` Ownership and execution may differ by business hours, region handoff, or emergency mode.

## Target Operating Model

### 1. Case ownership

Each request type should define a `case owner policy`.

This answers:

- Which internal queue owns the requester-facing case?
- Who triages first?
- Who communicates with the requester?
- Which case SLA applies?

In most real implementations, this should resolve to an internal coordinating team or desk network:

- `Service Desk Amsterdam`
- `Service Desk France`
- `IT Service Desk EMEA`
- `FM Coordination North`
- `Catering Operations Paris`

This should support scoped ownership, not just one global desk per domain.

Typical scopes:

- country
- region
- campus
- building group
- business unit
- legal entity

Example ownership chain:

- Amsterdam office IT requests -> `IT Service Desk Amsterdam`
- France office IT requests -> `IT Service Desk France`
- any other EMEA IT request -> `IT Service Desk EMEA`
- fallback -> `Global Service Desk`

Default rule: parent cases should almost never route directly to vendors.

### 1a. Scope source must be explicit

One of the biggest real-world failure modes is silent ambiguity about which location or organization scope drives ownership.

The studio should force an explicit scope source:

- requester home location
- selected request location
- asset's assigned location
- requester's business unit
- requester's legal entity
- manually chosen operational scope

Example:

- laptop issue -> use `asset location` if asset is present, else `requester home location`
- office cleaning request -> use `selected request location`
- general access request -> use `requester legal entity` or `business unit`

### 2. Child dispatch

Execution logic should primarily live in child work orders.

This answers:

- Does this case need zero, one, or multiple child work orders?
- Should the child go to an internal team, specific user, or vendor?
- Should execution depend on location, asset, domain fallback, or exceptions?

Dispatch should support:

- manual dispatch by the coordinator
- workflow-driven dispatch
- request-type dispatch templates
- resolver-backed assignee selection for children

### 2a. Multi-location and multi-scope work

The model must support tickets that concern more than one site, building, or operational area.

Examples:

- catering request covering Amsterdam and Utrecht
- FM incident affecting multiple floors
- IT rollout affecting France and Belgium offices

Recommended handling:

- parent case keeps the overall coordination scope
- child work orders split by executable scope
- each child gets its own assignee, SLA, and visibility

### 3. Visibility

Visibility must be configured independently from both case owner and child assignee.

This answers:

- Who can see all tickets in this domain?
- Who can see tickets only for certain locations?
- Which coordination team can always see children spawned from its parent cases?
- What should vendors see?

Default visibility pattern:

- coordinating desk sees the parent case
- coordinating desk also sees all children of its cases
- assigned executor sees the child assigned to them
- vendor sees only vendor-assigned children relevant to them
- requester interacts mainly with the parent case

This should also support multi-scope visibility overlays, for example:

- Service Desk EMEA sees all cases in EMEA
- Service Desk Amsterdam sees NL and Amsterdam campus cases
- FM France sees all FM work in French buildings

## Routing Studio Redesign

## Replace the current page set with one Routing Studio

Replace the current fragmented model with one primary screen:

- `Routing Studio`

Inside the studio, organize by request type and by routing phase.

## Human-readable principle

The routing studio must be understandable to an operations admin without needing to think like an engineer.

If the only visual that makes sense is the matrix, that is a sign that:

- the matrix is closest to the user's real mental model
- the rest of the UI is too implementation-shaped
- forms, tabs, and low-level editors should be subordinate to the matrix, not the other way around

Primary UX rule:

- the matrix should be the main screen
- everything else should explain, edit, or simulate what the matrix shows

### Recommended information architecture

1. `Routing Map`
2. `Case Ownership`
3. `Child Dispatch`
4. `Visibility`
5. `Explain / Simulator`
6. `Advanced Overrides`
7. `Audit`

This is the maximum top-level structure, not a target to add more tabs.

Design rule:

- top-level sections should map to admin decisions
- low-level editors should live inside those sections as panels, drawers, or subviews
- implementation nouns like `groups`, `fallbacks`, and `mappings` should not be first-class navigation if they are only one way of editing a broader policy
- the matrix should be the default landing view, not a secondary diagnostic tab

## Routing Map

This should be the primary home of the studio.

It should answer, visually and immediately:

- who owns the parent case here?
- where would child work go here?
- where is there no coverage?
- where is fallback being used?
- where are vendors involved?

Recommended first version:

- rows = operational scope
  - country
  - campus
  - building
  - location group
- columns = domain or request-type family
- cell content shows:
  - case owner
  - child dispatch summary
  - fallback indicator
  - warning state

Recommended interactions:

- click a cell -> open side panel
- side panel shows:
  - case owner policy for that cell
  - child dispatch behavior for that cell
  - visibility summary
  - explanation trace
  - edit actions

The matrix should be editable, not just informative.

That means:

- inline status and warning colors
- click-to-edit cell details
- drawer-based editing for the selected slice
- quick links to advanced overrides only when needed

### Routing Map warnings

The matrix should surface warnings directly in cells and row summaries:

- "No default case owner"
- "Location dispatch enabled but no coverage for 12 active spaces"
- "Domain fallback exists but no parent domain mapping"
- "Advanced override never matches any known request context"
- "Ownership source is ambiguous: both requester and asset location exist"
- "No after-hours owner configured for a 24/7 request type"
- "Multi-location request type has no split strategy"

### Case Ownership tab

This should be simple and opinionated.

This should usually open from a selected matrix cell or scope slice, not force the admin to start from an abstract form.

Fields:

- owner team
- optional owner scoping by country, region, campus, building family, or business unit
- fallback team
- whether approval delays ownership or just execution
- scope source
- optional support-hours or after-hours qualifier

UI behavior:

- show this as a clean policy builder, not a rule editor
- explain in plain language:
  - "New cases of this type go to IT Service Desk"
  - "If location-specific ownership exists, Amsterdam goes to IT Service Desk Amsterdam, France goes to IT Service Desk France, otherwise IT Service Desk EMEA"

Recommended policy shape:

- scoped owner rows
- ordered from most specific to least specific
- explicit default fallback
- explicit scope source
- optional time-window qualifier

Example:

- `country = NL` -> `Service Desk Amsterdam`
- `country = FR` -> `Service Desk France`
- `region = EMEA` -> `Service Desk EMEA`
- `default` -> `Global Service Desk`

Example with after-hours:

- `country = NL and support_window = business_hours` -> `Service Desk Amsterdam`
- `country = NL and support_window = after_hours` -> `IT On-Call EMEA`
- `default` -> `Global Service Desk`

### Child Dispatch tab

This is where most complexity belongs.

This should also be entered from a selected matrix cell or request-type slice, so the admin is always editing concrete coverage instead of abstract routing tables.

Structure it as a guided builder:

1. dispatch mode:
  - no child tickets
  - optional child tickets
  - always create child tickets
  - multi-child template
2. execution routing source:
  - fixed internal team
  - by asset
  - by location
  - by asset then location
  - by workflow template
3. fallback target
4. vendor/internal execution options
5. split strategy:
  - no split
  - split per location
  - split per asset
  - split per vendor or service line

This tab should absorb and reframe:

- `Location Teams`
- `Space Groups`
- `Domain Hierarchy`
- asset defaults and overrides

But present them in business language:

- "Where should execution go?"
- "Which locations share an execution team?"
- "When should this fall back to FM?"
- "Which vendor handles this asset type?"

### Visibility tab

Make visibility explicit instead of implicit.

This should summarize visibility for the selected matrix slice in plain language before exposing any low-level controls.

Recommended sections:

- `Always visible to`
- `Visible by location scope`
- `Visible to parent owner for all spawned children`
- `Vendor access rules`
- `Requester-facing vs internal-only child visibility`
- `Regional/global desk overlays`
- `Cross-location support team visibility`

This should explain clearly that visibility does not change who owns or executes the work.

### Advanced Overrides tab

This is where the existing `routing_rules` concept should live.

Keep it behind an advanced section.

Rules should be framed as exceptions, not the main model:

- VIP priority override
- temporary incident reroute
- special campus exception
- emergency vendor bypass

Improvements:

- support multiple conditions with a proper builder
- support team, user, and vendor targets where appropriate
- show scope explicitly:
  - affects case ownership
  - affects child dispatch
  - affects both
- show precedence and conflicts

### Explain / Simulator

This is the highest-value UX improvement.

Admins should be able to enter:

- request type
- domain
- priority
- location
- asset
- whether they are simulating a parent case or child work order

The simulator should show:

- chosen owner or executor
- step-by-step trace
- why a fallback was used
- which policy/rule matched
- what visibility groups would apply
- which scope source was used
- whether business-hours or after-hours logic changed the result
- whether the request would split into multiple child work orders

This turns the resolver from a black box into an understandable admin tool.

The simulator should also be reachable from a matrix cell as:

- `Why this cell routes this way`
- `What if I changed this owner`
- `What if this came in after hours`

### Audit

Audit should not be a primary setup experience.

It should support explanation and trust:

- what changed
- who changed it
- when it changed
- what effect it had

Audit is important, but for most admins it is not where understanding begins.

## Logic Improvements

## 1. Separate parent and child routing policies

Introduce explicit concepts in the model:

- `case_owner_policy`
- `child_dispatch_policy`
- `visibility_policy`
- `scope_source_policy`
- `split_policy`

Even if some reuse shared internals, they should be separate in the admin and service layers.

### 1a. Separate orchestration from resolution

There are two engines here, not one:

- `Split / orchestration engine`
  - decides whether to create zero, one, or many child work orders
  - decides the scope of each child
- `Resolver / assignment engine`
  - given one concrete context, chooses one assignee target

This should be explicit in both architecture and UI.

Recommended child-dispatch structure:

- `How many children should be created?`
- `What scope does each child get?`
- `Where should each child go?`

The resolver should remain focused on the last question.

### 1b. Add an intake scoping layer before the resolver

`Scope source` should be resolved before owner selection or child assignee selection runs.

That intake layer should:

- decide whether location comes from requester, selected location, asset, or another scope input
- normalize the routing context
- record which scope source was used

This avoids smuggling ambiguous location decisions into the resolver.

## 2. Make parent routing intentionally simple

Parent case routing should default to:

- fixed desk ownership
- optional location-scoped ownership
- optional country/region/business-unit ownership
- optional domain-scoped ownership
- optional time-window ownership
- fallback to default coordination desk

Do not encourage vendor assignment on parent cases.

## 3. Make child routing the main execution engine

The resolver should remain the engine for child work orders and should support:

- asset override
- asset type default
- location assignment
- shared location groups
- domain fallback
- request-type default execution target
- advanced exception rules

This is where vendor routing should primarily happen.

## 4. Keep visibility fully separate

Visibility should not be derived from assignment alone.

Implement explicit policies such as:

- service desk sees all cases in selected domains
- local desks see all cases in selected locations
- parent owner sees children of owned cases
- vendors only see their own child work orders
- regional overlays see tickets across multiple owned desks without becoming owner

## 5. Replace free-text domains with a managed registry

Create a real `domains` configuration source:

- id
- key
- display name
- optional parent domain
- active flag

Then use it everywhere:

- request types
- location dispatch mappings
- overrides
- simulator

This removes typo-driven routing bugs and makes fallback safer.

## 6. Tighten configuration constraints

Enforce stronger guardrails:

- exactly one target type per routing row where required
- no hidden precedence between multiple assignee columns
- reject malformed rule conditions
- reject unreachable or cyclic fallback chains
- require defaults when a request type is active in production

## 7. Complete the asset routing surface

Expose configuration for:

- asset type execution defaults
- per-asset execution overrides
- whether asset routing applies to case owner or child dispatch

Asset routing should be a normal admin path, not only a backend capability.

## 8. Add explicit split logic for multi-executor work

The routing studio should not assume one parent maps to one child.

Add configurable split policies:

- no child
- one child only
- one child per selected location
- one child per vendor or service line
- one child per asset
- workflow-defined multi-child template

This is critical for FM, catering, and rollout-style IT work.

## 9. Support business-hours and regional handoff logic

Real operations often change ownership or execution outside local support hours.

Support:

- business-hours desk ownership
- after-hours fallback desk
- follow-the-sun handoff
- emergency routing path

The studio should make this visible, not hide it in advanced rules.

### 9a. Time-window determinism, audit, and caching

Time-window routing makes routing context time-sensitive.

That means the platform should treat:

- `routing context`
- `evaluated_at`
- `active calendar or time-window row`

as part of the decision record.

Implications:

- the same business context may route differently at 17:59 and 18:01
- any future caching must include evaluated time or time-window identity
- audit traces should show which time-window rule was active when the decision was made

The simulator should let admins test the same ticket context at different timestamps.

## 10. Put routing policies on the config engine

The platform already has a versioned config engine via `config_entities` and `config_versions`.

New routing-studio policies should use that lifecycle rather than inventing bespoke draft/publish tables.

Recommended config-entity types:

- `case_owner_policy`
- `child_dispatch_policy`
- `visibility_policy`
- `domain_registry`

Request types should reference published policies, not embed every behavior as direct mutable columns forever.

This gives:

- draft
- publish
- diff
- rollback
- audit

without a parallel configuration system.

## Workflow Models

These are **starter patterns**, not implementation specification. They illustrate how the three-axis model (ownership / dispatch / visibility) plays out in real workflows. Candidate to move into a separate `docs/starter-routing-patterns.md` once the program kicks off — kept here for now so reviewers see the model in action alongside the design.

## IT

### Typical pattern

- Parent ownership:
  - `IT Service Desk Amsterdam`, `IT Service Desk France`, or `IT Service Desk EMEA` depending on scope
- Child dispatch:
  - local field support team
  - specialist team
  - device repair vendor
- Visibility:
  - IT Service Desk sees all IT parent cases
  - local IT teams see relevant children
  - vendors only see vendor-assigned children

### When no child is needed

Simple requests such as password reset or mailbox access can stay parent-only:

- parent owner resolves directly
- no work order created

### When a child is needed

Hardware issue:

- parent case -> IT Service Desk
- child work order -> by asset or location
- vendor child -> only if repair leaves internal team

After-hours example:

- parent case during NL business hours -> `IT Service Desk Amsterdam`
- same case after hours -> `IT On-Call EMEA`
- child work order -> local field engineer next business day or emergency vendor if severity requires

## FM

### Typical pattern

- Parent ownership:
  - `FM Coordination Amsterdam`, `FM Coordination France`, or regional FM coordination depending on scope
- Child dispatch:
  - by building, floor, or location group
  - fall back from specific domain to broader FM domain
  - external contractor where needed
- Visibility:
  - FM coordination sees all FM parent cases
  - regional/site FM teams see relevant children
  - vendors see their assigned work orders only

### Example

Broken door:

- parent case -> FM Coordination
- child work order -> local building engineer if covered
- fallback -> FM shared regional team
- fallback -> contractor if configured for that site/domain

Multi-site example:

- one parent case for "fire door inspection across 3 buildings"
- three child work orders, one per building or vendor package

## Catering

### Typical pattern

- Parent ownership:
  - `Service Desk Amsterdam`, `Service Desk France`, or `Catering Operations` depending on local operating model
- Child dispatch:
  - site kitchen team
  - venue operations team
  - catering vendor
- Visibility:
  - Service Desk can retain visibility across all catering cases
  - Catering Ops sees all catering execution
  - vendor sees only their child work orders

### Important point

Service Desk visibility on catering tickets does not mean Service Desk should be the executor.

Recommended pattern:

- parent case owned by Service Desk or Catering Ops
- execution child dispatched to kitchen/site/vendor

Multi-location event example:

- parent case -> `Service Desk France` or `Catering Operations France`
- child 1 -> Paris venue catering team
- child 2 -> Lyon venue catering team
- optional child 3 -> external supplier for equipment

## External vendors

### Typical pattern

- Parent ownership:
  - always internal
- Child dispatch:
  - one child per vendor task
- Visibility:
  - internal coordinator sees parent and all children
  - vendor sees only their own children

### Rules

- do not assign parent case directly to vendor except for deliberate edge cases
- child work order should carry:
  - vendor assignee
  - vendor-facing SLA
  - execution notes
  - external interaction mode as needed

## Phased Delivery Plan

## Phase 1: Align the product model

- rename the experience from low-level config pages to one `Routing Studio`
- remove or hide misleading fields that do not affect runtime behavior
- document the three-axis model:
  - case ownership
  - child dispatch
  - visibility
- move `routing rules` under `Advanced Overrides`

### Phase 1 field cleanup list

Concrete cleanup targets:

- remove or hide the request-type `Linked Routing Rule (override)` UI until there is real request-type-scoped runtime behavior
- stop showing `routing_rule_id` on the request-types list until it maps to real behavior
- move approval fields out of the routing-focused area of the request-type editor:
  - `approval_approver_team_id`
  - `approval_approver_person_id`
- either expose user-target rules intentionally in admin or de-emphasize `routing_rules.action_assign_user_id` until the UI supports it
- replace raw `asset_type_filter` text entry with a real asset-type selector
- add missing editors for runtime-supported fields instead of leaving them backend-only:
  - request type `default_vendor_id`
  - asset type default team/vendor
  - per-asset override team/vendor

## Phase 2: Fix logic and data consistency

- add a controlled domain registry
- add strict validation for rules and assignee targets
- expose asset type defaults and asset overrides properly
- enforce stronger database constraints for single-target rows

## Phase 3: Build the simulator and coverage views

- add preview endpoints for parent ownership and child dispatch
- add a UI simulator with full trace
- add coverage dashboards and warnings

## Phase 4: Improve operational automation

- add dispatch templates per request type
- support multi-child patterns cleanly
- show parent/child/visibility effects in one place before publishing changes

## Phase 5: Add rollout safety

- use config-engine draft/publish lifecycle for routing policies
- change audit and diff
- impact preview before publish
- rollback support

## Full Program Implementation Plan

This section is the recommended delivery model if the team wants the full routing-studio redesign rather than a narrow first slice.

## Program Assumptions

- multiple agents can work in parallel
- one integration owner owns architecture decisions, contracts, and merge order
- no big-bang rewrite of live routing behavior
- compatibility with existing request types and routing data is required during migration

## Architecture Contracts

These contracts should be written and frozen before parallel implementation starts.

### Contract 1. Intake scoping

Purpose:

- normalize scope before any owner or executor routing runs

Inputs:

- request type
- requester context
- selected location
- asset context
- business unit / legal entity context
- evaluation timestamp

Outputs:

- normalized routing context
- scope source used
- resolved operational scope ids
- evaluated timestamp and active support window identifier if applicable

### Contract 2. Case ownership engine

Purpose:

- choose the parent case owner from a published `case_owner_policy`
- implemented by reusing the shared single-target assignment resolver, not by building a second resolver

Inputs:

- normalized routing context
- published case owner policy

Outputs:

- chosen owner target
- trace
- matched policy row id

### Contract 3. Split / orchestration engine

Purpose:

- decide whether to create zero, one, or many child work orders
- decide the scope of each child

Inputs:

- parent case
- published child dispatch policy
- normalized routing context

Outputs:

- child plans
- one row per child:
  - derived scope
  - title / template hint
  - execution routing context
  - visibility implications

### Contract 4. Assignment resolver

Purpose:

- choose one assignee for one concrete child or parent routing context

Inputs:

- normalized execution context
- published dispatch policy
- time-window context if applicable

Outputs:

- chosen target
- trace
- matched rule / fallback data

Implementation note:

- Contract 2 should call this shared resolver with a `case_owner_policy`
- child execution should call this shared resolver with a `child_dispatch_policy`
- there should be one reusable single-target resolution engine

### Contract 5. Visibility integration

Purpose:

- determine which desks, teams, roles, and vendors can see the case and children
- keep one source of truth with the existing visibility runtime

Inputs:

- ticket kind
- owner / executor assignments
- existing role / assignment visibility inputs
- scope and region context

Outputs:

- visibility grants / effective policy explanation

Source of truth decision:

- operator visibility remains grounded in:
  - `user_role_assignments.domain_scope`
  - `user_role_assignments.location_scope`
  - `roles.permissions`
- routing-owned visibility should be limited to routing-specific inheritance flags such as:
  - parent owner can see spawned children
  - vendor child visibility mode

The Routing Studio `Visibility` tab should therefore be:

- a projection/editor over existing role-scope visibility
- plus a small number of routing-owned inheritance settings

It should not introduce a second independent visibility runtime.

### Contract 6. Policy storage and lifecycle

Purpose:

- store all new routing policies on the config engine

Recommended config types:

- `case_owner_policy`
- `child_dispatch_policy`
- `domain_registry`

### Contract 7. Routing Map, simulator, and coverage API

Purpose:

- provide one stable read surface for the routing studio
- powers both `Routing Map` (matrix landing) and `Explain / Simulator`

Outputs should include:

- normalized scope source
- owner decision
- split decision
- child execution decisions
- visibility explanation
- warnings and coverage gaps

The `Routing Map` matrix and the `Simulator` are two lenses over the same contract: the map resolves it for every `(scope, domain)` cell in the tenant; the simulator resolves it for one user-specified context.

## Workstreams

## Workstream 0. Architecture and contract freeze

Deliverables (concrete artifacts below the Workstreams list — see "Workstream 0 Artifacts"):

- Artifact A: code-ready TypeScript types + SQL for all seven contracts
- Artifact B: operational-scope hierarchy decision (build on existing `spaces` tree)
- Artifact C: Routing Map naming + migration of existing `feat/routing-studio` tabs
- Artifact D: domain-registry migration runbook (9 steps)
- Artifact E: dual-run hook point + feature-flag strategy (`routing_v2_mode` per tenant)
- terminology freeze and architecture decision record built on top of A–E

This workstream blocks all others conceptually. Prose contracts alone will not prevent drift across seven agents — the artifacts below must merge before A/B/C/D/E/F work starts.

## Workstream A. Config model and schema foundation

Deliverables:

- config-engine-backed routing policy entities
- policy definition schemas
- domain registry model
- request-type references to published policy entities

Notes:

- this workstream should not reinvent draft/publish
- it should use `config_entities` and `config_versions`

## Workstream B. Intake scoping and case ownership

Deliverables:

- intake scoping service
- scope-source resolution logic
- case ownership engine
- case-owner trace format

Notes:

- this is where `Service Desk Amsterdam` vs `Service Desk France` becomes deterministic
- approval timing should be handled explicitly at this layer, not mixed into dispatch

## Workstream C. Split / orchestration engine

Deliverables:

- split policy runtime
- child plan generation
- dispatch template handling
- integration with `DispatchService` and workflow-created children

Notes:

- this engine decides `how many children`
- it does not decide the final assignee target itself

## Workstream D. Resolver extensions

Deliverables:

- time-window-aware routing support
- domain-registry integration
- stricter rule validation
- explicit support for normalized intake scope

Notes:

- the resolver should stay a single-target decision engine
- it should be reusable for parent ownership and child execution contexts

## Workstream E. Routing Studio UI

Deliverables:

- unified routing studio shell
- top-level sections matching the Recommended information architecture (matrix-first, not tab-forest):
  - `Routing Map` (primary landing; replaces the existing `Overview` and `Coverage` tabs from the `feat/routing-studio` branch — see Artifact C)
  - `Case Ownership`
  - `Child Dispatch`
  - `Visibility`
  - `Explain / Simulator`
  - `Advanced Overrides` (formerly `Rules`)
  - `Audit`
- replacement of fragmented routing admin entry points
- absorption of `Mappings`, `Groups`, and `Fallbacks` from the current branch into `Child Dispatch` as drawer/panel editors, not first-class tabs

Notes:

- the UI goal is simplification, not tab proliferation
- the existing branch already proves useful pieces, but the final studio should collapse scattered editors into a smaller number of task-oriented surfaces
- child dispatch UI should be split into:
  - `How many children?`
  - `What scope does each child get?`
  - `Where does each child go?`

## Workstream F. Simulator, coverage, and audit surfaces

Deliverables:

- routing simulator API
- routing simulator UI
- coverage warnings and matrices
- time-window-aware simulation
- split preview

Notes:

- this is the integration workstream that proves the model is understandable

## Workstream G. Migration and compatibility layer

Deliverables:

- legacy-to-policy mapping
- backfill scripts
- compatibility readers
- dual-run / compare tooling
- rollout switches

Notes:

- this is what makes the full program safe
- no old UI or old runtime should be removed until compatibility is proven

## Workstream H. Testing, rollout, and hardening

Deliverables:

- contract tests
- migration tests
- dual-run diff reports
- seeded scenario coverage
- operator UAT

## Dependency Graph

- Workstream 0 defines the contracts and naming. Everything else depends on it.
- Workstream A is the platform foundation for policy lifecycle and should begin immediately after Workstream 0.
- Workstream B and Workstream C can proceed in parallel after Workstream A has frozen policy shapes.
- Workstream D can proceed in parallel with B and C once normalized context and policy contracts are fixed.
- Workstream E can start shell/UI work after Workstream 0, but it should bind to live APIs after A/B/C/D stabilize.
- Workstream F depends on B/C/D contracts and should land after their response shapes are stable.
- Workstream G spans the entire program and should start early, not at the end.
- Workstream H is continuous, but final rollout depends on G.

## Migration Strategy

The migration should be additive first, then substitutive.

### Step 1. Freeze and inventory current routing behavior

- list all current admin entry points
- list all live routing fields
- map runtime-supported fields that have no UI
- identify dead or misleading fields

### Step 2. Introduce policy entities alongside legacy data

- create config-engine-backed policy entities
- do not remove existing request-type fields yet
- add adapters so request types can read from old fields or new policies

### Step 3. Backfill and map legacy configs

- migrate domains into the new domain registry
- map location teams, groups, and domain fallbacks into the new studio model
- derive initial case-owner and child-dispatch policies from current data

### Step 4. Dual-run without changing outcomes

- run old and new policy evaluation in parallel for preview and audit
- compare:
  - chosen owner
  - chosen executor
  - split count
  - visibility outcome where measurable
- capture diffs for manual review

### Step 5. Switch authoring first

- let admins edit the new policies in the routing studio
- keep legacy pages read-only or hidden behind compatibility mode

### Step 6. Switch runtime by policy type

- enable new case ownership runtime
- enable split/orchestration runtime
- enable extended resolver behavior
- retire legacy readers only after dual-run confidence is high

### Step 7. Remove obsolete UI and schema gradually

- remove dead request-type routing fields
- remove legacy routing pages as primary authoring surfaces
- keep audit history and compatibility reports

## Parallel-Agent Execution Model

Recommended lane ownership:

- Agent 1: config model, config-engine integration, domain registry
- Agent 2: intake scoping and case ownership runtime
- Agent 3: split / orchestration engine and dispatch integration
- Agent 4: resolver extensions, time-window logic, rule validation
- Agent 5: routing studio shell and policy editors
- Agent 6: simulator, coverage, and warning surfaces
- Agent 7: migration tooling, backfills, and dual-run comparison

Integration owner responsibilities:

- approve policy schemas
- freeze contract payloads
- control merge order for shared types
- arbitrate naming and precedence rules
- own seeded scenario test suite

## Workstream 0 Artifacts

These are the concrete deliverables Workstream 0 must produce **before** Workstreams A–H begin parallel work. Prose contracts alone will not prevent drift across seven agents; the artifacts below close the ambiguities we hit during plan review.

### Artifact A. Contract schemas (code-ready, not prose)

Types are illustrative (TypeScript/SQL) — the source of truth is a shared types package the integration owner merges first.

#### A.1 Intake scoping (Contract 1)

```ts
// Inputs
export interface IntakeContext {
  tenant_id: string;
  request_type_id: string;
  requester_person_id: string | null;
  selected_location_id: string | null;
  asset_id: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  evaluated_at: string; // ISO8601
}

// Outputs (feeds every downstream engine)
export interface NormalizedRoutingContext {
  tenant_id: string;
  request_type_id: string;
  domain_id: string;                  // registry id (see Artifact D)
  priority: IntakeContext['priority'];
  location_id: string | null;         // the one the intake layer picked
  asset_id: string | null;
  scope_source:
    | 'requester_home'
    | 'selected'
    | 'asset_location'
    | 'business_unit'
    | 'legal_entity'
    | 'manual';
  operational_scope_id: string | null; // resolved per Artifact B
  operational_scope_chain: string[];   // [self, parent, …] up to root
  evaluated_at: string;
  active_support_window_id: string | null;
}
```

#### A.2 Case ownership engine (Contract 2) — thin wrapper over the shared resolver

```ts
export interface CaseOwnerPolicyDefinition {
  // This is the `definition` JSON stored on config_versions for
  // config_type = 'case_owner_policy'.
  schema_version: 1;
  request_type_id: string;
  scope_source: NormalizedRoutingContext['scope_source'];
  rows: Array<{
    id: string;                              // stable UUID for trace
    match: {
      operational_scope_ids?: string[];      // any-of
      domain_ids?: string[];                 // any-of (usually 1)
      support_window_id?: string | null;     // business_hours / after_hours / ...
    };
    target: { kind: 'team'; team_id: string };
    ordering_hint: number;                   // most-specific first
  }>;
  default_target: { kind: 'team'; team_id: string };
}

export interface OwnerDecision {
  target: AssignmentTarget;
  matched_row_id: string | 'default';
  trace: TraceEntry[];                       // reuses existing TraceEntry shape
  evaluated_at: string;
}
```

#### A.3 Split / orchestration (Contract 3)

```ts
export interface ChildDispatchPolicyDefinition {
  schema_version: 1;
  request_type_id: string;

  // "How many children?"
  dispatch_mode: 'none' | 'optional' | 'always' | 'multi_template';

  // "What scope does each child get?"
  split_strategy:
    | 'single'
    | 'per_location'
    | 'per_asset'
    | 'per_vendor_service';

  // "Where does each child go?" — reuses Contract 4 with this as the policy
  execution_routing: 'fixed' | 'by_asset' | 'by_location' | 'by_asset_then_location' | 'workflow';
  fixed_target?: { kind: 'team' | 'vendor'; id: string };
  fallback_target?: { kind: 'team' | 'vendor'; id: string };
}

// Emitted in-memory; NOT persisted. Audit of the split lives in ticket_activities
// on the parent case (system_event: 'children_planned', { plan_ids, scopes }).
export interface ChildPlan {
  plan_id: string;
  derived_scope:
    | { kind: 'location'; location_id: string }
    | { kind: 'asset'; asset_id: string }
    | { kind: 'vendor_service'; vendor_id: string; service_area_id: string | null };
  title_hint: string;
  execution_context: NormalizedRoutingContext;
  visibility_hints: VisibilityHints;
}
```

#### A.4 Assignment resolver (Contract 4) — one engine, two callers

```ts
export type RoutingPolicy =
  | { kind: 'case_owner'; policy: CaseOwnerPolicyDefinition }
  | { kind: 'child_dispatch'; policy: ChildDispatchPolicyDefinition };

export interface ResolverInput {
  context: NormalizedRoutingContext;
  policy: RoutingPolicy;
  time_window?: { calendar_id: string; is_business_hours: boolean };
}

export interface ResolverOutput {
  target: AssignmentTarget | null;
  chosen_by:
    | 'policy_row'
    | 'policy_default'
    | 'asset_override'
    | 'asset_type_default'
    | 'location_team'
    | 'parent_location_team'
    | 'space_group_team'
    | 'domain_fallback'
    | 'rule'
    | 'unassigned';
  matched_row_id?: string;
  trace: TraceEntry[];
  evaluated_at: string;
  active_time_window_id?: string;
}
```

#### A.5 Visibility integration (Contract 5) — NO new runtime

```ts
// Routing-owned visibility flags only. Actual visibility checks still
// go through public.ticket_visibility_ids() + TicketVisibilityService.
export interface VisibilityHints {
  parent_owner_sees_children: boolean;          // default true
  vendor_children_visibility: 'vendor_only' | 'vendor_and_parent_owner';
  cross_location_overlays: string[];            // role_ids that get overlay visibility
}
```

#### A.6 Config storage (Contract 6) — config-engine types

```sql
-- No new tables for policy storage. Three new values for config_entities.config_type:
--   'case_owner_policy'
--   'child_dispatch_policy'
--   'domain_registry'
-- Payload lives in config_versions.definition (jsonb) per the TS interfaces above.

-- Reference from request_types (nullable during migration; required after v2_only):
alter table public.request_types
  add column if not exists case_owner_policy_entity_id  uuid references public.config_entities(id),
  add column if not exists child_dispatch_policy_entity_id uuid references public.config_entities(id);
```

#### A.7 Studio API (Contract 7)

```ts
// POST /admin/routing/studio/simulate
export interface SimulateRequest extends IntakeContext {
  simulate_as: 'parent_case' | 'child_work_order';
  override_time?: string;            // simulate at this ISO timestamp
  disabled_override_ids?: string[];  // the existing "disable a rule" UX
}
export interface SimulateResponse {
  intake: NormalizedRoutingContext;
  owner_decision: OwnerDecision;
  split_decision: { plans: ChildPlan[] };
  child_execution_decisions: Array<{ plan_id: string; resolver_output: ResolverOutput }>;
  visibility_explanation: string[];
  warnings: Array<{ code: string; severity: 'info' | 'warning' | 'error'; message: string }>;
  duration_ms: number;
}

// GET /admin/routing/studio/map
// Powers the Routing Map matrix. One call returns every (scope, domain) cell.
export interface MapQuery {
  scope_level?: 'country' | 'campus' | 'building' | 'location_group'; // Artifact B
  scope_root_id?: string;
  domain_ids?: string[];
}
export interface MapResponse {
  scopes: Array<{ id: string; name: string; level: string; path: string[]; depth: number }>;
  domains: Array<{ id: string; key: string; display_name: string }>;
  cells: Array<{
    scope_id: string;
    domain_id: string;
    owner_summary: { target_name: string | null; source: 'direct' | 'inherited' | 'default' };
    dispatch_summary: { mode: ChildDispatchPolicyDefinition['dispatch_mode']; split: ChildDispatchPolicyDefinition['split_strategy']; target_name: string | null };
    warnings: string[];
  }>;
  truncated: boolean;
}
```

### Artifact B. Operational-scope hierarchy — decision

**Decision: build on the existing `spaces` tree. Do not introduce a new `operational_scope` entity.**

- Rows in the `Routing Map` are `spaces` rows at a tenant-configured *level*.
- Add a `space_levels` config (new config-entity type `space_levels`, one per tenant):

```ts
export interface SpaceLevelsDefinition {
  schema_version: 1;
  // Depth (0 = root) -> label + whether this level is an "operational scope" eligible for routing.
  levels: Array<{
    depth: number;
    key: string;                // 'country' | 'campus' | 'building' | 'floor' | 'room' | custom
    display_name: string;
    is_operational_scope: boolean;
  }>;
}
```

- `NormalizedRoutingContext.operational_scope_id` resolves by walking up `spaces.parent_id` from the picked `location_id` until `is_operational_scope = true`.
- `MapQuery.scope_level` filters `spaces` to rows whose `depth` maps to a level with that key.
- Migration: seed `space_levels` for each existing tenant with a sensible default (`country`/`campus`/`building`/`floor`/`room`) based on current tree depths. Admins can relabel per tenant.

**Rationale:** zero new identity tables; the matrix renders off a single tree the app already has; admins still see "country/campus/building" in the UI.

### Artifact C. Naming decision — Routing Map replaces Overview and Coverage

**Decision:** the final Studio has **one matrix-first landing called `Routing Map`** that replaces both the current `Overview` tab and the current `Coverage` tab from `feat/routing-studio`.

Migration of existing C1–C10 Studio pieces:

| Current C1–C10 | Final Studio | Notes |
|---|---|---|
| `Overview` (4-axis map + checklist + vocabulary) | Folded into `Routing Map` empty-state + a help drawer | The checklist becomes an onboarding banner shown when the matrix is mostly empty; the vocabulary moves to a `?` help drawer. |
| `Simulator` | `Explain / Simulator` | Retained. Matrix cells get "Why this cell?" button that opens the Simulator pre-filled. |
| `Rules` | `Advanced Overrides` | Rename only. |
| `Coverage` | `Routing Map` | The matrix is promoted to landing; edit mode stays but expands per Artifact A.7. |
| `Mappings` | Drawer inside `Child Dispatch` | Not a top-level tab. |
| `Groups` | Drawer inside `Child Dispatch` | Not a top-level tab. |
| `Fallbacks` | Panel inside `Advanced Overrides` (or `Child Dispatch` — pick during Workstream E) | Not a top-level tab. |
| `Audit` | `Audit` | Retained; demoted from co-equal to "for explanation and trust" per §Audit. |

Top-level nav contracts to: **Routing Map · Case Ownership · Child Dispatch · Visibility · Explain · Advanced Overrides · Audit** (seven). No `Overview`, no `Coverage`, no `Mappings`, no `Groups`, no `Fallbacks` as first-class entries.

### Artifact D. Domain registry migration runbook

Concrete 9-step migration. Additive first, substitutive last.

1. **Create the registry table** (new migration):

   ```sql
   create table public.domains (
     id uuid primary key default gen_random_uuid(),
     tenant_id uuid not null references public.tenants(id),
     key text not null,                -- canonical machine key, lowercased
     display_name text not null,
     parent_domain_id uuid references public.domains(id),
     active boolean not null default true,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     unique (tenant_id, key)
   );
   create index idx_domains_tenant_parent on public.domains (tenant_id, parent_domain_id);
   alter table public.domains enable row level security;
   create policy "tenant_isolation" on public.domains
     using (tenant_id = public.current_tenant_id());
   ```

2. **Add nullable FK columns alongside free-text columns** (additive, safe to deploy):

   ```sql
   alter table public.request_types    add column if not exists domain_id uuid references public.domains(id);
   alter table public.location_teams   add column if not exists domain_id uuid references public.domains(id);
   alter table public.domain_parents   add column if not exists domain_id uuid references public.domains(id),
                                        add column if not exists parent_domain_id uuid references public.domains(id);
   ```

3. **Inventory distinct free-text values** (read-only; produces `domain_merge_report.csv` per tenant):

   ```sql
   select tenant_id, lower(trim(domain)) as normalized, array_agg(distinct domain) as raw_variants,
          count(*) as usage_count
   from (
     select tenant_id, domain from public.request_types    where domain is not null
     union all
     select tenant_id, domain from public.location_teams   where domain is not null
     union all
     select tenant_id, domain from public.domain_parents
     union all
     select tenant_id, parent_domain as domain from public.domain_parents
     union all
     -- routing_rules.conditions is jsonb; pull each `{field:"domain", value:"X"}`
     select tenant_id, (cond->>'value')::text as domain
     from public.routing_rules, lateral jsonb_array_elements(conditions) as cond
     where cond->>'field' = 'domain'
   ) all_uses
   group by 1,2
   order by 1,2;
   ```

   **Human review step.** Integration owner resolves ambiguities: merge `"IT"` and `"it"`; decide whether `"doors-security"` and `"doors"` are the same. Output: a canonical list of `(tenant_id, key, display_name, parent_key?)`.

4. **Seed `public.domains`** from the reviewed list (one migration per tenant or one big script — pick one strategy).

5. **Backfill FK columns** from free-text to `domain_id` using the canonical map. Keep free-text columns populated — dual-source for safety.

6. **Update the resolver** to prefer `domain_id` when present, fall back to free-text lookup otherwise. `feat/routing-studio` branch's resolver already normalizes to strings; this is a targeted change in `ResolverRepository.domainChain`.

7. **Migrate `routing_rules.conditions`**: a JSONB-in-place update that adds `value_domain_id` alongside the existing `value`. Keep both during dual-run.

8. **Dual-run verification** (Artifact E). For every `routing_decisions` row produced during dual-run, compare `chosen_by` and `target` between legacy-text and v2-registry paths. Log diffs. Green criteria: < 0.1% diff rate over 7 days per tenant.

9. **Cutover and cleanup:**
   - Make `request_types.domain_id` NOT NULL.
   - Drop `location_teams.domain`, `domain_parents.domain`, `.parent_domain` free-text columns.
   - Rewrite `routing_rules.conditions` to drop `value` in favor of `value_domain_id`.
   - Archive `domain_merge_report.csv` outputs.

### Artifact E. Dual-run hook point + feature-flag strategy

**Hook point.** Inside `TicketService.runPostCreateAutomation` (and the equivalent path on `DispatchService.dispatch`), wrap the existing resolver call in a `RoutingEvaluator` shim:

```ts
// apps/api/src/modules/routing/routing-evaluator.service.ts (new)
class RoutingEvaluator {
  async evaluateCaseOwner(ctx: ResolverContext): Promise<ResolverDecision> {
    const legacy = await this.legacyResolver.resolve(ctx);

    const mode = await this.flags.routingV2Mode(ctx.tenant_id);
    if (mode === 'off') return legacy;

    const v2 = await this.v2Engine.evaluateCaseOwner(ctx);
    await this.recordDualRunDiff(ctx, legacy, v2, mode);

    if (mode === 'dualrun') return legacy;
    if (mode === 'shadow')  return legacy; // v2 visible in logs only
    return v2; // mode === 'v2_only'
  }
}
```

- `legacy` is always computed; `v2` is computed when mode != `off`.
- Diffs are written to `routing_dualrun_logs` (new table; indexed by tenant + evaluated_at for reports).
- The ticket's routing outcome matches the mode: legacy up to `shadow`; v2 only in `v2_only`.

**Feature-flag schema.**

```sql
-- Tenant-level feature flags (extend the existing tenants table):
alter table public.tenants
  add column if not exists feature_flags jsonb not null default '{}'::jsonb;

-- Canonical key for this program:
--   feature_flags.routing_v2_mode in ('off', 'dualrun', 'shadow', 'v2_only')
-- Missing = 'off'.
```

**Progression per tenant:**

| Mode | Legacy runs | v2 runs | Ticket uses | Purpose |
|---|---|---|---|---|
| `off` | ✓ | — | legacy | default, no v2 load |
| `dualrun` | ✓ | ✓ | legacy | collect diffs, no behavior change |
| `shadow` | ✓ | ✓ | legacy | like dualrun, but ops team actively monitors v2 for a week |
| `v2_only` | — | ✓ | v2 | cutover; legacy readers can be retired for this tenant |

**Admin surface:** a tenant-admin-only settings screen (or an internal platform-admin screen) toggles the mode. Not exposed to end users.

**Rollback:** set mode back one step. `v2_only → shadow` is the emergency rollback path if v2 produces bad decisions; legacy resumes serving tickets without a deploy.

---

Artifacts A–E together are the freeze Workstream 0 must deliver. Once merged, the seven parallel agents can work against stable types without contract drift.

## Full-Program Definition of Done

The full program is done when:

- request types point to published routing policies on the config engine
- parent ownership, child split, and child execution are distinct runtime steps
- scope source is explicit and auditable
- time-window routing is deterministic, simulated, and recorded in audit
- visibility is editable as policy, not inferred from assignment
- admins can author and preview policies in one studio
- legacy routing pages are removed (not kept as read-only). Rationale: once the tenant is in `v2_only` mode per Artifact E, the legacy pages read from data that is no longer authoritative; keeping them as read-only creates two plausible sources of truth. Audit history of legacy configs lives in `config_versions`.

## Optional Early Slice

If the team wants an earlier internal ship before the full program lands, ship this narrower slice first:

1. UI cleanup
   - rename `Routing Rules` to `Advanced Overrides`
   - remove misleading request-type routing fields
2. Case Ownership v1
   - scoped ownership rows
   - explicit scope source
   - fallback owner
3. Child Dispatch v1
   - split the UI into:
     - how many children?
     - where does each child go?
   - keep execution routing on the existing resolver where possible
   - **Transitional-state note:** "how many children" is policy-backed from day one (new `child_dispatch_policy` on the config engine), while "where does each go" still reads existing `location_teams` / `routing_rules` / `domain_parents`. This is a deliberate asymmetry — it unblocks the split UX without waiting for Workstream D's resolver extensions. Full migration completes when Artifact E's `shadow` then `v2_only` modes flip on.
4. Simulator and coverage extensions
   - show scope source used
   - show whether the request would split
   - add ambiguous-scope and missing-split warnings

This cut has the largest admin-value gain without requiring the full end-state at once.

## Immediate Recommendations

These are the highest-priority changes to make first:

1. Remove dead or misleading routing fields from request type setup until they are fully implemented.
2. Reframe routing admin around `case ownership` and `child dispatch`.
3. Add a routing simulator before adding more rule power.
4. Make visibility a first-class admin concern instead of an implied side effect.
5. Put advanced rules behind an explicit expert mode.
6. Support hierarchical desk ownership by geography or operating scope, with explicit fallback.
7. Make scope source and split behavior explicit for each request type.
8. Support business-hours and after-hours ownership where relevant.

## Success Criteria

The redesign is successful when:

- an admin can configure a realistic request type without understanding internal tables
- most request types need no advanced rules
- vendor execution is handled on child work orders by default
- service desk visibility is preserved without making service desk the executor
- an admin can answer "where will this go and why?" from one screen
- routing mistakes are caught as warnings before they affect live tickets
