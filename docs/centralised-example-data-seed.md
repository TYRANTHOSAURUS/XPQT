# centralised-example-data-seed

Implementation variant for the canonical local TSS demo seed.

> **Status as of 2026-04-28 — shipped.** §1 SQL-owned seed lives in migrations `00100` (reset), `00102` (foundation: roles/spaces/org-nodes/teams/people/vendors/asset-types), `00104` (catalog), `00105` (catalog enrichment), plus topic-specific seeds added later: `00133` (room-booking examples), `00149` (service-rule templates), `00172` (booking-services demo). §2 generator script ships at [`apps/api/scripts/centralised-example-data-seed.mjs`](../apps/api/scripts/centralised-example-data-seed.mjs) — see [`docs/seed-migration-chain-runbook.md`](./seed-migration-chain-runbook.md) for the operational flow. The §Non-Goals "no booking/parking demo data" line is now stale: room-booking and booking-services demo data both ship; visitor and KB demo data are still deferred.

## Source Of Truth

This plan implements the product brief captured in:

- [`docs/database-seed-plan.md`](./database-seed-plan.md)

It is intentionally concrete:

- exact files to create
- exact rollout order
- which old seeds stay
- which old seeds are superseded
- what belongs in SQL
- what belongs in a generator script

## Goal

Create one canonical **local demo tenant** for `Total Specific Services (TSS)` that feels like a real enterprise IWMS/FMIS environment:

- 500 realistic people
- 6 populated buildings across Amsterdam / Den Haag / Den Bosch
- realistic departments, org structure, managers, approvals, and on-behalf flows
- realistic request types, categories, coverage, audience, routing, vendors, workflows, SLAs
- realistic assets, rooms, and historical tickets
- fully working login accounts for the key personas

This is for **local development first**.

## Non-Goals

- No visitor demo data yet
- No booking/parking demo data yet if those flows are not ready
- No knowledge-base demo content yet
- No intentionally messy or broken data
- No remote/shared-environment rollout in the first pass

## Final Architecture

### 1. SQL owns deterministic structure

SQL migrations should seed the fixed, relational, reviewable parts:

- tenant identity
- spaces
- org nodes
- teams
- vendors
- asset types
- categories
- request types
- criteria sets
- coverage rules
- audience rules
- on-behalf rules
- form schemas / variants
- workflows
- SLAs
- routing / location-team data
- request-type scope overrides
- the fixed named people and public users

### 2. A local generator script owns auth users and bulk history

A script is required for the parts SQL is bad at:

- creating real Supabase Auth users with working passwords
- linking `auth_uid` into `public.users`
- generating the remaining people up to 500
- generating bulk assets and assignment history
- generating the 30 hand-crafted historical scenarios
- generating a few hundred realistic tickets with comments, approvals, workflow history, child tickets, and timers

### 3. Forward-only migrations, no history rewriting

Do **not** edit old seed migrations in place.

Use new migrations to:

- clear old default-tenant demo content
- rebuild the canonical local demo dataset cleanly

That keeps migration history sane and avoids replay drift.

## Current Seed Inventory Verdict

### Keep as bootstrap / baseline

- [`supabase/migrations/00020_seed_default_tenant.sql`](../supabase/migrations/00020_seed_default_tenant.sql)
- [`supabase/migrations/00034_seed_admin_ticket_permissions.sql`](../supabase/migrations/00034_seed_admin_ticket_permissions.sql)
- [`supabase/migrations/00041_seed_domain_registry.sql`](../supabase/migrations/00041_seed_domain_registry.sql)
- [`supabase/migrations/00054_seed_portal_scope_permissions.sql`](../supabase/migrations/00054_seed_portal_scope_permissions.sql)
- [`supabase/migrations/00081_seed_organisations_permission.sql`](../supabase/migrations/00081_seed_organisations_permission.sql)

### Keep as historical / feature-specific, but not part of the new canonical demo

- [`supabase/migrations/00042_seed_workflow_webhooks_demo.sql`](../supabase/migrations/00042_seed_workflow_webhooks_demo.sql)
- [`supabase/migrations/00045_seed_reclassify_test_workflows.sql`](../supabase/migrations/00045_seed_reclassify_test_workflows.sql)

### Supersede for the local demo tenant

These should remain in history, but their default-tenant demo content should be cleared and replaced by new forward migrations:

- [`supabase/migrations/00022_seed_catalog_demo.sql`](../supabase/migrations/00022_seed_catalog_demo.sql)
- [`supabase/migrations/00024_seed_vendor_demo.sql`](../supabase/migrations/00024_seed_vendor_demo.sql)
- [`supabase/migrations/00032_seed_form_schemas.sql`](../supabase/migrations/00032_seed_form_schemas.sql)

### Obsolete split-model seed

Historical only after the service-catalog collapse:

- [`supabase/migrations/00067_seed_service_catalog_permissions.sql`](../supabase/migrations/00067_seed_service_catalog_permissions.sql)
- [`supabase/migrations/00068_backfill_service_catalog.sql`](../supabase/migrations/00068_backfill_service_catalog.sql)

## Target Dataset

### Tenant

- tenant name: `Total Specific Services (TSS)`
- default local tenant id stays `00000000-0000-0000-0000-000000000001`
- language: English

### Locations

- Amsterdam:
  - 1 site with 2 buildings
  - 1 separate building
- Den Haag:
  - 2 separate buildings
- Den Bosch:
  - 1 separate building

All 6 buildings should feel populated and usable.

Space depth:

- site
- building
- floor
- room / meeting_room / common_area / storage_room / technical_room

No desk seeding in v1.

### People

- target: 500 persons
- mostly employee records
- small contractor/external subset
- some inactive historical people
- realistic Dutch/English office names
- real manager chains
- departments and org structure
- default portal location for everyone
- mixed extra location access
- org-driven audience scenarios

### Teams

Internal teams to seed:

- Central Service Desk, Amsterdam, 5 people
- Central IT, Den Bosch, 10 people
- Central HR, Amsterdam
- Local Facilities Amsterdam
- Local Facilities Den Haag
- Local Facilities Den Bosch

### Login Accounts

Seed fully working login accounts with password `test123`.

Required fixed accounts:

- `dev@prequest.nl` — Thomas Anderson, main admin
- `servicedesk.agent@prequest.nl`
- `servicedesk.admin@prequest.nl`
- `it.agent@prequest.nl`
- `it.admin@prequest.nl`
- `hr.agent@prequest.nl`
- `facilities.amsterdam@prequest.nl`
- `cleaning.vendor@prequest.nl`

Recommended extra helpful accounts:

- `employee.requester@prequest.nl`
- `manager.approver@prequest.nl`

Non-login people use `@tss-test.nl`.

### Vendors

- target: about 20 vendors
- mix of single-city and multi-city coverage
- mix of active and inactive historical vendors
- different contract / SLA shapes
- one cleaning vendor with login

Likely vendor areas:

- cleaning
- elevator maintenance
- HVAC
- plumbing
- electrical
- locksmith / access control
- office furniture
- printer / MPS
- hardware repair / swap
- telecom / network cabling
- AV support
- catering
- pest control
- waste / recycling
- fire safety / inspections

### Request Types

Target a realistic enterprise IWMS/FMIS + workplace-support catalog:

- around 40-55 active request types
- parent categories with strong discoverability
- strong bias toward IT and Facilities
- some services only offered at some locations
- no inactive request types in v1

Suggested top-level category shape:

- IT Support
- Access & Identity
- Workplace Services
- Cleaning
- Building Maintenance
- HR Services
- Catering & Events
- Finance & Admin

### Assets

Seed a richer asset model:

- personal assets:
  - laptops
  - monitors
  - docks
- shared assets:
  - printers
  - meeting room displays
  - AV equipment
- building assets:
  - HVAC units
  - elevators
  - electrical panels or related technical assets where useful

Also seed:

- inactive / retired assets
- asset assignment history

### History

Target one month of history:

- few hundred tickets total
- mostly IT and Facilities, but not only those
- about 90% resolved/closed/cancelled
- some open / in progress / waiting
- realistic comments / activities
- approvals
- workflow instances and events
- child tickets / work orders
- SLA timers / outcomes

Important split:

- 30 hand-crafted scenarios
- remaining bulk history generated deterministically

No file attachments in v1.

## File-By-File Rollout

## Phase 1: Reset Old Default-Tenant Demo Content

### Create: `supabase/migrations/00098_seed_demo_tss_reset.sql`

Purpose:

- clear old default-tenant demo data inserted by older demo seeds
- preserve or recreate Thomas Anderson cleanly
- leave non-default tenants untouched

Rules:

- operate only on tenant `00000000-0000-0000-0000-000000000001`
- delete in reverse dependency order
- keep the `persons` / `users` row for `dev@prequest.nl` if present
- if Thomas does not exist, create him in a later migration

