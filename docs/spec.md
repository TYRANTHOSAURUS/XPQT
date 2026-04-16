# Project Specification — Unified Workplace Operations Platform

## 1. Executive Summary

This project is a new-generation **Unified Workplace Operations Platform** for mid-size organizations (500–5,000 employees) across industries such as healthcare, universities, corporate offices, manufacturing, and government.

The platform replaces fragmented FMIS, ITSM, workplace booking, visitor, asset, and space tools with one integrated product that is:

- **Fast** and highly responsive
- **Reliable** and low-defect
- **Service-desk optimized** for heavy operational usage
- **Employee-friendly** with a simple, guided front door
- **Configurable but guided**, not a free-form low-code chaos engine
- **AI-assisted** for both end users and administrators
- **Multi-tenant at the product level** with **Supabase RLS isolation** (dedicated database as enterprise option)
- Built initially as a **modular monolith**

The product’s core promise is not “more features than everyone else,” but:

> A fast, reliable, AI-assisted workplace operations platform with an excellent service desk experience.

---

## 2. Strategic Product Positioning

### Core market

- Mid-size organizations (500–5,000 employees)
- Multiple locations/sites/buildings
- Need both local and global service operations
- Existing clients are mostly similar, with exceptions

### Product identity

This is not just an FMIS, and not just an ITSM.
It is a:

> **Unified Workplace Operations Platform**

The product combines:

- Facilities management processes
- IT service management processes
- Room and desk reservations
- Catering support
- Visitor management
- Asset management
- Space/location management
- Service desk operations
- Reporting and operational insights

### Differentiators

1. **Performance** — current market pain is slow systems
2. **Reliability** — fewer bugs and broken flows
3. **Superior service desk UX** — power-user productivity is central
4. **AI-assisted user journeys** — conversational guidance for intake and admin setup
5. **Unified operations model** — shared objects across FM, IT, workplace, and service workflows

---

## 3. Product Principles

### 3.1 Design principles

- **One platform, not many disconnected modules**
- **Shared core entities, domain apps on top**
- **Task-first UX, not module-first UX**
- **Flexible behavior, consistent experience**
- **Configuration over custom code**
- **Automation by default, manual override always possible where operationally needed**
- **AI assists, but never bypasses workflow, validation, or approvals**
- **Fast hot paths matter more than theoretical elegance**

### 3.2 Operational principles

- Service desk agents are heavy daily users and must be first-class citizens
- Global and local service structures must both be supported
- Routing must be explainable and correctable
- Approvals are a platform capability, not a feature bolt-on
- Reporting should be strong from the start, with an evolution path to analytics

### 3.3 Architecture principles

- Shared codebase
- Supabase RLS tenant isolation by default, dedicated database as enterprise option
- Modular monolith first
- Event-based observability and reporting readiness
- Workflow and approval engines as reusable platform capabilities

---

## 4. Tenant, Product, and Deployment Model

### 4.1 Chosen model

**Shared product, shared database by default, dedicated database as enterprise option**

This means:

- One product codebase
- One platform architecture
- Tenant-specific configuration
- Tenant-specific branding (logo and controlled theme colors)
- Tenant-specific workflows/forms/policies/integrations
- **Shared Supabase-managed PostgreSQL with row-level security** as the default
- **Dedicated database** available as an enterprise option for clients requiring physical data isolation
- Feature flags and release rings for controlled rollout

### 4.2 Why shared database with RLS as the default

**Team reality:** This platform is built by a 2-person team. Infrastructure complexity directly competes with product development. The default tenancy model must minimize operational overhead while maintaining strong isolation.

**Why Supabase RLS is safe for this product:**
- Row-level security is enforced at the PostgreSQL level — the database itself rejects unauthorized rows, regardless of what the application code does
- Unlike manual `WHERE tenant_id = ?` filtering, RLS policies cannot be accidentally forgotten in a query — they are always active
- Supabase's auth integration automatically sets the tenant context per request, which RLS policies reference
- One database means one migration pipeline, one backup, one monitoring target
- Supabase handles connection pooling (Supavisor), storage, auth, and realtime — reducing the infrastructure a 2-person team must manage

**Why not database-per-tenant as the default:**
- Managing N databases requires connection pool management (PgBouncer), cross-database migration runners, schema drift detection, and a provisioning pipeline — significant operational burden for a small team
- Most clients (mid-size organizations, 500–5,000 employees) do not require physical database isolation
- The operational cost is premature until client demand proves otherwise

### 4.3 Enterprise option: Dedicated database

Some clients — particularly in healthcare, government, and finance — may require physical data isolation for compliance or policy reasons. The platform supports this as an upgrade tier, not the default architecture.

**How it works:**
- A dedicated Supabase project (or self-managed PostgreSQL instance) is provisioned for the client
- The NestJS backend resolves the tenant and routes to the correct database connection via the tenant registry
- Same application code, same schema, same migrations — only the connection target changes
- The tenant registry stores the connection config, so moving a client between shared and dedicated is a configuration change, not a code change

**When to offer it:**
- Client contractually requires physical data isolation
- Regulatory/compliance framework mandates it
- Client data volume is large enough to cause noisy-neighbor concerns on the shared database

**Design rule:** All application code must work identically on both shared (RLS-isolated) and dedicated (physically isolated) databases. This means:
- Every table includes a `tenant_id` column, even on dedicated databases — the code is the same
- RLS policies are applied everywhere — on dedicated databases they filter on a single tenant (no-op in practice, but keeps the code path identical)
- No code branches based on tenancy model

### 4.4 Explicitly avoided

- Database-per-tenant as the default operating model for all clients (premature infrastructure complexity)
- Pure single-tenant product fragmentation with separate deployments per client
- Long-term per-client code forks
- Tenancy-model-aware application code (the app treats all tenants the same)

### 4.5 Release strategy and release rings

Not all clients want new features on the same day. The platform supports controlled rollout through two complementary mechanisms:

**Feature flags (primary mechanism):**
- New features launch behind a tenant-level feature flag
- Early-adopter tenants get the flag enabled first
- After a stability period (typically 2–4 weeks), the flag is enabled for remaining tenants
- Conservative clients remain on stable feature sets until they explicitly opt in or the feature is promoted to general availability
- Feature flags are stored in the tenant registry and evaluated at runtime

**Deployment rings (when needed for deeper isolation):**
- Two deployment tracks: `stable` and `canary`
- Most tenants point to the `stable` track
- Willing tenants opt into `canary`, receiving releases 1–2 weeks earlier
- The tenant registry records which ring each tenant is on
- Both rings share the same database(s) — rings control application version, not data isolation

**Why this works for conservative clients:**
A corporation that wants to "wait until the majority has tested it" stays on the `stable` ring with conservative feature flags. They receive proven, battle-tested releases without managing their own version or deployment. No per-client version forks, no parallel codebases.

### 4.6 Tenant resolution

Every request must resolve to a tenant before touching business logic.

**Primary method:** Subdomain-based resolution (`acme.platform.com` → tenant "acme"). This provides natural isolation at the DNS/TLS level, clean cookie scoping, and makes the platform feel like the client's own system.

**Secondary method:** Header-based resolution (`X-Tenant-Id`) for API consumers and inter-service communication.

Tenant resolution happens in a global NestJS middleware, early in the request lifecycle. The resolved tenant context is stored in `AsyncLocalStorage` so any service in the request chain can access it without explicit parameter passing or `REQUEST`-scoped injection (which would degrade performance). Supabase Auth JWT claims carry the tenant identifier, which the middleware validates and uses to set the RLS context.

### 4.7 Tenant registry

The tenant registry is a platform-level table (outside RLS scope) that stores:

- Tenant id, name, slug, status
- Database connection config (shared by default, dedicated if upgraded)
- Feature flags
- Release ring assignment
- Tier (standard / enterprise)
- Branding configuration
- Time zone and locale defaults
- Created/updated timestamps

This table is small, heavily cached, and rarely written to. It drives tenant resolution, feature gating, and connection routing.

### 4.8 Tenant provisioning

New tenant onboarding follows this sequence:

1. Create tenant record in the tenant registry
2. Run tenant-scoped seed data (default request types, workflow templates, roles, notification templates) within the shared database
3. Configure Supabase Auth for the tenant (identity provider settings, redirect URLs)
4. Mark tenant as active

For enterprise-tier clients requiring a dedicated database:

5. Provision a dedicated Supabase project or PostgreSQL instance
6. Run all migrations against the new database
7. Seed default data
8. Update the tenant registry with the dedicated connection config

### 4.9 Migration management

**Shared database (default):** Standard migration pipeline — one database, one migration run per deploy. Standard Supabase migration tooling applies.

**Dedicated databases (enterprise tier):** When dedicated databases exist, migrations must also be applied to each. This is managed as follows:
- Migrations run as a separate job after the shared database is migrated
- Migrations must be backwards-compatible — the app may serve requests while migration is in progress
- Schema version is tracked per tenant in the tenant registry
- Failed migrations on a dedicated database do not block other tenants — flag and alert

This complexity only exists for the small number of enterprise-tier clients with dedicated databases. The shared database path remains simple.

---

## 5. User Experience Strategy

### 5.1 Main UX model

**One unified front door from day one**

A combined employee experience portal where users can:

- Browse the **service catalog** to discover available services and submit requests
- Submit requests and incidents (guided by AI or traditional forms)
- Book rooms/desks (including recurring bookings)
- Invite visitors
- Request catering
- Find services, spaces, and assets
- Search across major workplace objects from one entry point
- Track their own items and tasks
- Rate their experience after ticket resolution

### 5.2 UX principle

One entry point does **not** mean one cluttered screen.
The UX must be layered and personalized.

### 5.3 Primary UX layers

#### A. Employee experience layer

For occasional or task-oriented users:

- Simple
- Guided
- Personalized
- AI-assisted
- Task-first

Examples:

- Book a room
- Report an issue
- Invite a visitor
- Order catering
- Check my requests

#### B. Service desk workspace

For heavy daily operational users:

- Fast
- Dense
- Keyboard-friendly
- Multi-tasking oriented
- Highly filterable
- Queue-centric

This is one of the most important areas in the product.

#### C. Admin/configuration workspace

For power admins and implementation teams:

- Safe configuration
- Draft/publish model
- Visual builders
- Audit/versioning
- Guided flexibility, not freeform system mutation

### 5.4 Mobile strategy

**Responsive web — mobile priority varies by surface**

The platform is not native-app-first, but mobile quality varies by context:

| Surface | Mobile Priority | Approach |
|---|---|---|
| **Employee portal** | High — many employees use phones as primary device | Mobile-first responsive design. Touch-optimized forms, large tap targets, minimal typing |
| **Approvals** | High — managers approve on the go | Mobile-optimized everywhere. One-tap approve/reject, clear context summary |
| **Field work** (FM technicians, security) | High — phone is the primary device in the field | Mobile-first. Photo upload, quick status updates, location-aware |
| **Visitor check-in** (reception) | Medium — tablet at front desk is common | Tablet-optimized. Clean check-in flow, badge printing trigger |
| **Room booking** | Medium-High — often done from phone during meetings | Simplified mobile booking flow, availability-first UI |
| **Service desk workspace** | Low — desktop is the primary tool | Desktop-first, dense layout. Mobile provides an **acceptable fallback**: simplified queue view, ability to view/update/reassign tickets, but not the full dense workspace. Agents checking urgent tickets from their phone should be able to act, not just read. |
| **Admin configuration** | Low — always done at a desk | Desktop-only is acceptable. No mobile optimization needed. |

---

## 6. Key Personas

### 6.1 Employee / End User

Uses the platform occasionally for:

- Tickets
- Requests
- Room booking
- Visitor invites
- Catering orders
- Tracking personal requests

### 6.2 Service Desk Agent

Heavy user. Works in ticket queues all day.
Needs:

- Fast list views
- Routing visibility
- Bulk actions
- Quick editing
- Context panels
- SLA awareness
- AI assistance for triage

### 6.3 Facility Manager / FM Operator

Needs:

- Facility request handling
- Building/site operational oversight
- Maintenance workflows
- Space, room, and issue visibility

### 6.4 IT Agent / IT Service Desk

Needs:

- Incident and service request management
- Assignment and escalation
- Asset linkage
- SLA and change workflows

### 6.5 Reception / Visitor Desk

Needs:

- Visitor check-in/out
- Host notifications
- Badge flow
- Walk-in and pre-registered visitor handling

### 6.6 Client Admin / Business Admin

Needs:

- Request type and form maintenance
- Workflow changes
- Policy/SLA setup
- User/role management
- Delegation/approval setup

### 6.7 Line Manager / Department Head

Approver and oversight role. Not a service desk user, but interacts with the platform regularly.
Needs:

- Visibility into their team's open requests and tickets
- Approval queues (often the first or second approver in a chain)
- Departmental reporting (ticket volume, resolution times, costs by department)
- Delegation of approvals when out of office

### 6.8 Operations Manager / Executive

Dashboard consumer. Rarely creates tickets, but uses the platform for operational intelligence.
Needs:

