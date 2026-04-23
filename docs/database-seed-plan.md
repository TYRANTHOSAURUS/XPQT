# Database Seed Plan

## Purpose

Plan a clean seed-data strategy for this repo so local resets, new-tenant bootstrap, demo flows, and DB-level tests all use intentional data instead of ad hoc migrations and one-off fixtures.

This is a planning doc, not the implementation itself.

## Current State

The repo already seeds data, but the strategy is fragmented:

- Supabase schema and seed data both live in `supabase/migrations/`.
- Seed migrations are mostly idempotent SQL with fixed UUIDs and `on conflict do nothing`.
- A default development tenant is seeded in [`supabase/migrations/00020_seed_default_tenant.sql`](../supabase/migrations/00020_seed_default_tenant.sql).
- Demo catalog, vendors, forms, permissions, and similar bootstrap data are also seeded via migrations such as:
  - [`supabase/migrations/00022_seed_catalog_demo.sql`](../supabase/migrations/00022_seed_catalog_demo.sql)
  - [`supabase/migrations/00024_seed_vendor_demo.sql`](../supabase/migrations/00024_seed_vendor_demo.sql)
  - [`supabase/migrations/00032_seed_form_schemas.sql`](../supabase/migrations/00032_seed_form_schemas.sql)
- SQL test fixtures live separately under [`supabase/tests`](../supabase/tests) and are not migrations.
- The running app typically points at the remote Supabase project, so local `db:reset` validates SQL but does not affect the live dev environment. See [`CLAUDE.md`](../CLAUDE.md).

## Problem

Right now "seed data" means several different things:

- minimum bootstrap data required for the app to function
- default tenant demo data used in development
- default permission and config registry rows
- feature-specific example content
- SQL test fixtures

Those are not the same lifecycle, not the same risk level, and not necessarily the same audience. Treating them as one bucket makes maintenance messy.

## Target Outcome

We want a seed strategy with clear layers:

1. **Bootstrap seeds**
   Required baseline data the app expects to exist.
   Examples: default permissions, domain registry, baseline config entities, optional default tenant.

2. **Demo seeds**
   Rich example data used to make the product usable in local/dev/demo environments.
   Examples: request types, categories, spaces, teams, vendors, workflows, form schemas.

3. **Scenario seeds**
   Narrow feature-specific data used to validate complicated behaviors.
   Examples: routing scenarios, workflow branching scenarios, visitor or booking examples.

4. **Test fixtures**
   Isolated SQL or integration fixtures used only by tests.
   These should not be part of normal app bootstrap.

## Proposed Principles

### 1. Keep schema migrations and seed intent distinct

We should continue using SQL migrations for durable seed data that must exist after reset, but each seed migration should clearly be one of:

- bootstrap
- demo
- feature demo
- permission/config registry

The filename should make that obvious.

### 2. Do not invent a second seed system unless needed

The repo already uses migration-based seeding successfully. The first pass should standardize and clean that approach, not add a TypeScript seeder, a YAML layer, or a custom CLI unless there is a clear need.

### 3. Separate "must exist" from "nice to have"

The app should not depend on bulky demo seeds to function.

- Bootstrap seeds should be small, deterministic, and stable.
- Demo seeds can be larger and more opinionated.
- Tests should not depend on demo seeds unless explicitly marked as integration smoke.

### 4. Fixed UUIDs are acceptable for durable seeds

This repo already relies on stable UUIDs in seed migrations. That is fine for:

- default tenant
- default roles
- seed request types/categories/forms
- deterministic cross-table references

But each seeded object should have a documented reason to stay stable.

### 5. Tenant scope must be explicit

Every seed must clearly answer:

- is this global/shared registry data?
- is this seeded only for the default dev tenant?
- is this intended for every newly created tenant?

That distinction is currently blurred.

## Recommended Implementation Shape

### A. Seed taxonomy

Define four official seed classes:

- `bootstrap`
- `demo`
- `scenario`
- `test`

Only the first three belong in `supabase/migrations/`.
`test` stays under `supabase/tests/` or app test factories.

### B. Migration naming convention

Prefer explicit filenames such as:

- `00xxx_seed_bootstrap_<topic>.sql`
- `00xxx_seed_demo_<topic>.sql`
- `00xxx_seed_scenario_<topic>.sql`

This is mainly for maintainability; no runtime behavior depends on the name.

### C. Seed ownership model

Each seed migration should say at the top:

- why the seed exists
- which tenant(s) it targets
- whether it is safe/idempotent
- whether the seeded IDs are intentionally stable

### D. Seed manifest doc

Create a follow-up doc or table that inventories every existing seed migration and classifies it as:

- keep as bootstrap
- keep as demo
- move to scenario
- replace
- delete

That inventory should happen before more seed work is added.

### E. Verification path

Every seed change should be verified with:

1. `pnpm db:reset` locally
2. one smoke query or API/UI check proving the seeded data is actually visible
3. targeted SQL test or integration check when the seed underpins complex behavior

## Proposed Work Phases

### Phase 1: Inventory and classification

- List every current `*_seed_*.sql` migration.
- Classify each one as bootstrap, demo, or scenario.
- Identify hidden seeds that are not named as seeds but behave like seeds.
- Identify seeds that should become test fixtures instead.

### Phase 2: Define the baseline contract

- Decide the minimum data a fresh environment must always have.
- Decide whether the default tenant remains mandatory.
- Decide which permissions/config registries must always exist.
- Decide which feature seeds are optional demo content rather than baseline.

### Phase 3: Normalize existing seeds

- Rename or replace unclear seed migrations going forward.
- Consolidate duplicated seed intent.
- Remove legacy/superseded demo seeds that no longer match the product model.
- Add clear headers/comments to surviving seed files.

### Phase 4: Fill product gaps

- Add missing seed data for the current request-type/routing/workflow model.
- Make sure seed data reflects the live architecture rather than removed legacy models.
- Seed at least one coherent end-to-end tenant that exercises:
  - audience + coverage
  - routing + handler overrides
  - workflow + child dispatch
  - SLA behavior

### Phase 5: Harden tests and developer workflow

- Add SQL tests for DB-level functions that depend on seeded structures.
- Add a lightweight smoke checklist for feature slices that introduce new required seed data.
- Document when a feature needs:
  - migration seed
  - SQL test fixture
  - API integration fixture
  - none of the above

## Proposed Deliverables

- A classified inventory of current seed migrations
- A seed policy doc
- Cleaned/normalized seed migrations
- One coherent demo tenant dataset aligned with the current architecture
- Test-fixture guidance for SQL and app-level tests

## Initial Decisions I Recommend

Unless you want something different, I would start with these assumptions:

- Keep migration-based SQL seeds as the primary mechanism.
- Keep `supabase/tests` for destructive or isolated SQL fixtures.
- Keep one default dev tenant with stable UUIDs.
- Treat large demo content as demo-only, not required bootstrap.
- Stop adding seeds that target removed legacy models.

## Decisions Captured

The first implementation target is now defined enough to stop speaking in generic terms.

### Demo scope

- Plan for multiple seed profiles later, but build exactly one first.
- The first seed target is one local demo tenant only.
- It should be full and realistic, not a minimal bootstrap.
- It should feel lived in, with existing data in most business areas.
- It should cover only features that work now.
- Visitors are explicitly out for now.
- Parking is skipped for now.
- Knowledge content is skipped for now.

### Demo company

- Tenant/company name: `Total Specific Services (TSS)`
- Company type: corporate company with multiple departments across multiple locations in one country
- Language: English
- Geography:
  - Amsterdam: 3 buildings
  - Den Haag: 2 buildings
  - Den Bosch: 1 building
- Amsterdam layout: 1 site with 2 buildings, plus 1 separate building
- Den Haag and Den Bosch stay simple
- All 6 buildings should feel properly populated, not half-empty placeholders
- Space depth: building -> floor -> room
- No desks in the first seed
- Site/building names should be made up, but follow realistic enterprise naming:
  - some known by address
  - some known by code
  - some known by an internal/common name
- Room names should stay practical, not branded
- Rooms should include realistic room types, not just generic rooms
- Meeting rooms should be seeded as real meeting rooms with details such as capacity and equipment

### People model

- Around 500 employees total
- Small divergence between city populations, not one dominant city
- Employees should belong to departments and locations
- Department list can be chosen by implementation as long as it feels realistic for this company
- Manager relationships should exist
- Some employees should be hybrid across locations
- Some employees should be able to submit on behalf of others
- Include fake employees and fake activity so the app feels alive
- Employee names should feel like normal Dutch/English office names
- Include a realistic mix of regular employees and contractors/externals
- Contractors should be only a small part of the population
- Include some inactive employees as historical/background data
- Everyone should still have a default portal location
- Portal access should be mixed:
  - some employees only see/use their own location
  - some employees have multiple locations
  - request-type audience should also use org targeting, not just location