Tables to clear for the default tenant include:

- `ticket_activities`
- `sla_timers`
- `approvals`
- `workflow_instance_events`
- `workflow_instances`
- `tickets`
- `asset_assignment_history`
- `assets`
- `request_type_scope_overrides`
- `request_type_on_behalf_rules`
- `request_type_form_variants`
- `request_type_audience_rules`
- `request_type_coverage_rules`
- `request_type_categories`
- `request_types`
- `service_catalog_categories`
- `menu_items`
- `catalog_menus`
- `vendor_service_areas`
- `vendors`
- `team_members`
- `teams`
- `org_node_location_grants`
- `person_org_memberships`
- `org_nodes`
- `persons` except Thomas
- `users` except Thomas
- demo `config_entities` / `config_versions` created only for old forms/workflows that are being replaced

This migration should also clear obsolete default-tenant rows left by:

- `00022`
- `00024`
- `00032`
- any split-model leftovers that still survive in active tables

## Phase 2: Seed Fixed TSS Structure

### Create: `supabase/migrations/00099_seed_demo_tss_foundation.sql`

Purpose:

- rename/rebrand the default tenant into TSS
- seed the fixed location, org, team, vendor, and baseline people skeleton

Content:

- update tenant name/slug/branding fields for the default tenant
- upsert Thomas Anderson person/user shell rows
- seed space tree:
  - Amsterdam site + 2 buildings
  - 1 separate Amsterdam building
  - 2 Den Haag buildings
  - 1 Den Bosch building
  - floors and practical rooms
  - meeting rooms with capacity/equipment
  - technical/common/support rooms
- seed business-hours calendars
- seed org nodes:
  - company root
  - departments
  - sub-departments where useful
- seed internal teams
- attach teams to org nodes where useful
- seed about 20 vendors
- seed vendor contacts as persons where useful
- seed asset types
- seed a small fixed set of named key people:
  - Thomas
  - all login personas
  - a few managers
  - a few high-value requesters/approvers

### Create: `supabase/migrations/00100_seed_demo_tss_catalog.sql`

Purpose:

- seed the active enterprise request-type catalog using the current request-type-native model

Content:

- service catalog categories
- request types
- `request_type_categories`
- request-type descriptions/icons/search keywords
- criteria sets for org/department/location-driven audience
- `request_type_audience_rules`
- `request_type_coverage_rules`
- `request_type_on_behalf_rules`
- request-type portal columns
- TSS-specific form schemas and `request_type_form_variants`

Important:

- do not seed old `service_items` model
- do not depend on split-model tables
- use the post-collapse request-type-native tables only

### Create: `supabase/migrations/00101_seed_demo_tss_fulfillment.sql`

Purpose:

- seed realistic workflows, SLAs, routing, and request-type overrides

Content:

- workflow definitions for the seeded request types
- SLA policies
- location teams / routing ownership
- domain parents if needed
- vendor service coverage
- request-type defaults on `request_types`
- `request_type_scope_overrides`
- any policy entities needed for case-owner / child-dispatch v2 paths

Design rule:

- the workflow stays mostly generic per request type
- regional child-task assignment happens via conditional workflow branches + routing / scope overrides
- do not create one copied workflow per location unless the process graph is materially different

### Create: `supabase/migrations/00102_seed_demo_tss_reference_assets.sql`

Purpose:

- seed the fixed room/building asset backbone and a small fixed set of named employee devices

Content:

- meeting-room AV assets
- printers
- building equipment
- a small fixed seed of personal assets for login personas
- a few retired/inactive assets

## Phase 3: Seed Hand-Crafted Historical Scenarios

### Create: `supabase/migrations/00103_seed_demo_tss_handcrafted_history.sql`

Purpose:

- seed the 30 hand-crafted tickets and their related operational history

Content:

- 30 carefully chosen ticket scenarios
- approvals
- workflow instances
- workflow events
- child tickets
- SLA timers
- ticket activities/comments

These scenarios should anchor the most important demos:

- new laptop / onboarding
- laptop broken / urgent replacement
- monitor request
- printer issue
- badge/access issue
- spill cleanup
- deep cleaning
- broken chair
- HVAC complaint
- plumbing issue
- elevator incident
- lighting issue
- meeting-room AV issue
- office move / workplace setup
- employment letter
- leave / HR approval
- expense / finance-via-service-desk flow
- catering or event-support flow if the current product supports it

