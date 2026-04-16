# Build Strategy — Phase the UI, Not the Architecture

## Core Principle

The data model, domain objects, backend services, and API surface are built for the **full specification** from day one. What gets phased is **which UI screens exist and which features are exposed to users**.

This prevents:
- Painful database migrations on live client data
- Objects redesigned after clients depend on the v1 shape
- API contracts that change and break integrations
- Features that feel "bolted on" because they were
- Business logic rewritten instead of extended
- Technical debt from month one

## Why This Matters

The spec describes a deeply interconnected system. A ticket has parent-child relationships, vendor interaction modes, SLA with pause/resume, tags, watchers, cost tracking, satisfaction ratings, workflow instances, and approval linkage. If Phase 1 builds a "simple ticket" without these fields, then Phase 2 requires:

- ALTER TABLE to add columns
- Backfill logic for existing data
- API version changes or backwards compatibility shims
- Frontend rewrites to accommodate new data shapes
- Broken assumptions in reporting, routing, and SLA logic

Instead: build the full ticket object on day one. The fields the UI doesn't expose yet are nullable and unused. When the UI catches up, it reads/writes fields that already exist. No migrations, no rewrites.

## What "Build Full Backend" Means

### Database schema — complete from day one

Every table, every column, every relationship defined in the spec (sections 9.x) is created in the initial schema. Fields that Phase 1 UI doesn't use are nullable. No table is "simplified" — the full structure exists.

This includes:
- Ticket with parent_ticket_id, interaction_mode, status_category, waiting_reason, tags, watchers, cost, satisfaction_rating
- Ticket Activity with visibility (internal/external/system) and metadata
- Workflow Definition with graph_definition JSON
- Workflow Instance with current_node_id, waiting_for, context JSON
- Approval with multi-step support (step_number, chain_id, parallel_group)
- Reservation with recurrence_rule, recurrence_series_id, linked_order_id
- Order, Order Line Item, Catalog Item with all fields including availability rules and asset pool linkage
- Asset with asset_role, assignment_type, assignment_start_at/end_at, linked_order_line_item_id
- Asset Assignment History
- Business Hours Calendar
- Service Catalog Category
- Maintenance Schedule
- All config engine tables (config_entities, config_versions)
- All notification, audit, and domain event tables

### Backend services — complete API surface

Every service and API endpoint defined by the spec is implemented, even if no UI calls it yet. This includes:

- Full ticket CRUD with parent-child relationship support
- Child task creation and parent status aggregation
- Workflow engine with graph execution, branching, condition evaluation, timer scheduling
- SLA engine with pause/resume, multiple timers, business hours calculation, breach detection
- Approval engine with single-step, sequential multi-step, and parallel multi-step
- Configuration engine with draft/publish/version/rollback lifecycle
- Order and catalog services with availability checking and fulfillment routing
- Asset services with pool availability, temporary assignment, return tracking
- Reservation services with recurring booking support
- Maintenance schedule service with auto-ticket generation
- Notification engine with template rendering and event-driven dispatch
- Routing engine with rule evaluation
- Real-time subscriptions for service desk events

### What this does NOT include

- UI screens beyond Phase 1 scope
- The React Flow visual workflow builder canvas (Phase 3 UI)
- Admin configuration UIs beyond what Phase 1 needs
- Integrations (HR sync, calendar, IWMS import)
- AI features (these are additive and don't affect the core data model)

## How Phases Work Under This Model

Each phase adds **UI surfaces** that expose backend capabilities that already exist:

```
Phase 1:  Backend (full) + Core UI screens
Phase 2:  + Workplace UI screens + AI assistant
Phase 3:  + Power admin UI + AI copilot
Phase 4:  + Enterprise features + Integrations
```

The backend is essentially "done" after Phase 1 (with minor additions for AI and integrations in later phases). All subsequent phases are primarily frontend work building screens on top of stable APIs.

## The Tradeoff

**More upfront backend work in Phase 1.** Building the full data model and service layer takes longer than building a "simplified" version. Estimate: 2-3 extra weeks of backend work.

**But zero rework in Phases 2-4.** Every new UI feature talks to an API that already exists, reads/writes fields that are already in the database, and follows business logic that's already implemented. Adding the "Create child task" button in Phase 2 is purely a frontend task — the API, validation, and parent aggregation logic are already built and tested.

**Net result:** Faster total delivery across all phases. Stable, trustworthy architecture from day one. No "v2 rewrite" surprises.