### Accounts

- Preserve `Thomas Anderson`
- Thomas is the main admin for the demo tenant
- Thomas email: `dev@prequest.nl`
- Add a few real login accounts for testing, not logins for all 500 employees
- Include at least:
  - one service desk account
  - one IT account
  - one HR account
  - one local vendor account
  - one extra admin from service desk
  - one extra admin from IT
- Final rule: seed 1 login account per internal team, plus 1 vendor login account
- Local facilities login: only 1, for an Amsterdam building on the Amsterdam site
- Vendor login should be for a cleaning vendor
- Use simple test credentials for seeded accounts for now
- Login-enabled demo accounts use `@prequest.nl`
- Non-login employees use `@tss-test.nl`
- Email addresses should make the role obvious
- Manually create the important people and generate the rest
- Login accounts must be fully working in the first implementation

### Org and operational model

- Central service desk team: 5 people
- Central service desk is based in Amsterdam
- Central IT team: 10 people
- Central IT is based in Den Bosch
- HR team exists and handles HR across all locations
- HR is central only and based in Amsterdam
- Finance-related requests stay under service desk, not a separate finance team
- Facilities cases go to central service desk first
- Facilities child tickets route to local internal execution teams or external vendors
- One internal local facilities execution team per city is enough
- IT uses both the central IT team and external vendors depending on the flow
- Vendors should be realistic and request-type-appropriate
- Every request type should have a viable internal or external child-ticket assignment path
- Vendor count should be fairly broad, not just a tiny handful
- Target roughly 20 vendors
- Some vendors can cover multiple cities where that is logical for the request type
- Vendors should have different contracts / SLA expectations where realistic
- Include some inactive vendors / historical contracts too

### Request types and availability

- Include many realistic enterprise areas
- Strong focus on IT and Facilities
- Some services should exist only in some locations
- Bookings/visitors are not to be seeded yet if the feature is not ready
- Exact request-type list can be chosen by implementation as long as it fits this company and current product capabilities
- Request-type structure should feel like a realistic enterprise IWMS/FMIS catalog with parent categories
- Request types/services should be active only in the first demo seed

### Assets and rooms

- Asset model should be richer, not just the bare minimum
- Include employee devices such as laptops and monitors assigned to specific employees
- Include shared devices/assets such as printers, meeting-room screens, and AV equipment tied to rooms or buildings
- Include maintenance/building assets such as HVAC units, elevators, and similar equipment where realistic
- Include some inactive / retired assets too

### Workflow and SLA expectations

- Workflows must be complex and realistic
- One workflow can stay mostly the same across locations, while child assignment differs regionally
- Conditional child-task assignment inside the workflow is desired
- Include approvals
- Approval mix should include both manager approvals and approvals by teams such as HR / service desk / IT where the flow warrants it
- Approval rights should be mixed:
  - many requests go through the employee's own manager
  - some assistants / HR / service desk staff can approve on behalf of groups
- Most work should follow normal office hours unless that is not logical
- Include business hours and SLA behavior that differ by team or vendor where realistic
- Include urgent/break-fix flows that can happen outside office hours when the scenario warrants it

### Historical data

- Seed one month of history
- Old data volume: a few hundred tickets
- Spread across all domains, but mostly IT and Facilities
- Around 90% finished
- Some cancelled/closed
- Some still open or in progress
- Historical tickets may reference inactive employees/vendors/assets where that makes the history more realistic
- Do not seed attachments/files for the old history
- Seed real-looking comments and activity logs
- Include approval history, including approved, rejected, and pending examples
- Last 30 tickets should be hand-made
- Those 30 should cover different request kinds, biased toward the important flows
- Generated historical tickets should mostly include workflows and child tickets, not just simple single-ticket cases
- Seed full workflow history where realistic: status changes, approvals, child-ticket creation, reassignment, and related events
- Best implementation approach:
  - fixed/core records in SQL
  - heavy realistic history via a small generator script

### Seed posture

- Everything can be rebuilt except `Thomas Anderson`
- This should become the canonical demo dataset for local development
- Data should feel realistic but mostly clean, not intentionally messy

## Next Step

This doc now has enough product input to be turned into a concrete implementation plan with:

- exact migration strategy
- naming rules
- keep/delete list for current seeds
- first batch of files to create or rewrite
- verification checklist