- SLA performance dashboards across sites and domains
- Ticket volume trends and resolution metrics
- Occupancy and reservation utilization reports
- Vendor performance visibility
- Exportable data for leadership reporting

### 6.9 Field Technician / Mobile Worker

Hands-on worker who physically visits locations to perform maintenance, repairs, or inspections.
Needs:

- Assigned task list on mobile
- Photo upload of completed work
- Quick status updates (arrived, in progress, completed)
- Location-aware task context (which building, which floor, which room)
- Offline-capable basic task viewing (future)

### 6.10 Catering Coordinator / Canteen Staff

Handles catering orders, manages the catering catalog, and coordinates delivery.
Needs:

- Incoming catering order queue (today's orders, upcoming orders)
- Delivery schedule with location and time
- Headcount and dietary requirement visibility
- Ability to confirm, adjust, or reject orders
- Fulfillment status updates (confirmed → preparing → delivered)

### 6.11 Implementation/Admin Team (internal)

Our team configures foundation setups, templates, and onboarding.
Clients share responsibility for ongoing tenant-level configuration.

---

## 7. Platform Capability Map

### 7.1 Core platform capabilities

- Identity and access
- Tenant management
- Location hierarchy
- Space management
- Asset management
- Unified service/ticket engine
- Service catalog
- Workflow engine
- Approval engine (including multi-step)
- Reservation engine (including recurring)
- Preventive maintenance scheduling
- Visitor management
- Forms/configuration engine
- Policy and SLA engine
- Business hours and calendar management
- Notifications
- Unified search
- Reporting and dashboards
- AI assist layer
- Integration framework

### 7.2 Domain apps built on platform capabilities

- Facilities operations
- IT service management
- Workplace reservations
- Catering coordination
- Visitor management
- Asset operations
- Space operations
- Service desk workspace

---

## 8. Core Modules

### 8.1 Identity & Access Module

Responsibilities:

- User accounts
- Authentication via **Supabase Auth** — SSO/OIDC/SAML for enterprise employees, email/password for non-SSO users (contractors, vendor contacts)
- Per-tenant identity provider configuration (each tenant can use their own SSO provider)
- Session management and token lifecycle (handled by Supabase)
- Scoped authorization: roles combined with domain scope and location scope to determine access (e.g., "FM Agent" role + "Building A" location scope = can only see FM tickets for Building A — see section 30)
- Tenant context
- Admin scopes
- Delegation/substitution support

Key concepts:

- External employee identity via SSO/HR sync
- Internal management of non-employee operational people
- Distinction between **User** and **Person**

### 8.2 Tenant & Organization Module

Responsibilities:

- Tenant metadata
- Tenant settings
- Branding customization: tenant logo, primary/accent color palette, light/dark theme preference
- Email branding: tenant logo and colors applied to notification emails
- Feature entitlements
- Release ring configuration
- Tenant-level policies

### 8.3 Location & Space Module

Responsibilities:

- Sites
- Buildings
- Floors
- Rooms
- Desks
- Other reservable or managed spaces
- Space attributes and hierarchy

### 8.4 Asset Management Module

Responsibilities:

- Asset registry
- Assignment to users/spaces
- Asset lifecycle (procured → active → maintenance → retired → disposed)
- Asset relationships (asset belongs to space, asset assigned to person)
- Linkage to tickets and locations
- Asset assignment history (who had it, when, where)

**Asset roles (same object, different behavior based on type):**

| Role | Examples | Assignment | Bookable | Tracked |
|---|---|---|---|---|
| **Fixed/installed** | HVAC unit, mounted projector, fire extinguisher | Permanent → space | No | Yes |
| **Personal** | Laptop, company phone, badge | Long-term → person | No | Yes |
| **Pooled/loanable** | Portable beamer, conference phone, pool car, camera | Temporary → person/reservation | Yes (via catalog or direct) | Yes |
| **Consumable** | Notepads, pens, printer paper | N/A — consumed on delivery | No | No (catalog items, not assets) |

**Pooled asset behavior:**
- Pooled assets have an availability calendar (like rooms)
- When an employee orders a catalog item linked to a pooled asset type, the system checks availability and reserves a specific asset instance
- The asset is temporarily assigned for the duration of the reservation or order
- After use, the asset must be returned (check-in) — the assignment ends and the asset becomes available again
- If not returned on time, the system can trigger a reminder or escalation

**Connection to the order catalog:**
- Catalog items of type `equipment` can optionally link to an **asset pool** (a set of assets of that type available for lending)
- Non-linked catalog items (food, supplies, services) have no asset tracking — they are fulfilled and consumed
- Linked catalog items trigger asset reservation on order and asset return tracking after fulfillment

### 8.5 Unified Service/Ticket Engine

Responsibilities:

- Requests
- Incidents
- Tasks
- **Parent-child ticket relationships** — service desk agents can create child tasks under any ticket, each with independent assignment, status, and timeline
- Structured activity timeline (internal notes, external comments, system events)
- Attachments linked to activity items
- Status handling
- Parent ticket status aggregation from child tasks
- Assignment metadata
- SLA linkage (parent and child tasks may have independent SLAs)
- Approval linkage

This is the central operational engine of the platform.

**Linked task model:**

A ticket can have zero or more child tasks. Child tasks are full ticket objects — they have their own status, assignment, activity timeline, and SLA. The service desk agent creates and manages child tasks directly from the parent ticket view.

Child task interaction modes:

- **Internal** — assigned to an internal team or agent, handled within the platform
- **External** — assigned to an external vendor who does not use the platform. The service desk agent owns the task and logs all vendor communication (email, phone) as activity entries on the child task. The vendor never sees the platform.

Child task creation modes:

- **Manual** — service desk agent creates child tasks on the fly from the parent ticket, based on their judgment
- **Workflow-driven** — the workflow engine automatically creates child tasks when a ticket matches a configured request type. For example, an "Office Move" request type might auto-spawn tasks for IT, FM, Access Control, and Catering — each pre-routed to the correct team
- **None** — many tickets need no child tasks at all (e.g., information requests, simple incidents). The agent handles the parent ticket directly, resolves it, done. The parent-child model is entirely optional.

Parent ticket behavior (when child tasks exist):

- Parent ticket status reflects the aggregate state of its child tasks
- If any child task is in progress or waiting, the parent remains in progress
- If all child tasks are resolved, the parent ticket can be resolved
- The parent ticket's SLA tracks the end-to-end resolution time (employee-facing). Child tasks may have their own SLAs (e.g., vendor contract SLA)
- The employee (requester) sees the parent ticket and its status, but not the child tasks or internal vendor communication

### 8.6 Workflow Engine

Responsibilities:

- Workflow definitions
- States/transitions
- Conditions
- Approvals
- Escalations
- Timers
- Notifications
- Assignments
- Action execution

### 8.7 Approval Engine

Responsibilities:

- Approval requests
- Approver assignment
- Delegation/substitution
- Reminders/escalations
- Approval audit trail

### 8.8 Reservation Module

Responsibilities:

- Room booking
- Desk booking
- Reservation policies
- Availability checks
- Linked catering/service tasks

### 8.9 Ordering & Catalog Module

The platform provides a **unified order catalog** — a single browsable catalog of everything an employee can add to a reservation or request standalone. This includes catering, equipment, supplies, and services. The ordering experience is designed to feel like a consumer delivery app: browse categories, add items to a cart, see totals, confirm.

**Catalog categories (configurable per tenant):**

| Category | Examples | Fulfilled by |
|---|---|---|
| Food & Drinks | Coffee & tea service, lunch buffet, sandwich platter, fruit bowl, drinks package | Catering team / external caterer |
| Equipment | Extra beamer, flipchart, conference phone, wireless presenter, portable speaker | FM / AV team |
| Supplies | Notepads + pens, name badges, printed agendas, markers, sticky notes | FM / office supplies |
| Services | AV technician setup, custom room layout, photographer, event host support | FM / AV / external vendor |

**Core responsibilities:**

- **Catalog management** — tenant admins configure available items per category with name, description, price, unit (per person / per item / flat rate), lead time, and availability rules
- **Shopping cart experience** — employees browse the catalog, add items with quantities, see running totals, and submit as part of a reservation or as a standalone order
- **Dietary handling** — catering items support dietary tags (vegetarian, vegan, halal, kosher, gluten-free) and a free-text dietary notes field
- **Cost estimation** — real-time cost display as items are added, based on headcount and quantities
- **Approval triggering** — orders exceeding a configurable cost threshold trigger an approval workflow before confirmation
- **Fulfillment routing** — each catalog item category is linked to a responsible team. When an order is placed, the platform creates fulfillment tasks routed to the correct team per category. One order can spawn tasks for multiple teams (catering team gets the food items, FM gets the equipment request, AV gets the technician request)
- **Fulfillment tracking** — per-item status lifecycle: ordered → confirmed → preparing/in transit → delivered/set up → completed
- **Linked to reservation** — the primary flow. Employee books a room, then "adds to booking" from the catalog. The order is linked to the reservation (delivery location = the room, delivery time = reservation start time)
- **Standalone ordering** — employees can also place orders without a reservation (e.g., "team lunch in the canteen area Friday," "extra monitors for the project room")
- **Cancellation cascade** — if a reservation is cancelled, linked orders are flagged for cancellation and the responsible teams are notified
- **Catalog visibility rules** — items can be restricted by location (only at sites with a canteen), role (only for management), or department (only for R&D). The employee sees only items available to them at their selected location. This keeps the catalog clean and relevant per user.

### 8.10 Visitor Management Module

Responsibilities:

- Visitor pre-registration
- Walk-in handling
- Host notification
- Check-in/check-out
- Badge support
- Restricted access approvals (where applicable)

### 8.11 Configuration Engine

The configuration engine is a **unified platform capability** — a single framework for creating, versioning, publishing, and auditing all tenant-configurable entities. It is not a per-module feature; every configurable thing in the platform uses the same lifecycle.

**Core responsibilities:**

- Config entity registry (generic storage for any configurable type)
- Version management (draft → validate → publish, with full version history)
- Rollback to any previous published version
- Validation framework (delegates to type-specific validators before publish)
- Audit logging for all configuration changes
- Permission checks (who can configure what, per config type)

**Supported config types (each plugs into the framework):**

| Config Type | Editor | Complexity |
|---|---|---|
| Request type | Form: name, domain, linked form schema, workflow, SLA, routing rule | Simple |
| Form schema | Field list builder: add/remove/reorder fields, types, validation, conditional visibility | Medium |
| Workflow | React Flow visual builder (see section 14) | Complex |
| SLA policy | Form: response/resolution targets, business hours, pause conditions, escalation | Simple |
| Routing rule | Condition builder: if (domain + location + category) → assign to team | Medium |
| Notification template | Rich text editor with variable tokens + channel selection | Medium |
| Branding | Logo upload, color pickers, theme toggle, preview | Simple |
| Terminology | Key-value mapping (e.g., "Ticket" → "Work Order") | Simple |

**Architecture:**

Each config type provides three things to the framework:
1. A **JSON schema** defining the structure of its configuration payload
2. A **validator** (backend) that checks business rules before publish
3. An **editor component** (frontend) that renders the type-specific editing UI

The framework provides everything else: entity list view, draft/publish controls, version history, diff viewer, rollback, audit log, and the admin UI shell. This means adding a new configurable type requires only the three items above — the lifecycle infrastructure is shared.

**Data model:**

- `config_entities` — registry of all configurable items (id, tenant_id, config_type, slug, name, current_published_version_id, status)
- `config_versions` — version history per entity (id, entity_id, version_number, status, definition JSON, created_by, published_by, published_at)

The `definition` JSON is type-specific (a form schema looks different from an SLA policy), but the lifecycle is identical.

**Admin UI pattern:**

All config types share a common admin shell: entity list on the left, type-specific editor in the center, draft/publish bar and version history on the right. This gives admins a consistent experience regardless of what they're configuring.

### 8.11.1 Form Schema Builder

The form schema builder is the second most complex configuration editor after the workflow builder. It allows admins to define the intake forms attached to request types — the fields employees fill in when submitting a ticket, booking a room, or registering a visitor.

**Supported field types:**

| Category | Field Types |
|---|---|
| Text | Short text, long text (textarea), rich text |
| Numbers | Number, currency |
| Selection | Dropdown (single), multi-select, radio buttons, checkbox |
| Date/Time | Date, date-time, time |
| File | File upload (single), file upload (multiple) |
| Entity pickers | Person picker, location picker (site/building/floor/room), asset picker, team picker |
| System | Read-only (system-populated), hidden (used for routing/workflow context) |

**Field configuration per field:**

- Label and help text
- Placeholder text
- Required / optional
- Default value (static or context-derived, e.g., requester's building)
- Validation rules (min/max length, min/max value, regex pattern, file type/size restrictions)
- Conditional visibility (show this field only when another field has a specific value)
- Conditional required (required only when a condition is met)
- Field width (full-width or half-width, for form layout)

**Form-level features:**

- Drag-and-drop field reordering
- Sections / field groups with collapsible headers (for organizing complex forms)
- Live form preview (see what the employee will see while editing the schema)
- Form-level validation rules (e.g., end date must be after start date)

**How forms connect to the platform:**

- Each **request type** links to one form schema (via the config engine)
- When an employee selects a request type, the corresponding form is rendered dynamically from the schema
- Submitted form data is stored as structured JSON on the ticket, with field values queryable for reporting and routing
- Entity picker fields (person, location, asset) resolve to platform objects — the form captures the ID, the ticket references the real entity
- Conditional visibility enables guided flows: selecting "IT" as department can reveal IT-specific fields while hiding FM-specific ones

### 8.12 Policy & SLA Module

Responsibilities:

- SLA definitions (response and resolution targets)
- Multiple SLA timers per ticket
- Pause/resume logic (e.g., waiting for requester, external dependency)
- Business hours and calendar configuration
- SLA breach detection
- Escalation thresholds and notifications
- Policy-driven SLA assignment
- Booking rules
- Approval rules
- Assignment policies
- Routing rules

### 8.13 Notification Module

Responsibilities:

- Event-based notification rules
- Email notifications
- In-app notifications
- Push-ready design for future
- Webhook-ready design for future channel expansion (Slack, Teams, etc.)
- Tenant-configurable notification templates
- User notification preferences
- Reminder and escalation notifications
- Group/team assignment notifications

### 8.14 Reporting Module

Responsibilities:

- Operational dashboards
- Exports
- KPI widgets
- Role-based dashboards
- Audit/report views

### 8.15 AI Assist Module

Responsibilities:

- Conversational intake
- Intent detection
- Form prefill
- Categorization/routing suggestions
- Admin configuration assistance
- Summarization and smart suggestions

### 8.16 Integration Module

Responsibilities:

- Identity sync
- HR sync
- Calendar integration
- SSO
- ERP/IWMS/BIM import/sync
- Access control integration
- Vendor/external API hooks

---

## 9. Canonical Domain Objects

### 9.1 Tenant

Represents a client organization using the platform.

**Fields (illustrative):**

- id
- name
- slug
- status
- branding settings
- feature flags
- release ring
- time zone defaults
- locale defaults
- created_at
- updated_at

### 9.2 User

Represents an authenticated platform account.

**Fields:**

- id
- tenant_id
- person_id
- email
- username
- auth_provider
- status
- last_login_at
- created_at
- updated_at

### 9.3 Person

Operational representation of a human actor.

Types may include:

- employee
- visitor
- contractor
- vendor_contact
- temporary worker

**Fields:**

- id
- tenant_id
- type
- first_name
- last_name
- email
- phone
- division (top-level organizational unit, e.g., "Operations", "Corporate Services")
- department (e.g., "Facilities", "IT", "Marketing")
- cost_center (optional — for chargeback reporting)
- manager_person_id
- external_source
- active
- created_at
- updated_at

### 9.4 Role

Represents authorization profile or capability bundle.

### 9.5 Team / Assignment Group

Used for routing and work ownership.

**Examples:**

- Global IT Service Desk
- Local FM Team — Building A
- Reception — HQ
- Vendor HVAC Team

**Fields:**

- id
- tenant_id
- name
- domain_scope
- location_scope
- active

Behavior notes:

- A team/assignment group may receive newly routed tickets, approvals, or tasks before an individual owner is selected
- Group assignment means the item is visible to eligible team members according to permission scope
- Notifications may be sent to all eligible team members when a new item enters the team queue
- One team member can then claim/pick up the item, after which individual ownership is recorded

### 9.6 Site / Building / Floor / Space

Hierarchy of physical locations.

**Space types may include:**

- room
- desk
- meeting room
- common area
- storage room
- technical room
- parking space

**Fields:**

- id
- tenant_id
- parent_id
- type
- code
- name
- capacity
- amenities (e.g., projector, whiteboard, video_conferencing, standing_desk, dual_monitor, wheelchair_accessible)
- attributes (additional metadata)
- reservable
- active

### 9.7 Asset

Represents a managed item — physical or potentially logical. Assets serve different roles depending on their type (see 8.4).

**Examples by role:**

| Role | Examples |
|---|---|
| Fixed/installed | HVAC unit, mounted projector, fire extinguisher, elevator, badge reader |
| Personal | Laptop, company phone, monitor, badge, access card |
| Pooled/loanable | Portable beamer, conference phone, pool car, camera, portable speaker |

**Fields:**

- id
- tenant_id
- asset_type_id
- asset_role (fixed / personal / pooled)
- name
- tag
- serial_number
- status (available / assigned / in_maintenance / retired / disposed)
- assigned_person_id (nullable — current person assignment)
- assigned_space_id (nullable — current space assignment, for fixed assets or storage location)
- assignment_type (permanent / temporary — permanent for fixed/personal, temporary for pooled)
- assignment_start_at (for temporary assignments — when was it checked out)
- assignment_end_at (for temporary assignments — when is it due back)
- linked_order_line_item_id (nullable — if currently checked out via an order)
- purchase_date
- lifecycle_state (procured / active / maintenance / retired / disposed)
- external_source_id
- created_at
- updated_at

### 9.7.1 Asset Assignment History

Tracks every assignment change for audit, reporting, and lifecycle visibility.

**Fields:**

- id
- asset_id
- tenant_id
- action (assigned / returned / transferred / retired)
- from_person_id (nullable)
- to_person_id (nullable)
- from_space_id (nullable)
- to_space_id (nullable)
- reason (e.g., "Order #123", "Onboarding", "Maintenance", "Offboarding")
- performed_by_user_id
- created_at

### 9.8 Ticket / Service Request

Unified service object across domains.

Types may include:

- incident
- request
- maintenance issue
- catering request
- access request
- service task

**Fields:**

- id
- tenant_id
- ticket_type_id
- parent_ticket_id (nullable — set when this is a child task)
- title
- description
- status
- status_category (new, assigned, in_progress, waiting, resolved, closed)
- waiting_reason (requester, vendor, approval, scheduled_work, other)
- interaction_mode (internal / external — external means vendor is off-platform, agent manages on their behalf)
- priority
- impact
- urgency
- requester_person_id
- location_id
- asset_id
- assigned_team_id
- assigned_user_id
- workflow_id
- sla_id
- source_channel
- tags (optional — free-form labels for ad-hoc grouping, e.g., "recurring-issue", "vendor-delayed")
- watchers (list of person_ids following this ticket without being assigned)
- cost (optional — for chargeback and cost reporting by department)
- satisfaction_rating (optional — post-resolution feedback score)
- satisfaction_comment (optional — post-resolution feedback text)
- created_at
- updated_at
- resolved_at
- closed_at

### 9.8.1 Ticket Activity

Represents a single timeline entry on a ticket.

Types may include:

- internal_note (agent-only)
- external_comment (visible to requester/end user)
- system_event (status change, assignment, SLA events)

**Fields:**

- id
- tenant_id
- ticket_id
- activity_type
- author_person_id (nullable for system events)
- visibility (internal / external / system)
- content (text or structured payload)
- attachments (optional, linked)
- metadata (e.g., status change details, assignment change details)
- created_at

### 9.9 Request Type / Ticket Type

Defines behavior of a ticket category.

**Fields:**

- id
- tenant_id
- name
- domain
- form_schema_id
- workflow_definition_id
- default_assignment_policy_id
- sla_policy_id
- active

### 9.9.1 Ticket Status Model

The platform uses a **standard structured ticket status model** as the baseline.

Core status categories:

- New
- Assigned
- In Progress
- Waiting (with reason codes)
- Resolved
- Closed

Design rules:

- Core status categories remain consistent across tenants
- Tenant-specific workflows may add controlled labels or behaviors around these core states
- Reporting, SLA logic, and queue behavior rely on the stable core status categories
- Waiting states may be refined by reason (e.g., waiting for requester, waiting for vendor)

Principle:
> Statuses may be configurable in presentation, but operational meaning must stay stable.

### 9.10 Workflow Definition

Metadata definition of process behavior. The graph_definition field stores the full workflow as a directed graph in JSON — nodes (with type and configuration) and edges (with optional conditions).

**Fields:**

- id
- tenant_id
- name
- entity_type
- version
- status (draft/published)
- graph_definition (JSON — nodes, edges, and per-node configuration as designed in the visual builder)
- created_by
- published_at

### 9.11 Workflow Instance

Runtime execution state of a workflow for a specific ticket.

**Fields:**

- id
- tenant_id
- workflow_definition_id
- workflow_version
- ticket_id
- current_node_id
- status (active / waiting / completed / failed)
- waiting_for (nullable — describes what the instance is paused on: approval, child tasks, timer, event)
- context (JSON — accumulated state and decisions made during execution)
- started_at
- completed_at

### 9.12 Approval

Represents an approval task.

**Fields:**

- id
- tenant_id
- target_entity_type
- target_entity_id
- approval_chain_id (nullable — groups steps in a multi-step approval)
- step_number (nullable — position in a sequential chain, e.g., 1, 2, 3)
- parallel_group (nullable — groups approvers that must all approve in parallel)
- approver_person_id or approver_group_id
- delegated_to_person_id
- status
- requested_at
- responded_at
- comments

### 9.13 Reservation

Represents booking of room/desk/space.

**Fields:**

- id
- tenant_id
- reservation_type
- space_id
- requester_person_id
- host_person_id
- start_at
- end_at
- attendee_count
- status
- recurrence_rule (nullable — for recurring bookings: weekly, biweekly, custom pattern)
- recurrence_series_id (nullable — groups recurring instances into a series for bulk operations)
- linked_order_id (nullable — the order containing all catering, equipment, supplies, and service items for this reservation)
- created_at
- updated_at

### 9.14 Visitor

Represents visitor entity and associated visit lifecycle.

**Fields:**

- id
- tenant_id
- person_id
- host_person_id
- visit_date
- site_id
- status
- badge_id
- pre_registered
- checked_in_at
- checked_out_at

### 9.15 Order

Represents a collection of items ordered by an employee — either linked to a reservation or standalone. An order is a "cart" that can contain items from multiple catalog categories (food, equipment, supplies, services).

**Fields:**

- id
- tenant_id
- requester_person_id
- linked_reservation_id (nullable — set when the order is part of a room booking)
- delivery_location_id (space reference)
- delivery_date
- delivery_time
- headcount (for per-person items)
- dietary_notes (free text for catering-specific requirements)
- total_estimated_cost
- status (draft / submitted / approved / confirmed / fulfilled / cancelled)
- approval_id (nullable — linked to approval if cost exceeds threshold)
- created_at
- updated_at

### 9.15.1 Order Line Item

Represents a single item in an order with its quantity and fulfillment status.

**Fields:**

- id
- order_id
- catalog_item_id
- quantity
- unit_price (captured at order time — catalog price may change later)
- line_total
- dietary_notes (per-line override for catering items, e.g., "2 of these vegetarian")
- fulfillment_status (ordered / confirmed / preparing / delivered / cancelled)
- fulfillment_team_id (team responsible for this line item — derived from catalog item category)
- fulfillment_notes

### 9.15.2 Catalog Item

Represents anything an employee can order — food, drinks, equipment, supplies, or services.

**Fields:**

- id
- tenant_id
- name (e.g., "Coffee & tea service", "Extra beamer", "Notepads + pens", "AV technician — 15min setup")
- description
- category (food_and_drinks / equipment / supplies / services)
- subcategory (e.g., within food_and_drinks: beverages, breakfast, lunch, snacks)
- price_per_unit (optional — for cost estimation, some items may be free/included)
- unit (per_person / per_item / flat_rate)
- minimum_quantity (optional)
- maximum_quantity (optional)
- lead_time_hours (minimum advance notice required)
- dietary_tags (for food items: vegetarian, vegan, halal, kosher, gluten-free, etc.)
- fulfillment_team_id (which team handles this item — catering team, FM team, AV team, etc.)
- image_url (optional — for visual catalog browsing)
- display_order
- active
- **Availability rules:**
- available_at_locations (nullable — list of site/building IDs where this item is available. Null = available everywhere. E.g., "Lunch buffet" only at sites with a canteen, "Extra beamer" only at buildings that have portable beamers)
- available_for_roles (nullable — list of roles or groups that can order this item. Null = available to everyone. E.g., "Photography service" only for Management, "Standing desk" only for employees with ergonomic approval)
- available_for_departments (nullable — list of departments. Null = all departments. E.g., "Lab equipment" only for R&D department)
- excluded_from_locations (nullable — blacklist approach if easier than whitelist)
- **Asset pool linkage (for loanable items):**
- linked_asset_type_id (nullable — if set, this catalog item represents a pooled asset. Ordering triggers availability check and temporary assignment from the asset pool of this type)
- requires_return (boolean — if true, the asset must be returned after use. Triggers return reminders and overdue tracking)

### 9.16 SLA Policy

Defines response/resolution targets and escalation behavior.

Includes:

- Response time targets
- Resolution time targets
- Business hours/calendar association
- Pause conditions (waiting states that stop the clock)
- Escalation thresholds
- Notification rules on breach or near-breach

### 9.17 Assignment Policy / Routing Rule

Defines rule-based routing behavior.

### 9.18 Notification

Represents a notification definition and/or delivery event.

Includes:

- notification_type
- target_channel (email, in_app)
- recipient_person_id or recipient_group_id
- template_id
- related_entity_type
- related_entity_id
- status
- sent_at
- read_at (for in-app where applicable)

### 9.19 Audit Event

Captures security/operational history.

### 9.20 Domain Event

Captures business transitions for reporting and analytics.

### 9.21 Business Hours Calendar

Defines working hours and non-working days for SLA calculations, timer behavior, and availability.

**Fields:**

- id
- tenant_id
- name (e.g., "Default Business Hours", "Amsterdam Office", "24/7 Support")
- time_zone
- working_hours (per day of week — e.g., Mon-Fri 08:00-17:00)
- holidays (list of dates with optional recurrence — e.g., Christmas, national holidays)
- active

A tenant may have multiple calendars (different sites, different support tiers). SLA policies and workflow timers reference a specific calendar. If no calendar is specified, the tenant's default calendar applies.

### 9.22 Service Catalog Category

Organizes request types into browsable categories for the employee portal. The service catalog is the employee-facing "storefront" — how employees discover what they can request.

**Fields:**

- id
- tenant_id
- name (e.g., "IT Support", "Facilities", "Workplace Services", "Access & Security")
- description
- icon
- display_order
- parent_category_id (nullable — supports one level of nesting)
- active

Each request type (9.9) links to one or more catalog categories. The employee portal renders the catalog as the primary navigation for submitting requests.

### 9.23 Maintenance Schedule

Defines a recurring maintenance plan that auto-generates tickets on a schedule. Used for preventive maintenance — the core of FM operations.

**Fields:**

- id
- tenant_id
- name (e.g., "Monthly HVAC filter change — Building A")
- description
- recurrence_rule (cron-like: daily, weekly, monthly, quarterly, annually, custom interval)
- next_occurrence_at
- ticket_template:
  - request_type_id
  - title
  - description
  - priority
  - assigned_team_id
  - location_id (optional)
  - asset_id (optional)
  - interaction_mode (internal / external)
- active
- created_by
- created_at

When `next_occurrence_at` arrives, the platform auto-creates a ticket from the template and advances the schedule to the next occurrence. The generated ticket is a normal ticket — it enters the queue, follows the workflow, and tracks SLA like any other.

---

## 10. Relationship Model

### 10.1 Key relationships

- Tenant has many Users, People, Teams, Spaces, Assets, Tickets, Reservations, Visitors, Maintenance Schedules
- User maps to one Person (optional for some system accounts)
- Ticket can reference Person, Space, Asset, Team, Workflow, SLA
- Ticket may have tags, watchers, cost, and satisfaction rating
- Reservation references Space and Person, and may spawn linked tickets/tasks
- Reservation may be recurring (linked to a recurrence rule)
- Visitor references host Person and site/space context
- Asset references Space or Person assignment and may link to tickets
- Request Type references Form Schema, Workflow Definition, SLA Policy, Routing Policy
- Request Type belongs to one or more Service Catalog Categories
- SLA Policy references a Business Hours Calendar
- Maintenance Schedule references a Request Type template and auto-generates tickets
- Approval references target entity and approver/delegation metadata

### 10.2 Architectural rule

Modules should not freely mutate each other’s tables. They should interact through explicit application services and domain interfaces.

---

## 11. Service Desk Operating Model

### 11.1 Central importance

The service desk is one of the largest and most frequent user groups in the platform. This means the ticket workspace, assignment, routing, and queue UX must be optimized first.

### 11.2 Required service desk capabilities

- Dense queue/list views
- Saved filters/views
- Bulk actions
- Inline editing
- Side-panel context views
- Fast ticket switching
- Assignment and escalation controls
- SLA visibility
- Activity history
- Attachment/comment handling
- Auditability
- AI suggestions (with agent confirmation)
- Team/group queue visibility with claim/pickup flow

### 11.3 Heavy-use UX requirements

- Fast loading and interaction
- Minimal full-page refreshes
- Keyboard efficiency
- Multi-select and bulk processing
- Real-time or near-real-time updates for assigned queues

---

## 12. Global vs Local Service Structures

### 12.1 Supported support models

The platform must support:

- Global service desk
- Local/site-specific service teams
- Hybrid structures

### 12.2 Examples

- Global IT desk across all sites
- Local FM teams per building/site
- Central oversight with local execution
- Vendor escalation for specific asset categories

### 12.3 Assignment scope model

Every ticket/request should be scorable or routable by:

- Tenant
- Domain/service type
- Location/site/building/space
- Team scope
- Policy/rule

### 12.4 Why this matters

Routing quality directly affects:

- SLA performance
- service desk efficiency
- user trust
- ticket bouncing/rework

---

## 13. Routing & Assignment Model

### 13.1 Chosen model

**Rule-based routing by default, with manual override**

### 13.2 Rule inputs

Routing rules may consider:

- Request type
- Category
- Domain (FM, IT, visitor, catering, etc.)
- Location/building/floor/room
- Asset type
- User department
- Priority
- Time window/business hours
- Tenant-specific business policies

### 13.3 Rule outcomes

- Assign to global team
- Assign to local team
- Assign to specific queue
- Route to reception/security/vendor
- Escalate after threshold
- Assign to team/group queue for later pickup by an eligible member

### 13.4 Manual override

Authorized users must be able to:

- Reassign ticket/team
- Escalate/de-escalate
- Correct misrouting
- Send to vendor
- Override with audit logging

### 13.5 Explainability requirement

Routing should be automatic, explainable, and correctable.

---

## 14. Workflow Engine Design

### 14.1 Chosen model

**Visual branching workflow builder** — a graph-based canvas where admins design workflows by placing and connecting nodes. Not a fully open low-code platform, but a real visual designer with conditional branching.

Built with **React Flow** on the frontend. Workflows are stored as directed graphs (JSON) and executed by a lightweight state machine engine in NestJS.

### 14.2 Visual builder

The builder provides a canvas where admins:

- Place nodes from a fixed palette of supported types
- Connect nodes with edges (including conditional branches)
- Configure each node via a properties panel (assignment targets, conditions, templates, timers)
- Preview the flow visually before publishing

The builder enforces structural validation:
- Every flow must start with a Trigger node and end with an End node
- Condition and Approval nodes must have all output branches connected
- No orphaned nodes or unreachable paths
- Circular references are blocked

### 14.3 V1 node types

The workflow engine launches with a constrained set of 10 node types, expandable over time:

| Node | Purpose | Outputs |
|---|---|---|
| **Trigger** | Entry point — fires on ticket creation, status change, or manual start | 1 (next step) |
| **Condition** | If/else branch based on ticket fields (priority, category, location, domain, custom fields) | 2+ (one per branch, plus default) |
| **Assign** | Assign ticket or task to a team or user | 1 |
| **Create child task(s)** | Spawn one or more child tasks with pre-configured title, assignment, interaction mode, and SLA | 1 |
| **Approval** | Request approval from a user or group, branch on outcome | 2 (approved / rejected) |
| **Wait for** | Pause until: all child tasks resolved, specific status reached, or external event | 1 |
| **Timer** | Wait for a duration or until a business-hours deadline, then continue | 1 (+ optional timeout branch) |
| **Notification** | Send email or in-app notification using a configurable template | 1 |
| **Update ticket** | Change status, priority, assignment, or other fields on the ticket | 1 |
| **End** | Terminate the workflow path | 0 |

**Explicitly deferred to future versions:**
- Loop / goto nodes
- Parallel execution (multiple paths running simultaneously)
- Sub-workflows (workflow calling another workflow)
- Custom code / script nodes
- External API call nodes (beyond simple webhook)

Each of these is a new node type addition, not a rewrite of the engine.

### 14.4 Execution engine

**V1: Lightweight state machine in NestJS**

Workflow definitions are stored as directed graphs (nodes + edges) in JSON. At runtime, each ticket with an active workflow has a **workflow instance** that tracks the current node and accumulated state.

Execution model:
- When a trigger fires, the engine creates a workflow instance at the trigger node and advances
- At each node, the engine executes the node's action (assign, notify, create tasks, etc.) and follows the outgoing edge
- At Condition nodes, the engine evaluates the condition and follows the matching branch
- At Wait/Approval/Timer nodes, the engine pauses the instance and records what it's waiting for
- When the wait condition is met (approval resolved, child tasks completed, timer elapsed), the engine resumes and advances to the next node
- The instance completes when it reaches an End node

Timer execution:
- Timer nodes register a scheduled job (via pg_cron or NestJS scheduled task)
- The job fires at the deadline and resumes the workflow instance
- Business hours calculations reference the tenant's calendar configuration

This model handles branching (if/else via Condition and Approval nodes) but not parallel execution (two branches active simultaneously). All execution is single-path — the workflow follows one branch at a time.

**Future: Temporal or equivalent durable workflow runtime**

When client needs exceed the state machine model — parallel paths, long-running orchestrations spanning weeks, complex retry/compensation, cross-system integration chains — the execution engine can be upgraded to Temporal. The workflow definition format (graph JSON) and the visual builder remain the same; only the execution backend changes.

### 14.5 Guardrails

- **Draft vs published** — workflows are edited in draft mode, published when ready
- **Versioning** — each publish creates a new version; in-flight instances continue on the version they started with
- **Validation before publish** — structural validation (connected graph, all branches handled, valid node configs) must pass before a workflow can be published
- **Impact preview** — show which request types use this workflow and how many active instances exist before publishing a new version
- **Audit history** — all publish, edit, and rollback actions are logged
- **Test mode** — ability to dry-run a workflow with sample data to verify the path before publishing (preferred, can be simplified for v1)

### 14.6 Explicit boundary

The workflow engine orchestrates platform primitives (assign, notify, create task, update status, approve). It does not:
- Execute arbitrary custom code
- Allow unrestricted scripting or expressions
- Make external API calls beyond simple webhooks (v1)
- Support unbounded loops or recursive flows

The node type palette is the control surface — expanding capabilities means adding validated, tested node types, not opening a scripting runtime.

---

## 15. Approval Engine Design

### 15.1 Chosen model

Approvals are a **broad platform capability**, with support for **delegation/substitutes**.

### 15.2 Approval use cases

- High-cost maintenance requests
- Access requests
- Visitor approvals
- Catering approvals
- Reservation exceptions
- IT changes and elevated service requests

### 15.3 Required features

- **Single-step approval** — one approver or group decides
- **Sequential multi-step approval** — approval chain where each step must complete before the next begins (e.g., Team Lead → Department Head → Finance)
- **Parallel multi-step approval** — multiple approvers must all approve independently before the workflow proceeds (e.g., both FM Manager and Security Manager must approve)
- Conditional approval triggering (based on ticket fields: cost threshold, category, location)
- Group or user approver support
- Delegation/substitute approvers
- Temporary delegation windows
- Out-of-office aware extension (future)
- Reminder and escalation support
- Audit trail
- Group/team approval notifications where work is initially assigned to a role/group before individual pickup

### 15.4 UX requirements

- Clear pending state
- Fast approval UI
- Mobile-friendly approval actions
- Visibility into who is blocking progress

---

## 16. Reservation & Workplace Experience Model

### 16.1 Reservation scope

Support:

- Room booking
- Desk booking
- **Recurring reservations** (e.g., "every Tuesday 10-11am for the next 12 weeks")
- Linked catering requests
- Reservation approvals where needed

### 16.2 Reservation capabilities

- Availability checking
- Capacity matching
- **Amenity/equipment filtering** (e.g., "room with video conferencing and whiteboard for 8 people")
- Policy enforcement
- Recurring booking management (create series, cancel single occurrence or entire series)
- **Linked order catalog** — employee adds items from the unified catalog (food, equipment, supplies, services) to a booking in a shopping-cart experience. Equipment items linked to asset pools trigger availability checks and temporary asset reservation.
- Reservation status lifecycle
- Calendar integration

**Combined booking flow:** An employee books a room and adds items from the order catalog in one flow. The platform creates: one reservation + one linked order with line items. Each line item is routed to the responsible team for fulfillment. Equipment items backed by pooled assets are reserved from the asset pool for the booking duration. The employee sees one combined "booking" — room, food, equipment, supplies, services — all in one view.

### 16.3 UX goals

- Fast search/find/book flow
- Intent-based assistance via AI
- Personalized suggestions
- Strong mobile usability

---

## 17. Visitor Management Model

### 17.1 Visitor use cases

- Pre-registered guests
- Walk-ins
- Host notification
- Check-in/check-out
- Badge handling
- Restricted flow approvals where needed

### 17.2 Operational considerations

- Reception-first UI
- Mobile/front-desk-friendly screens
- Host context
- Time and site awareness

---

## 18. Asset & Space Management Model

### 18.1 How spaces work across the platform

A space is one object that participates in multiple platform functions:

| Function | How the space is used |
|---|---|
| **Location hierarchy** (admin) | Spaces are organized as Site → Building → Floor → Room/Desk. Admins create or import them from CAD/BIM/IWMS. |
| **Reservations** (employee) | Spaces with `reservable = true` appear in the booking system. Employees can search, filter by amenities, and book them. |
| **Tickets** (employee + agent) | Spaces serve as location context on tickets ("AC broken in Meeting Room B"). Routing rules can use location to assign the right team. |
| **Preventive maintenance** (FM) | Spaces are targets for maintenance schedules ("quarterly deep clean — Room B"). |
| **Visitor management** (reception) | Visitors are linked to a site. Meetings happen in rooms. |
| **Reporting** (ops manager) | Space utilization, issue frequency per room/building, occupancy rates. |

**Amenities and installed equipment:**
A room's amenities (projector, whiteboard, video conferencing) can be:
- Simple attributes on the space (for infrastructure that isn't individually tracked — whiteboard, wheelchair ramp)
- References to **fixed assets** installed in the space (for equipment that is tracked — the projector in Room B is asset #projector-42, linked to the space)

When a fixed asset is assigned to a space, its presence becomes a queryable amenity. When the projector breaks, the ticket links to the asset. When the projector is replaced, the asset assignment changes and the room's amenities update automatically.

**Import and sync:**
- Spaces can be created natively in the platform
- Spaces can be imported from CAD/BIM/IWMS systems
- Imported spaces receive internal stable IDs with mapping to external source IDs
- After import, admins configure reservability, amenities, policies, and team assignments

### 18.2 How assets work across the platform

An asset is one object that serves different roles depending on its type (see 8.4 for details):

| Role | Used by | Bookable | Example flow |
|---|---|---|---|
| **Fixed/installed** | FM teams, maintenance | No | HVAC unit breaks → ticket links to asset → full maintenance history visible → vendor dispatched |
| **Personal** | IT, HR, employee | No | New employee → onboarding workflow assigns laptop → asset tracked to person → employee leaves → offboarding collects it |
| **Pooled/loanable** | Employees via catalog | Yes | Employee orders "extra beamer" → system reserves available beamer from pool → FM delivers → after meeting, asset returned → available again |

**The asset ↔ catalog connection:**
- Catalog items in the `equipment` category can link to an **asset pool** (all assets of a given type that are available for lending)
- When an employee orders a linked catalog item, the system checks pool availability for the requested date/time and reserves a specific asset instance
- The fulfillment team delivers the asset; it is temporarily assigned to the person/reservation
- After use, the asset must be returned (check-in). Overdue returns trigger reminders.
- Non-linked catalog items (food, supplies, services) have no asset tracking — they are fulfilled and consumed

**The asset ↔ space connection:**
- Fixed assets are permanently assigned to a space (HVAC → Building A, projector → Room B)
- A space's "amenities" can be derived from which fixed assets are currently assigned to it
- Personal assets may have a "home location" (the desk where the monitor sits) tracked via space assignment
- Pooled assets have a storage/home location when not checked out

**Data source strategy:**

Mixed model:
- Platform can manage assets natively
- Platform can import/sync from external systems (CMDB, ERP, IWMS)
- Internal stable IDs and mapping required even when syncing from outside
- Asset lifecycle changes (status, assignment, location) are tracked in assignment history (9.7.1)

---

## 18A. Workplace Services — Request Type Catalog

Beyond the core modules (tickets, reservations, visitors, catering, assets), mid-size organizations run many workplace services that don't need dedicated modules but do need pre-built request types, forms, and workflows. These are delivered as **configurable request types** within the unified ticket engine and service catalog.

### Common workplace service categories

**Cleaning services:**
- Ad-hoc cleaning request ("spill in conference room 3")
- Deep cleaning request for a space
- Scheduled cleaning (modeled via preventive maintenance schedules)

**Parking:**
- Parking space booking (uses reservation module with parking space type)
- Visitor parking reservation
- Parking permit request/renewal

**Mail and packages:**
- Package arrival notification (mailroom logs receipt → employee is notified for pickup)
- Internal mail/courier request
- Outgoing shipment request

**Keys and access:**
- Key issuance request
- Lock change request
- Temporary access card request
- Access revocation (often linked to offboarding workflow)

**Event support:**
- AV setup request for a room/event
- Furniture rearrangement request
- Extra equipment request (microphone, podium, projector screen)
- Event teardown/cleanup

**Security:**
- Security escort request
- Security incident report
- After-hours access request

**Moves and logistics:**
- Office move (already covered as a multi-task flow)
- Furniture request (new chair, standing desk)
- Internal delivery/transport request

**Printing and reprographics:**
- Large format print request
- Bulk printing/copying request
- Badge/signage printing

### How these are implemented

Each service is a **request type** configured through the configuration engine:
- Form schema defines the fields employees fill in
- Workflow defines the process (routing, approvals, fulfillment)
- Routing rule assigns to the correct team
- SLA policy defines response/resolution targets

The platform ships with **starter templates** for common workplace services per industry. Client admins activate, customize, or create new ones as needed. No custom code required — these are all configuration.

### Why this matters

The service catalog (9.22) is only as useful as the services it offers. If the platform launches with only "IT Incident" and "FM Request," employees won't adopt it. A rich set of pre-built workplace service templates drives adoption and makes the platform feel complete from day one.

---

## 19. Configuration Model

### 19.1 Chosen model

**Configurable but guided, powered by a unified configuration engine**

All tenant-configurable entities share the same lifecycle framework (see section 8.11). This ensures consistent draft/publish flows, versioning, audit trails, and admin UX across all config types — without building each one independently.

### 19.2 Client-configurable areas

- Request types (name, domain, linked form/workflow/SLA/routing)
- Form schemas (fields, types, validation rules, conditional visibility)
- Workflows (visual builder — see section 14)
- SLA policies (response/resolution targets, business hours, escalation)
- Routing rules (condition-based team assignment)
- Notification templates (content, tokens, channel selection)
- Branding (logo, colors, theme)
- Terminology (label overrides for platform concepts)

### 19.3 Areas intentionally constrained

- Core navigation structure
- Core object model boundaries
- Core UX patterns
- Arbitrary scripting or code execution
- Arbitrary tenant-level UI builders
- Config types not in the supported list — expansion is deliberate, not open-ended

### 19.4 Responsibility model

**Shared responsibility**

- Internal implementation team sets foundation configurations and starter templates during onboarding
- Client admins maintain day-to-day configurations within the guardrails of the configuration engine
- The configuration engine enforces validation, prevents publishing broken configs, and logs all changes

### 19.5 Lifecycle guarantees

All configurable entities share these guarantees via the configuration engine:

- **Draft/publish** — changes are made in draft, validated, then explicitly published
- **Versioning** — every publish creates a new version; full history is retained
- **Rollback** — any previous published version can be restored
- **Validation before publish** — type-specific business rules are checked before a configuration goes live
- **Audit trail** — who changed what, when, and what the diff was
- **Permission scoping** — configurable per config type (e.g., only Config Admins can publish workflows, but Team Leads can edit notification templates)
- **Starter templates** — new tenants begin with sensible default configurations that can be customized, not blank slates

---

## 20. AI Strategy

### 20.1 Chosen AI posture

**Assistive only — AI suggests, humans confirm**

AI is a core part of the product experience but never acts autonomously. Every AI suggestion must be confirmed by the user before it changes data. The AI layer is designed to be introduced incrementally — the platform works fully without it, and AI features are added as enhancements.

### 20.2 AI surfaces — phased rollout

#### Employee portal AI assistant (Phase 2)

The first AI surface. Introduced in Phase 2 after the core platform is proven. A conversational interface in the employee portal that helps employees:

- Describe their issue in natural language → AI identifies the request type, suggests category, pre-fills form fields
- Book a room → "I need a room for 8 people Thursday afternoon near Building A" → AI searches availability, suggests options
- Register a visitor → AI guides through the form conversationally
- Check request status → "What's happening with my office move?" → AI looks up their tickets and summarizes

**How it works technically:**
- Employee interacts with a chat-style interface in the portal
- Frontend uses Vercel AI SDK `useChat` hook to stream responses
- NestJS backend receives the message, builds a prompt with tenant context (request types, locations, available rooms), and calls the LLM via Vercel AI SDK
- LLM response includes structured tool calls (e.g., `create_ticket`, `search_rooms`, `lookup_ticket`) that the backend validates and executes with user confirmation
- All AI interactions are logged for audit

#### Service desk AI copilot (Phase 3)

A sidebar/panel in the service desk workspace that assists agents. Not a chatbot — a contextual assistant that surfaces suggestions based on what the agent is looking at.

When an agent opens a ticket, the copilot can:

- Suggest category, priority, and routing based on the ticket description and historical patterns
- Summarize long ticket histories (20+ activity entries → 3-sentence summary)
- Draft a response for the agent to review and send
- Suggest similar past tickets and how they were resolved
- Flag potential SLA risks based on current workload and assignment

**How it works technically:**
- The copilot panel loads when an agent views a ticket
- Backend builds a context payload: ticket details, activity history, requester info, similar tickets
- LLM generates suggestions that are displayed as actionable cards in the sidebar
- Agent clicks to accept a suggestion (e.g., "Apply category: HVAC Maintenance") → the action executes through the normal ticket update flow with full audit logging
- Copilot suggestions are never auto-applied — the agent is always in control

#### Admin AI (Phase 4)

- Workflow generation from natural language ("create a workflow for office moves with IT and FM tasks")
- Form schema suggestions ("suggest fields for a parking access request")
- Configuration explanation ("why is this ticket routed to Team B instead of Team A?")

### 20.3 Technical architecture

All AI calls follow the same path:

```
React UI (useChat/useCompletion) → NestJS AI endpoint → LLM provider
```

The NestJS backend owns:
- **Tenant context** — prompts are scoped to the tenant's request types, locations, teams, and policies
- **Tool definitions** — the LLM can call platform actions (create ticket, search rooms, suggest category) via structured tool calls, validated and executed by the backend
- **Audit logging** — every AI interaction (prompt, response, accepted suggestions) is logged per tenant
- **Rate limiting** — per-tenant rate limits to control LLM costs
- **Provider abstraction** — Vercel AI SDK supports multiple providers; switching from OpenAI to Anthropic is a config change

### 20.4 Hard boundaries

AI must not:

- Bypass workflow rules
- Skip approvals
- Mutate business data without user confirmation
- Change production configs without review/publish
- Replace deterministic business logic (routing rules, SLA calculations, approval chains)
- Access data outside the current tenant's scope

### 20.5 AI design principle

AI translates human intent into structured system actions. The platform is fully functional without AI — AI makes it faster and easier to use, but is never a dependency.

---

## 21. Reporting and Analytics Strategy

### 21.1 Current target

**Strong built-in operational reporting**

### 21.2 Early reporting capabilities

- Ticket volume and queue status
- SLA performance
- Resolution times
- FM issue trends by location
- Reservation usage and occupancy indicators
- Visitor volume and patterns
- Asset distribution and issue frequency

### 21.3 Future evolution

Move toward advanced analytics later:

- Cross-domain insights
- Predictive maintenance
- Optimization recommendations
- Cost/service intelligence

### 21.4 Data readiness requirements

From day one, track:

- Created/updated/resolved timestamps
- Status change timestamps
- Workflow transitions
- Assignment changes
- Reservation lifecycle events
- Visitor check-in/check-out events
- Approval timestamps
- Audit and domain events

---

## 22. Systems of Record and Data Source Strategy

### 22.1 People/users

**Mixed model**

- Employees sync from external identity/HR systems
- Platform manages visitors, contractors, vendor contacts, temporary actors

### 22.2 Spaces and assets

**Mixed model**

- Native management supported
- External import/sync supported
- Internal mapping and conflict handling required

### 22.3 Why mixed model

This supports both:

- Less mature clients needing native platform management
- Mature clients with existing source systems

---

## 23. Integration Strategy

### 23.1 Likely integration categories

- SSO / Identity providers
- HR systems
- Calendar systems (Outlook/Google)
- ERP/IWMS/BIM/CAD/import sources
- Access control/security systems
- Vendor integrations
- Notification channels

### 23.2 Integration architecture goals

- Explicit connectors/adapters
- Mapping layer per tenant
- Retry and monitoring support
- Webhook and pull-based sync support
- Stable internal domain model independent of external IDs

---

## 24. Technical Architecture

### 24.1 Chosen architecture

**Modular monolith**

One codebase and deployment unit initially, with strong internal module boundaries.

### 24.2 Why modular monolith

- Faster delivery for a new platform
- Lower complexity than microservices
- Better fit for current scale and product maturity
- Easier refactoring while domain model stabilizes
- Future extraction path if needed

### 24.3 Internal architectural modules

- Identity & Access
- Tenant/Organization
- Location/Space
- Asset
- Ticket/Service
- Workflow
- Approval
- Reservation
- Visitor
- Catering
- Forms/Configuration
- Policy/SLA
- Notifications
- Reporting
- AI Assist
- Integrations

### 24.4 Module boundary strategy

For a small team, heavy module isolation (event-driven communication, strict interface contracts) is premature. The boundary strategy scales with team size:

**Now (2-person team):**
- NestJS modules with explicit service exports — each module exposes a service class, other modules import and call it directly
- No module reaches into another module's database tables — all access goes through the owning module's service
- Shared types/interfaces for cross-module data contracts (e.g., `TicketSummary` type used by the reporting module)
- If you're tempted to import a repository from another module, that's a boundary violation — call the service instead

**Later (larger team):**
- Introduce internal event bus for decoupled communication (e.g., ticket_created event consumed by notification module, reporting module, SLA module)
- Stricter interface definitions between modules
- Module-level test isolation

The practical test: can you rename an internal table in the Ticket module without changing code in the Notification module? If yes, boundaries are healthy. If no, they've leaked.

### 24.5 Evolution path

Later extraction candidates (if needed):

- Notification service
- Search service (unified full-text search across entities — starts as PostgreSQL full-text search, evolves to OpenSearch when volume requires it)
- AI orchestration service
- Workflow execution service
- Integration workers

---

## 25. Proposed Technology Stack

### 25.1 Frontend

- **React 19** (single-page application)
- **Vite** for build tooling and dev server
- **TypeScript**
- **Tailwind CSS**
- **Vercel AI SDK** (`@ai-sdk/react`) for streaming AI interactions
- Shared design system / headless component approach

**Why SPA over Next.js SSR:**
The product's most critical surface — the service desk workspace — is a dense, stateful, keyboard-driven environment used 8+ hours/day. It requires persistent client state (open panels, queue positions, filters), sub-100ms interaction latency, and real-time updates via WebSocket/SSE. These characteristics align with a long-lived SPA, not server-rendered page transitions.

The employee portal is behind authentication and has no SEO requirements, so SSR provides no meaningful benefit. A single Vite + React build keeps one frontend pipeline, one mental model, and avoids the architectural split of running AI or data calls through Next.js server actions alongside NestJS.

The Vercel AI SDK's React hooks (`useChat`, `useCompletion`, `useObject`) are framework-agnostic and work against any streaming HTTP endpoint — they do not require Next.js. All AI orchestration routes through the NestJS backend, which owns tenant context, audit logging, prompt management, and guardrails.

If a public-facing marketing site or unauthenticated intake flow is needed later, a lightweight Next.js app can be added for that narrow use case without affecting the core product.

### 25.2 Backend

- **Node.js**
- **NestJS**
- **TypeScript**

### 25.3 Data layer

- **Supabase-managed PostgreSQL** — shared database with row-level security as default, dedicated database as enterprise option (see section 4)
- **Supabase connection pooling** (Supavisor) for connection management
- **Supabase Storage** for file attachments, tenant logos, and document uploads (tenant-scoped buckets)
- Use a thin query/data layer with explicit SQL on critical paths
- Tenant context resolved via `AsyncLocalStorage`, injected at middleware level (see section 4.6)
- RLS policies enforced at the database level, driven by tenant context from Supabase Auth JWT

### 25.4 Support infrastructure

- **Supabase Realtime** for live queue updates and ticket change notifications
- **Redis** for caching / coordination / ephemeral state
- **pg_cron** (or NestJS scheduled tasks) for workflow timers, SLA deadline checks, and escalation triggers
- Full-text search via **PostgreSQL full-text search** at launch, with evolution path to OpenSearch if volume demands it

**Deferred:** Temporal or equivalent durable workflow runtime — to be introduced when workflows require parallel execution, cross-system orchestration, or long-running processes beyond what the lightweight state machine engine handles (see section 14.4)

### 25.5 AI layer

- **Vercel AI SDK** (`ai` core package) on the NestJS backend for LLM orchestration and streaming
- **Vercel AI SDK** (`@ai-sdk/react`) on the frontend for consuming streamed responses
- Provider-agnostic: supports OpenAI, Anthropic, and other providers via the SDK's unified interface
- All AI calls route through NestJS — the backend owns tenant context, audit logging, rate limiting, prompt construction, and output validation
- Tool-driven orchestration under application control
- Strict confirmation and guardrails — AI never mutates state without user approval

### 25.6 Auth

- **Supabase Auth** as the identity provider
- Enterprise SSO/OIDC/SAML via Supabase's built-in provider support
- Email/password fallback for non-SSO users (contractors, vendor contacts, visitor self-registration)
- Per-tenant identity provider configuration
- JWT-based session tokens validated by NestJS middleware

### 25.7 Infrastructure

- Containerized deployment
- Kubernetes-compatible target for long-term flexibility

---

## 26. Data Model Strategy

### 26.1 Metadata-driven design

Many client-specific behaviors are represented through metadata rather than code forks:

- Request types
- Form schemas
- Workflows
- Policies
- Terminology
- Feature flags

### 26.2 Stable core model

Keep a stable core model for:

- Tenant
- Person/User
- Team
- Location hierarchy
- Space
- Asset
- Ticket
- Reservation
- Visitor
- Workflow
- Approval

### 26.3 Extension model

Allow controlled extension through:

- Custom fields
- Configurable metadata
- Entity-linked extension tables or JSON metadata where appropriate
- Strong validation and UI control

---

## 27. Key End-to-End Flows

### 27.1 Employee ticket creation flow

1. Employee opens unified front door
2. Enters request in conversational or guided form
3. AI suggests request type/category/location/priority
4. User confirms
5. Ticket is created
6. Routing rules assign to correct team
7. SLA starts
8. Event-based notifications issued through email and/or in-app channels
9. Service desk handles
10. User tracks status

### 27.2 Combined room booking (room + order catalog)

1. Employee requests a room: date/time, attendee count, required amenities (e.g., "video conferencing, whiteboard")
2. AI or UI suggests matching rooms filtered by availability, capacity, and amenities
3. Employee selects a room
4. Employee sees the **order catalog** — browsable by category (Food & Drinks, Equipment, Supplies, Services)
5. Employee adds items to cart: "Lunch buffet ×8, Coffee & tea ×8, Extra beamer ×1, Notepads + pens ×8"
6. Employee specifies dietary notes ("2 vegetarian, 1 gluten-free")
7. Running cost total updates as items are added
8. Employee reviews the full booking summary: room + all ordered items + total cost
9. Policies checked (capacity, approvals, time windows, cost threshold)
10. If total cost exceeds threshold, approval workflow triggers before confirmation
11. System creates in one action:
    - Reservation for the room
    - Linked order with all items
    - Per-category fulfillment tasks routed to responsible teams (catering team gets food items, FM gets equipment, etc.)
12. Employee sees one combined "booking" — room, food, equipment, supplies, services — all in one view
13. Each team fulfills their items independently, status tracked per line item
14. Employee can see fulfillment progress on their booking
15. Notifications and calendar updates sent to employee and attendees

### 27.3 Visitor registration flow

1. Host pre-registers visitor
2. AI-guided or standard form captures visitor details
3. Approval step triggered if policy requires it
4. Host and reception receive event-based notifications
5. Visitor arrives and checks in
6. Badge/check-in state recorded
7. Host notified
8. Visitor checks out later

### 27.4 Service desk triage flow

1. New ticket enters queue
2. AI suggests category/assignment/priority
3. Rule engine auto-assigns to team/group
4. Eligible team members are notified and see the item in their queue
5. An agent reviews and picks up/claims the item or overrides routing if needed
6. Individual ownership is recorded and work begins
7. Approval/escalation steps triggered as needed
8. Resolution and closure tracked

### 27.5 Local FM issue routing

1. User reports issue in room/building
2. System identifies location context
3. Request type and routing rules classify as FM
4. Ticket assigns to local FM team for that location
5. If unresolved or out-of-scope, escalates to central FM or vendor

### 27.6 Vendor escalation flow (external vendor)

1. Service desk receives FM ticket (e.g., "AC broken in room 302")
2. Agent investigates and determines a vendor is needed
3. Agent creates one or more child tasks from the parent ticket
4. Child task is marked as `external` (vendor does not use the platform)
5. Agent contacts vendor via email or phone
6. Agent logs outgoing communication as activity on the child task ("Emailed HVAC vendor, sent photos")
7. Vendor responds via email or phone
8. Agent logs vendor response as activity ("Vendor confirmed visit Thursday 2pm")
9. Vendor performs work on-site
10. Agent verifies completion and resolves the child task
11. When all child tasks are resolved, agent resolves the parent ticket
12. Employee is notified of resolution

### 27.7 Vendor escalation flow (vendor on platform)

1. Service desk receives FM ticket
2. Agent creates child task, assigns to vendor team in the platform
3. Vendor team is notified and sees the task in their queue
4. Vendor agent picks up the task, updates progress
5. Vendor agent resolves the task
6. Service desk agent verifies and resolves parent ticket

### 27.8 Multi-task ticket flow

1. Service desk receives a complex ticket requiring multiple work items
2. Agent creates multiple child tasks from the parent ticket:
   - Task 1: "Inspect HVAC unit" → HVAC Vendor (external)
   - Task 2: "Replace air filter" → FM Team Building A (internal)
   - Task 3: "Test and verify after repair" → Service Desk (internal)
3. Each task is worked independently with its own status and timeline
4. Agent monitors progress from the parent ticket view
5. As each child task is resolved, the parent ticket reflects remaining work
6. When all child tasks are resolved, the parent ticket is resolved

### 27.9 Workflow-driven multi-task request (e.g., Office Move)

1. Employee submits an "Office Move" request via the employee portal
2. Workflow engine recognizes the request type and automatically creates child tasks:
   - IT: "Relocate workstation equipment" → IT Team (internal)
   - FM: "Prepare new desk/office" → Local FM Team (internal)
   - Access Control: "Update badge access for new location" → Security Team (internal)
   - Catering: "Update meal delivery location" → Catering (internal)
3. Each team is notified and sees their task in their queue
4. Teams work independently — no coordination needed between them
5. Parent ticket workflow waits for all child tasks to reach "resolved"
6. When all child tasks are resolved, parent workflow proceeds to closure
7. Employee is notified that the move is complete

### 27.10 Simple ticket — no child tasks

1. Employee submits "What are the parking rules for visitors?"
2. Ticket is routed to service desk
3. Agent replies directly on the ticket with the answer
4. Agent resolves the ticket
5. No child tasks, no vendor involvement — the parent-child model is not involved

### 27.11 Employee onboarding flow

1. HR submits "New Employee Onboarding" request with start date, department, location
2. Workflow auto-creates child tasks:
   - IT: "Provision laptop, create accounts, configure email" → IT Team
   - FM: "Prepare desk, order furniture if needed" → Local FM Team
   - Security: "Issue badge, configure building access" → Security Team
   - Catering: "Add to meal program" → Catering (if applicable)
3. Each team works independently, updates their task
4. Parent ticket workflow waits for all child tasks
5. When all complete → employee is ready on day one
6. HR and line manager are notified

### 27.12 Employee offboarding flow

1. HR submits "Employee Departure" request with last day, department, location
2. Workflow auto-creates child tasks:
   - IT: "Revoke accounts, collect equipment (laptop, phone, peripherals)" → IT Team
   - FM: "Clean desk, reallocate space" → Local FM Team
   - Security: "Deactivate badge, revoke building access" → Security Team
3. Each team works independently
4. When all complete → offboarding is done
5. HR is notified of completion

### 27.13 Preventive maintenance flow

1. Maintenance schedule fires (e.g., "Monthly HVAC filter change — Building A")
2. Platform auto-creates ticket from the schedule's template
3. Ticket is routed to the configured FM team
4. FM technician picks up the task on mobile
5. Technician performs maintenance, uploads photos of completed work
6. Technician resolves the task
7. Schedule advances to next occurrence
8. If the task is overdue (not completed before next occurrence), alert the FM manager

### 27.14 Recurring room reservation flow

1. Employee requests "Book Room X every Tuesday 10-11am for 12 weeks"
2. System checks availability for all 12 occurrences
3. If conflicts exist on some dates, system shows which dates are available and which conflict
4. Employee confirms booking for available dates (or adjusts)
5. Reservation series is created
6. Employee can later cancel a single occurrence or the entire series
7. Linked catering (if any) follows the same recurrence

### 27.15 Standalone order (no reservation)

1. Employee opens the order catalog directly (not through a room booking)
2. Employee browses categories — e.g., "I need lunch for 20 in the canteen area Friday"
3. Employee adds items to cart, specifies location, date, time, headcount, dietary notes
4. System shows cost total
5. Approval triggered if needed (cost threshold)
6. Order is placed, fulfillment tasks created per category
7. Each responsible team fulfills their items
8. Employee is notified of confirmation and delivery

### 27.16 Email-to-ticket flow (future)


1. Employee sends email to support@acme.com
2. Platform receives inbound email, extracts subject, body, and attachments
3. New ticket is created with email content as description
4. Routing rules assign to the appropriate team
5. Agent responds from within the platform
6. Response is delivered to the employee's inbox as an email reply
7. Employee replies to the email → reply appears as an activity entry on the ticket

### 27.17 Multi-step approval flow

1. Employee submits a high-cost maintenance request ($15,000)
2. Workflow triggers sequential approval chain:
   - Step 1: Team Lead reviews and approves
   - Step 2: Department Head reviews and approves
   - Step 3: Finance reviews and approves
3. At each step, the approver receives a notification and the ticket shows "Pending Approval — Step 2 of 3"
4. If any approver rejects, the workflow follows the rejection branch (notify requester, close or return for revision)
5. When all steps approve, the workflow proceeds to execution (assignment, child task creation, etc.)

### 27.18 Post-resolution satisfaction survey flow

1. Ticket is resolved by the agent
2. After a configurable delay (e.g., 1 hour), the platform sends a satisfaction survey to the requester
3. Requester rates their experience (1-5 stars) and optionally adds a comment
4. Rating is stored on the ticket and included in service desk reporting
5. Low ratings can trigger a notification to the team lead for follow-up

### 27.19 Admin workflow creation flow

1. Admin enters natural-language intent or opens visual builder
2. AI proposes workflow structure
3. Admin reviews nodes, conditions, approvals, and event-driven notifications
4. Admin tests/validates draft
5. Admin publishes new workflow version
6. New tickets of matching type use the new workflow

---

## 28. Service Desk UX Requirements

### 28.1 Most critical screens

- Ticket queue/list
- Ticket detail with side context
- Assignment/triage tools
- SLA/priority views
- Approval worklists

### 28.2 Required interactions

- Inline edits
- Side-panel preview
- Bulk actions
- Saved filters
- Quick assign/reassign
- Fast navigation between tickets
- Visible timers and ownership

### 28.3 Anti-goals

- Slow modal-heavy flows
- Full page reloads on common actions
- Too many clicks for triage
- Poor filter performance

### 28.4 Real-time update strategy

Not everything needs to be real-time. Pushing unnecessary updates wastes bandwidth and creates UI instability (items jumping around in a list while an agent is reading it). The strategy is tiered:

**Real-time via Supabase Realtime (service desk):**

| Event | Why Real-Time |
|---|---|
| New ticket arrives in agent's queue | Agent needs to see new work immediately without refreshing |
| Ticket status changes | Prevents agents from picking up already-resolved tickets |
| Ticket assigned/reassigned | Prevents two agents from working the same ticket |
| SLA breach or at-risk status change | Agent needs to see escalation urgency immediately |
| New activity on a ticket the agent is currently viewing | Agent is looking at it — stale data causes confusion |

**Polling or on-navigation (employee portal):**

| Event | Approach |
|---|---|
| Ticket status updates on "my requests" page | Poll every 30-60 seconds, or refresh on page focus |
| Approval requests | Notification-driven (in-app + email), not real-time polling |
| Booking confirmations | Notification-driven |

**No real-time needed:**

| Area | Approach |
|---|---|
| Admin configuration screens | Load on open, no live updates |
| Reporting dashboards | Refresh on load or manual refresh button |
| Asset and space management | Load on navigation |

**UX consideration for real-time queue updates:**
When a new ticket arrives in the queue, don't insert it mid-list and shift everything — this disrupts agents who are scanning the list. Instead, show a subtle indicator ("3 new tickets") that the agent can click to refresh the view on their terms.

---

## 29. Non-Functional Requirements

### 29.1 Performance

A core differentiator. The service desk queue view is the single most performance-sensitive path in the platform.

**Targets:**

- Service desk queue load: < 200ms for filtered list (status + priority + team + location)
- Ticket detail open: < 150ms including activity timeline
- Inline edit save: < 100ms perceived response
- Booking availability check: < 300ms
- Employee portal ticket submission: < 500ms end-to-end

**Service desk query strategy:**

- Composite indexes on the ticket table for common filter combinations: `(tenant_id, status_category, assigned_team_id, priority)` and `(tenant_id, assigned_team_id, location_id, status_category)`
- SLA breach status stored as a **computed field on the ticket** (`sla_breached_at`, `sla_at_risk`), updated by the SLA timer job — never calculated at query time
- Cursor-based pagination (keyset pagination), not offset-based — offset degrades as page depth increases
- Supabase RLS adds `tenant_id` filtering automatically — ensure `tenant_id` is the leading column in all composite indexes so RLS doesn't cause full scans
- Saved filters stored as pre-built query definitions to avoid re-parsing

**What to watch for with RLS:**

- RLS policies add a WHERE clause to every query. If the policy references a function call or subquery (e.g., looking up the user's team), it can degrade performance. Keep RLS policies simple — reference the JWT claim directly, not a joined table
- Test query plans with `EXPLAIN ANALYZE` under RLS early and often

### 29.2 Reliability

- Strong test coverage on workflows and hot paths
- Stable deployments
- Auditability
- Graceful failure handling
- Durable orchestration for long-running processes

### 29.3 Security

- Strong tenant isolation through Supabase RLS (dedicated database as enterprise option — see section 4)
- Scoped authorization: role + domain scope + location scope (see section 30)
- Audit logging
- SSO support
- Approval and override traceability

### 29.4 Observability

- Structured logging
- Workflow execution traces
- Job/queue visibility
- Per-tenant operational visibility
- Alerting on failures, SLA breaches, sync failures

### 29.5 Scalability

- Scale app and workers horizontally
- Separate search/cache/orchestration concerns as needed
- Future service extraction possible without redesigning the domain model

---

## 30. Permissions and Access Model

### 30.1 Access principles

- Least privilege
- Scoped by role, domain, and location
- Local teams should see only relevant data where required
- Global teams may see cross-location data according to domain scope

### 30.2 Examples

- Local FM agent → Building A only
- Global IT agent → all IT tickets across tenant
- Reception → visitor-focused screens for site(s)
- Config admin → workflow/forms/policy access but not necessarily security admin rights

---

## 31. Config Guardrails and Governance

Configuration governance is handled by the unified configuration engine (see section 8.11) and its lifecycle guarantees (see section 19.5). All configurable entities share: draft/publish flows, versioning, rollback, validation before publish, audit trails, and permission scoping.

Shared responsibility only works if configuration is safe, explainable, and recoverable.

---

## 32. Eventing and Audit Strategy

### 32.1 Domain events

Track operational events such as:

- ticket_created
- ticket_assigned
- ticket_status_changed
- approval_requested
- approval_approved
- reservation_created
- visitor_checked_in
- asset_assigned
- workflow_transitioned

### 32.2 Audit events

Track security/admin actions such as:

- config_published
- role_changed
- manual_override_applied
- ticket_reassigned_by_user
- delegation_set

---

## 33. Go-to-Market and Migration Strategy

### 33.1 Strategic choice

Externally, migration may be positioned as a **full-platform replacement** of the current product.
Internally, delivery and migration should still be phased and controlled.

### 33.2 Practical migration approach

1. Reproduce critical current behaviors
2. Migrate foundational data
3. Enable core operational flows
4. Execute controlled cutover per client
5. Improve and expand post-migration

### 33.3 Migration priorities

Because current pain includes slow performance and poor UX, the new platform must first win on:

- speed
- stability
- service desk usability
- better ticket experience

---

## 34. Build Strategy and Phase Plan

### 34.1 Build strategy: Phase the UI, not the architecture

The data model, domain objects, backend services, and API surface are built for the **full specification** from day one. What gets phased is which UI screens exist and which features are exposed to users. This prevents painful rework, data migrations, and object redesigns in later phases.

**Full strategy document:** [build-strategy.md](build-strategy.md)

### 34.2 Phase overview

| Phase | Name | Focus | Depends On |
|---|---|---|---|
| **Phase 1** | Core Platform | Full backend + service desk + employee portal + basic admin | — |
| **Phase 2** | Workplace Platform | Booking + visitors + child tasks + AI assistant + full config admin | Phase 1 |
| **Phase 3** | Power Platform | Visual workflow builder + AI copilot + preventive maintenance + pooled assets | Phase 2 |
| **Phase 4** | Enterprise Ready | Email-to-ticket + integrations + knowledge base + dedicated DB + vendor portal | Phase 3 |

### 34.3 Phase details

Each phase is documented in a separate file with full scope, UI screens, and user experience descriptions:

- **[Phase 1 — Core Platform](phase-1.md)** — Full backend build + core UI (ticket queue, employee portal, basic admin, reporting). This is the largest phase because it includes the complete backend.
- **[Phase 2 — Workplace Platform](phase-2.md)** — Room/desk booking with order catalog, visitor management, child task UI, AI employee assistant, full configuration engine admin.
- **[Phase 3 — Power Platform](phase-3.md)** — Visual workflow builder (React Flow), AI service desk copilot, preventive maintenance scheduling, pooled asset management.
- **[Phase 4 — Enterprise Ready](phase-4.md)** — Email-to-ticket, knowledge base, integrations (HR, calendar, IWMS), dedicated database tier, vendor portal, advanced reporting.

### 34.4 Why this phasing

The strongest migration drivers are: performance, reliability, better ticket UX, and service desk productivity. Phase 1 delivers all of these. Subsequent phases expand the platform's breadth (workplace features, AI, power admin tools) while the backend remains stable.

The full backend is built in Phase 1 so that Phases 2-4 are primarily frontend work on top of stable APIs. This eliminates rework and ensures every feature integrates cleanly with the full data model from the start.

---

## 35. Risks and Anti-Patterns

### 35.1 Major risks

- Over-customization leading to configuration chaos
- Under-investing in service desk UX
- Letting AI bypass deterministic controls
- Building microservices too early
- Treating all tenants like fully custom implementations
- Slow query paths due to ORM abuse

### 35.2 Anti-patterns to avoid

- Full tenant-specific forks
- Unlimited scripting inside workflows
- Desktop-first design “fixed later” for mobile
- Manual routing as the default for everything
- Weak audit trails for overrides/config changes

---

## 36. Open Future Extensions

Potential later expansion areas:

- **Email-to-ticket** — inbound email creates tickets, agent replies appear as email responses (see flow 27.15)
- **Knowledge base / self-service content** — searchable articles that reduce ticket volume ("How do I connect to the printer?")
- **Interactive floor plans** — visual space mapping where users click a room or desk to book or report an issue
- **Cost tracking / departmental chargeback** — cost fields on tickets, rollup by department and cost center for billing
- **Satisfaction surveys** — post-resolution feedback collection with reporting (see flow 27.17)
- **Vendor portal** — dedicated external-facing view for vendors to manage their assigned tasks
- Predictive maintenance
- Advanced analytics and optimization
- Native mobile app if usage patterns justify it
- Advanced occupancy intelligence
- Follow-the-sun support models
- Sandboxed custom action plugins
- **Offline mobile support** — basic task viewing and status updates for field technicians without connectivity
- **ITIL change management** — change requests, change advisory board, change windows

---

## 37. Final Product Definition

This project is:

> A high-performance, reliable, AI-assisted workplace operations platform that unifies service management, facilities operations, reservations, visitors, spaces, and assets — with an exceptional service desk experience at its core.

It is architected as:

- A modular monolith
- Shared Supabase-managed database with RLS (dedicated database as enterprise option)
- Configurable but guided, powered by a unified configuration engine
- Workflow-driven with a visual builder
- Approval-aware (single-step, sequential, and parallel)
- Service-desk optimized
- AI-assisted, not AI-autonomous

It is intended to serve:

- Mid-size, multi-location organizations
- Across multiple industries
- With both global and local operational teams

And it is designed to win on:

- Speed
- Reliability
- UX
- Service desk efficiency
- Intelligent assistance

---

## 38. Detailed User Personas — Jobs, Needs, and UX Context

This section provides deep context on every user type in the platform. It describes who they are, what they're trying to accomplish, what frustrates them, and what a great experience looks like for them. Use this as a reference for all UX, feature, and prioritization decisions.

---

### 38.1 Employee / End User

**Who they are:**
Any person in the organization who uses the platform occasionally. They are not power users. They may interact with the platform 2-5 times per month. They include office workers, researchers, professors, nurses, administrators, and anyone who isn't part of the operational teams.

**Jobs to be done:**
- "I need to report that the AC in my room is broken"
- "I need a meeting room for 8 people on Thursday with video conferencing"
- "I'm expecting a visitor next week and need them registered"
- "I ordered catering for a team event and want to check if it's confirmed"
- "I submitted a request 3 days ago and want to know what's happening"
- "My new colleague starts Monday — I need IT and FM to prepare everything"

**What frustrates them:**
- Not knowing which category or form to use ("Is a broken AC an 'incident' or a 'facilities request'?")
- Too many fields on a form when they just want to describe the problem
- No visibility into what's happening after they submit
- Having to call someone to get an update
- Different systems for different things (one for rooms, one for IT, one for visitors)

**What a great experience looks like:**
- One place for everything — they never think about which system to use
- They describe their problem in natural language, AI helps them submit the right form
- They get a confirmation immediately and can track progress from their phone
- They get notified when something changes without having to check
- The whole interaction takes under 2 minutes

**Primary device:** Phone or laptop, roughly equal split. Mobile must be excellent.

**Frequency:** 2-5 interactions per month.

**Key screens:** Service catalog, AI-assisted intake, "My requests" tracker, room booking, visitor registration.

---

### 38.2 Service Desk Agent

**Who they are:**
Professional service desk operators who spend 6-8 hours per day in the platform. They handle tickets across FM, IT, or both. They work in queues, triage incoming requests, assign work, escalate when needed, and close resolved tickets. In smaller organizations, they may also perform the work themselves.

**Jobs to be done:**
- "I need to see all new tickets assigned to my team and triage them"
- "I need to quickly categorize and route this ticket to the right team"
- "I need to update 15 tickets in bulk because a vendor confirmed a visit date"
- "I need to see which tickets are about to breach SLA so I can prioritize"
- "I need to communicate with the requester and with an internal team simultaneously"
- "I need to create child tasks for a complex request and track them all"
- "I need to log a phone call from a vendor as an update on a task"

**What frustrates them:**
- Slow page loads (even 500ms feels slow when you're doing 200 actions per day)
- Too many clicks to do basic things (open ticket, update status, assign, close)
- Losing context when switching between tickets
- Not seeing real-time queue changes (colleague already picked up a ticket, but their view is stale)
- Modal-heavy interfaces that block the screen
- Not being able to use keyboard shortcuts for common actions
- Poor search — can't find a ticket they looked at yesterday

**What a great experience looks like:**
- Dense, information-rich queue view that loads instantly
- Side panel shows ticket detail without navigating away from the queue
- Keyboard shortcuts for assign, status change, escalate, comment
- Real-time updates — new tickets appear, resolved tickets disappear, SLA timers tick
- AI copilot that suggests category, priority, and draft responses (but never auto-applies)
- Bulk actions that work smoothly (select 10 tickets, assign all to Team B)
- Saved filters/views for their most common queues

**Primary device:** Desktop (large screen, keyboard). Mobile for after-hours urgent checks only.

**Frequency:** All day, every working day. 200+ actions per day.

**Key screens:** Ticket queue (THE most important screen), ticket detail with side panel, bulk action tools, SLA dashboard, AI copilot sidebar.

---

### 38.3 Facility Manager / FM Operator

**Who they are:**
Responsible for the physical operation of buildings and spaces. They manage maintenance teams, oversee building issues, handle vendor relationships, and ensure spaces are functional and safe. In larger organizations, they manage a team of FM technicians. In smaller ones, they may also be hands-on.

**Jobs to be done:**
- "I need to see all open FM issues for my building(s)"
- "I need to schedule preventive maintenance for HVAC, fire systems, elevators"
- "I need to assign a vendor to fix a leaking pipe and track their progress"
- "I need to report on FM ticket volume and resolution times per building"
- "I need to approve a high-cost maintenance request"
- "I need to know which spaces are having the most issues so I can plan renovations"

**What frustrates them:**
- No visibility into vendor work status (did they actually show up?)
- Preventive maintenance tracked in spreadsheets instead of the system
- Can't easily see all issues for a specific building or floor
- Approval requests buried in email instead of a clear queue
- Reports that require exporting data and building in Excel

**What a great experience looks like:**
- Dashboard showing open issues per building with SLA status
- Preventive maintenance schedules that auto-generate tickets
- Vendor task management with clear external/internal tracking
- Quick approval from their phone when a high-cost request comes in
- Location-filtered views that show their buildings only
- Built-in reporting without needing to export

**Primary device:** Desktop for daily work. Mobile for approvals and quick checks on-site.

**Frequency:** Daily. Heavy during business hours.

**Key screens:** Building-filtered ticket view, preventive maintenance schedule, vendor task tracker, FM dashboard, approval queue.

---

### 38.4 IT Agent / IT Service Desk

**Who they are:**
IT support agents handling incidents (something is broken), service requests (I need access to a system), and asset-related issues. They may overlap with the general service desk role in smaller organizations or be a specialized team in larger ones.

**Jobs to be done:**
- "I need to handle an incident where 30 users lost email access"
- "I need to process an access request and ensure the right approvals happen"
- "I need to see which assets are assigned to an employee who is leaving"
- "I need to escalate this to the network team and track resolution"
- "I need to link a ticket to the specific laptop and check its history"

**What frustrates them:**
- Can't easily link a ticket to the right asset
- Escalation to another team means losing visibility into the ticket
- No way to see the full history of an asset (all past incidents, changes, assignments)
- SLA starts ticking before they even see the ticket because routing was slow

**What a great experience looks like:**
- Asset-linked ticket view (click an asset, see all its history)
- Clean escalation flow with continued visibility
- SLA awareness with clear timers
- Integration with identity/access systems (future, but important)
- Quick ticket creation for walk-up support

**Primary device:** Desktop.

**Frequency:** All day, every working day.

**Key screens:** IT ticket queue, asset detail view, ticket detail with asset linkage, escalation tools.

---

### 38.5 Reception / Visitor Desk

**Who they are:**
Front desk staff at building entrances. They manage visitor arrivals, check-ins, badge handling, and host notifications. In some organizations, they also handle walk-in service requests and deliveries.

**Jobs to be done:**
- "A visitor just arrived — I need to check them in quickly"
- "Someone walked in without a pre-registration — I need to create one on the spot"
- "I need to notify the host that their visitor has arrived"
- "I need to print/assign a visitor badge"
- "A visitor left — I need to check them out and deactivate their badge"
- "I need to see who's expected today at my site"

**What frustrates them:**
- Slow check-in flow (visitor is standing at the desk waiting)
- Having to search through a long list to find a pre-registered visitor
- No clear view of who's expected today
- Host notification that doesn't actually reach the host
- Complicated forms for walk-in visitors

**What a great experience looks like:**
- "Today's visitors" view as the default screen — sorted by expected arrival time
- One-tap check-in for pre-registered visitors
- Quick walk-in registration (name, host, company — done)
- Host is notified immediately via in-app and email
- Badge assignment is seamless
- Tablet-optimized interface at the front desk

**Primary device:** Tablet at front desk. Occasionally desktop.

**Frequency:** Throughout the day. Peaks at morning arrival times.

**Key screens:** Today's visitors (default), check-in screen, walk-in registration, badge management.

---

### 38.6 Client Admin / Business Admin

**Who they are:**
Non-technical admin users from the client organization. They maintain the day-to-day configuration: request types, forms, SLA policies, routing rules, and notification templates. They are not developers — they need guided, safe configuration tools.

**Jobs to be done:**
- "I need to create a new request type for parking access with a specific form"
- "I need to update the SLA policy because response times changed"
- "I need to add a new team and set up routing rules for them"
- "I need to customize the notification email when a ticket is resolved"
- "I need to adjust a workflow because we added an approval step for high-cost requests"

**What frustrates them:**
- Making a change and having it break something without knowing why
- No way to test a change before it goes live
- No way to undo a mistake
- Not knowing what changed and when (audit trail)
- Being scared to touch the workflow builder

**What a great experience looks like:**
- Draft/publish model means they can't accidentally break production
- Clear version history with the ability to diff and rollback
- Visual workflow builder that's intuitive, not intimidating
- Live preview of forms before publishing
- Validation that catches errors before publish
- Starter templates that they can customize instead of building from scratch

**Primary device:** Desktop.

**Frequency:** Weekly to monthly. Bursts during onboarding/setup.

**Key screens:** Configuration engine admin shell, workflow builder, form schema builder, request type editor.

---

### 38.7 Line Manager / Department Head

**Who they are:**
Middle management. They approve requests, monitor their team's service interactions, and need departmental visibility. They are not service desk users — they interact with the platform through approvals, dashboards, and occasional requests.

**Jobs to be done:**
- "I need to approve a laptop request for my direct report"
- "I need to see all open requests from my department"
- "I need to approve an office move for someone on my team"
- "I need to delegate my approvals to a colleague while I'm on vacation"
- "I need a monthly report on my department's ticket volume and costs"

**What frustrates them:**
- Approval requests lost in email spam
- No mobile-friendly way to approve on the go
- Can't see what their team has requested or what's pending
- No delegation mechanism when they're unavailable

**What a great experience looks like:**
- Clear approval queue — prominent, separate from other notifications
- One-tap approve/reject on mobile with enough context to decide
- "My team" view showing their department's open requests
- Easy delegation setup (dates, delegate person, auto-revert)
- Departmental dashboard with key metrics

**Primary device:** Laptop and phone, roughly equal. Approvals often happen on mobile.

**Frequency:** 3-10 approvals per week. Dashboard checks weekly/monthly.

**Key screens:** Approval queue, "My team's requests" view, departmental dashboard, delegation settings.

---

### 38.8 Operations Manager / Executive

**Who they are:**
Senior operational leadership. They never create tickets or handle service desk work. They use the platform for visibility, reporting, and decision-making. They want to see whether the organization's workplace operations are healthy.

**Jobs to be done:**
- "Are we meeting our SLA targets this month?"
- "Which buildings have the most FM issues?"
- "How is our vendor performing on maintenance contracts?"
- "What's our room utilization rate across campuses?"
- "I need this data for a board presentation"

**What frustrates them:**
- Having to ask someone to pull data and build a report manually
- No single view of operational health
- Data from different modules that doesn't connect (FM data in one report, IT in another)
- Reports that are out of date by the time they see them

**What a great experience looks like:**
- Executive dashboard with KPIs: SLA performance, ticket trends, occupancy, vendor performance
- Role-based — they see cross-location, cross-domain data
- Exportable for presentations (PDF, CSV)
- Refresh on load, always current
- No configuration needed — just works out of the box

**Primary device:** Desktop (laptop). Occasionally checks phone for alerts.

**Frequency:** Weekly dashboard check. Monthly deep-dive.

**Key screens:** Executive dashboard, cross-domain reports, export tools.

---

### 38.9 Field Technician / Mobile Worker

**Who they are:**
Hands-on maintenance and repair staff. Electricians, HVAC technicians, plumbers, general maintenance workers, security guards doing rounds. They spend their day moving between locations, not at a desk.

**Jobs to be done:**
- "I need to see my assigned tasks for today"
- "I'm at Building A — show me what needs to be done here"
- "I just finished a repair — I need to update the status and upload a photo"
- "I found an additional issue while here — I need to create a new ticket from the field"
- "The task says 'replace filter' but I need more details about the HVAC unit"

**What frustrates them:**
- Having to go back to a desk to update a ticket
- Tiny text and complex forms on their phone
- Can't take a photo and attach it to the task quickly
- No location context — they have to remember which building/room the task is for
- Tasks that don't have enough information to act on

**What a great experience looks like:**
- Mobile-first task list: today's tasks, sorted by location or priority
- Large touch targets, minimal typing
- One-tap status updates (arrived, in progress, completed)
- Camera integration: take photo → attach to task in one action
- Task detail shows location, asset info, and full description
- Ability to add notes quickly via voice-to-text (future)

**Primary device:** Phone. Always mobile.

**Frequency:** Throughout the day. 10-30 task updates per day.

**Key screens:** Mobile task list, task detail with photo upload, quick status update, new ticket creation.

---

### 38.10 Catering Coordinator / Canteen Staff

**Who they are:**
Staff managing catering orders for the organization. May be an internal canteen team or a contact coordinating with external caterers. They handle orders linked to room bookings, standalone event catering, and ad-hoc requests.

**Jobs to be done:**
- "I need to see all catering orders for today and tomorrow"
- "I need to check dietary requirements for the 12-person lunch in Room B"
- "I need to confirm an order and update the status so the requester knows"
- "A meeting was cancelled — I need to cancel the linked catering order"
- "I need to update the menu because we changed our lunch options this month"

**What frustrates them:**
- Orders coming in via email, phone, and platform with no central view
- Not knowing about dietary restrictions until it's too late
- Last-minute changes or cancellations with no notification
- No visibility into which orders are confirmed vs still pending

**What a great experience looks like:**
- Order queue view: today's orders, upcoming, filtered by status and delivery time
- Clear dietary requirements and headcount per order
- Quick status updates (confirmed → preparing → delivered)
- Automatic notification when a linked reservation is cancelled
- Catering catalog they can maintain (add/remove items, update prices)

**Primary device:** Desktop or tablet in the kitchen/canteen.

**Frequency:** All day during business days.

**Key screens:** Fulfillment queue (food & drinks items), order detail with dietary info, catalog management for their category.

Note: The catering coordinator sees only the **food & drinks** fulfillment items from the unified order catalog. FM/AV teams see their own equipment and service items. Each team has a filtered view of the fulfillment queue showing only their category.

---

### 38.11 Implementation/Admin Team (Internal)

**Who they are:**
Your own team. The 2-person (and growing) team that onboards new clients, configures their initial setup, creates starter templates, and supports client admins.

**Jobs to be done:**
- "I need to onboard a new client: create their tenant, configure SSO, seed default data"
- "I need to create a set of starter request types, workflows, and forms for a healthcare client"
- "I need to debug why a workflow isn't triggering for a specific tenant"
- "I need to configure routing rules for a client with 12 buildings across 3 sites"
- "I need to export a working configuration from one tenant and adapt it for another"

**What frustrates them:**
- Repetitive setup work that could be templated
- No way to copy configurations between tenants
- Having to manually test every workflow after setup
- Unclear error messages when a configuration doesn't work

**What a great experience looks like:**
- Tenant provisioning that's fast and scripted
- Template library: "Healthcare starter", "University starter", "Corporate starter"
- Configuration copy/export between tenants (future)
- Clear workflow test mode
- Platform-level admin view across all tenants (for troubleshooting)