Each of the 30 should be named, intentional, and reviewable in SQL.

## Phase 4: Generator Script For Auth, Bulk People, Assets, And History

### Create directory: `apps/api/scripts/demo-tenant/`

### Create: `apps/api/scripts/demo-tenant/seed-demo-tenant.mjs`

Purpose:

- local-only generator for everything too large or awkward for SQL migrations

Responsibilities:

1. Create/ensure local Supabase Auth users for all fixed login accounts
2. Link `public.users.auth_uid`
3. Generate the remaining people up to 500 total
4. Generate realistic org memberships and manager chains
5. Generate mixed location grants/default locations
6. Generate additional personal assets and assignment history
7. Generate bulk ticket history after the 30 SQL-crafted scenarios

Determinism requirements:

- fixed random seed constant, for example `tss-demo-v1`
- rerunning after `db:reset` should recreate the same dataset shape
- generated emails/names should be stable enough for debugging

### Create helper modules under `apps/api/scripts/demo-tenant/`

Recommended files:

- `constants.mjs`
- `fixed-accounts.mjs`
- `name-pools.mjs`
- `org-structure.mjs`
- `asset-generator.mjs`
- `history-generator.mjs`
- `handcrafted-ticket-refs.mjs`

These do not need to exist exactly like this, but the implementation should keep fixed definitions separate from generator logic.

### Why script instead of SQL here

- working logins require Supabase Auth users
- bulk history is easier to generate with deterministic code than giant SQL blocks
- comments, timestamps, approval outcomes, and child-ticket chains are easier to vary realistically in code

## Phase 5: Developer Commands

Current commands:

- `pnpm seed:centralised-example-data`
  - seeds the local demo tenant using the generator
  - auto-discovers local Supabase credentials via `supabase status -o env`
  - refuses remote seeding unless `ALLOW_REMOTE_DEMO_SEED=true`
- `pnpm db:reset:centralised-example-data`
  - runs `supabase db reset`
  - then runs the centralised example generator

## Phase 6: Verification

### Create: `supabase/tests/demo_tss_seed_smoke.test.sql`

Purpose:

- verify the canonical local demo dataset exists and is coherent after reset

Checks should include:

- TSS tenant exists at the default tenant id
- Thomas exists and is active
- expected number of buildings/sites exist
- org nodes exist
- teams exist
- request types exist
- every active request type has at least one coverage rule
- every active request type has a viable handler path via defaults/routing/override
- at least one scope override exists
- active and inactive vendors/assets/people are present as expected
- hand-crafted scenario tickets exist

### Manual smoke checklist

After `pnpm db:reset:demo:local`:

1. Log in as Thomas
2. Log in as service desk agent
3. Log in as IT agent
4. Log in as HR agent
5. Log in as local facilities agent
6. Log in as cleaning vendor
7. Submit one portal request as a normal employee
8. Verify category visibility differs by org/location
9. Open a seeded complex historical ticket and confirm:
   - child tickets exist
   - comments exist
   - approval history exists
   - workflow history exists

## Implementation Order

Build in this order:

1. `00098_seed_demo_tss_reset.sql`
2. `00099_seed_demo_tss_foundation.sql`
3. `00100_seed_demo_tss_catalog.sql`
4. `00101_seed_demo_tss_fulfillment.sql`
5. `00102_seed_demo_tss_reference_assets.sql`
6. `00103_seed_demo_tss_handcrafted_history.sql`
7. `apps/api/scripts/demo-tenant/*`
8. `package.json` script entries
9. `supabase/tests/demo_tss_seed_smoke.test.sql`

Do not start with the generator script. The SQL foundation has to exist first.

## Practical Rules During Implementation

- Keep the dataset **clean**, not chaotic.
- Use fixed UUIDs for core seeded entities that other seeds/scripts depend on.
- Use deterministic code for generated records.
- Do not build against removed legacy service-catalog tables.
- Preserve Thomas Anderson.
- Do not treat the seed as complete until both steps succeed:
  - `pnpm db:reset`
  - `pnpm seed:demo:local`

## Deliverable Definition

This work is done only when all of the following are true:

- a fresh local reset creates TSS
- key login accounts can sign in with `test123`
- the catalog feels enterprise-realistic
- routing and scope overrides are visibly exercised
- workflows and child tickets are richly represented
- the last month of history feels believable
- the smoke SQL test passes
