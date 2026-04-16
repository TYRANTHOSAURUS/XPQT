# Phase 1 — Core Platform

**Goal:** Ship a fast, reliable ticket platform that gets the first client migrated and proves the product works.

**Timeline estimate:** 4-5 months for 2 people (includes full backend build).

---

## Backend (built for full spec)

Phase 1 backend builds the **complete** data model and service layer as described in the build strategy. This is the largest investment in Phase 1 and pays off across all future phases.

### Database schema
All tables from the spec are created:
- [x] All domain objects (sections 9.1–9.23) with full field sets
- [x] Configuration engine tables (config_entities, config_versions)
- [x] Notification, audit event, and domain event tables
- [~] RLS policies for all tables

### Services and APIs
All backend services are implemented:

| Service | Scope |
|---|---|
| **Ticket service** | [~] Full CRUD. Parent-child relationships. Status aggregation. Activity timeline (internal/external/system). Attachment handling. |
| **Workflow engine** | [~] Graph-based state machine. Reads workflow definition JSON. Executes all 10 node types (trigger, condition, assign, create child tasks, approval, wait for, timer, notification, update ticket, end). Branching support. Timer scheduling via pg_cron. |
| **SLA engine** | [~] Response + resolution timers. Pause/resume on waiting states. Business hours calculation against calendar. Breach detection. Multiple timers per ticket. Computed breach fields on ticket (sla_breached_at, sla_at_risk). |
| **Approval engine** | [x] Single-step, sequential multi-step, parallel multi-step. Delegation. Reminder scheduling. |
| **Routing engine** | [x] Rule evaluation (request type + domain + location + category → team). Manual override. |
| **Configuration engine** | [~] Config entity registry. Draft/publish/version lifecycle. Validation framework. Rollback. Audit logging. |
| **Notification engine** | [x] Event-driven dispatch. Template rendering with tokens. Email + in-app delivery. |
| **Reservation service** | [ ] Room/desk booking. Availability checking. Recurring reservations. Linked orders. Amenity filtering. |
| **Order & catalog service** | [ ] Cart management. Line items. Fulfillment routing per category. Asset pool availability check. Cost calculation. |
| **Asset service** | [x] Registry. Assignment (permanent/temporary). Pool availability. Return tracking. Assignment history. |
| **Visitor service** | [ ] Pre-registration. Walk-in. Check-in/check-out. Host notification. |
| **Maintenance schedule service** | [ ] Recurring schedule management. Auto-ticket generation. |
| **Space service** | [x] Location hierarchy CRUD. Amenity management. |
| **Tenant service** | [x] Registry. Provisioning. Feature flags. Branding. |
| **Auth service** | [x] Supabase Auth integration. Tenant resolution. JWT validation. RLS context setting. |
| **Search service** | [ ] PostgreSQL full-text search across tickets, spaces, assets, people. |
| **Real-time service** | [ ] Supabase Realtime subscriptions for service desk events. |
| **Reporting service** | [x] Ticket volume, SLA performance, resolution times queries. |

### Seed data and templates
- [ ] Default workflow templates (linear, linear + approval, multi-task)
- [ ] Default request types per industry (Healthcare starter, University starter, Corporate starter), including workplace service types:
  - IT: incident, service request, access request, equipment request
  - FM: maintenance issue, cleaning request, office move, furniture request
  - Workplace: room booking issue, parking request, key/lock request
  - Security: security incident, escort request, after-hours access
  - Mail: package arrival notification, internal courier request, outgoing shipment
  - Events: AV setup request, furniture rearrangement, event support
  - Printing: large format print request, bulk printing/copying
  - General: information request, complaint, feedback
- [ ] Default SLA policies (standard, high-priority, critical)
- [ ] Default routing rules per request type domain
- [ ] Default notification templates for all event types
- [ ] Default service catalog categories (IT Support, Facilities, Workplace Services, Access & Security, General)
- [ ] Default business hours calendar (Mon-Fri 08:00-17:00)
- [ ] Default catalog items for common workplace needs (coffee service, basic catering packages, standard equipment)

---

## Frontend — Phase 1 UI Screens

Only these screens are built in Phase 1. Everything else waits for later phases.

### Service Desk Workspace

**Ticket queue/list view (THE most important screen)**
- [x] Dense table/list layout
- [~] Columns: ID, title, status, priority, assigned team, assigned agent, location, SLA status, created date
- [ ] Filters: status, priority, team, location, domain, SLA breach status
- [ ] Sort by any column
- [x] Side-panel ticket detail (click row → detail opens alongside queue)
- [~] Bulk actions: assign, change status, change priority (multi-select)
- [ ] Real-time updates: new tickets appear indicator, status changes reflect live
- [ ] Keyboard shortcuts: navigate list, open detail, assign, change status
- [x] Pagination: cursor-based, fast

**Ticket detail view**
- [x] Full ticket information (all fields from 9.8 that are populated)
- [x] Activity timeline with internal notes, external comments, system events
- [x] Add comment (toggle internal/external)
- [ ] Attachment upload
- [x] Status change
- [~] Assignment/reassignment (team and/or agent)
- [x] Priority change
- [x] SLA timer display (response + resolution, with visual breach indicator)
- [x] Linked info: requester details, location context, asset (if linked)
- [~] Child tasks section (visible but "create child task" button NOT in Phase 1 UI — API exists though)

**Team queue view**
- [ ] Tickets assigned to a team but not yet claimed by an individual
- [ ] Claim/pickup action

**Approval queue / worklist**
- [x] Dedicated view showing all pending approvals for the current user
- [x] Approve/reject with one click + optional comment
- [~] Context summary (what's being approved, who requested it, cost if applicable)
- [ ] Mobile-optimized: large tap targets, one-tap approve/reject, works on phone
- [ ] Shows approval chain progress for multi-step ("Step 2 of 3")
- [ ] Delegation indicator if acting as a substitute

**Saved filters**
- [ ] Save current filter combination as a named view
- [ ] Switch between saved views quickly
- [ ] Personal saved views per agent

**Inline editing**
- [ ] Edit priority, status, and assignment directly from the queue row without opening the detail panel
- [ ] Click a cell → dropdown/picker appears → change applied immediately

### Employee Portal

**Service catalog**
- [x] Browsable categories (from service_catalog_categories)
- [x] Category cards with icons and descriptions
- [x] Click category → see available request types
- [x] Search across catalog

**Request submission**
- [x] Select request type → dynamic form rendered from form schema
- [x] Form fields rendered by type (text, dropdown, date, person picker, location picker, etc.)
- [ ] Conditional visibility working
- [x] Submit → ticket created → confirmation shown

**My requests**
- [x] List of employee's own tickets
- [x] Status, last update, SLA indicator
- [~] Click → detail view (external comments only, no internal notes)

**My approvals**
- [ ] Pending approvals for the current employee (e.g., line managers who approve from the portal, not the service desk)
- [ ] One-tap approve/reject on mobile
- [ ] Context summary for each approval

**Unified search bar**
- [ ] Global search across tickets, spaces, people, and assets from one input
- [ ] Results grouped by entity type
- [ ] Permission-filtered (employee sees only their own tickets and public spaces; agents see more based on scope)

### Admin

**Request type management**
- [x] List of request types
- [~] Create/edit form: name, domain, category, linked form schema, linked workflow template, linked SLA policy, linked routing rule
- [ ] Uses configuration engine under the hood (draft/publish) but UI is a simple form + "Save & Publish" button — the full versioning/rollback admin UI comes later

**Form schema builder (simplified)**
- [x] Field list with add/remove/reorder
- [x] Field type selection from supported types
- [x] Required/optional toggle
- [ ] Conditional visibility configuration
- [x] Live preview
- [x] Save & publish

**SLA policy management**
- [x] List of SLA policies
- [x] Create/edit: response target, resolution target, business hours calendar, pause conditions, escalation thresholds
- [x] Save & publish

**Routing rule management**
- [x] List of routing rules
- [x] Create/edit: conditions (request type + domain + location → assign to team)
- [x] Save & publish

**Workflow template selection**
- [x] List of pre-built workflow templates
- [ ] Select a template → configure parameters (which states, which teams, which approvals, which notifications)
- [x] Save & publish
- [x] No visual builder yet — that's Phase 3

**Team management**
- [x] Create/edit teams with name, domain scope, location scope
- [x] Assign users to teams

**User/role management**
- [x] View users (synced from Supabase Auth)
- [x] Assign roles with domain + location scope

**Person management**
- [x] View/edit person records (employees, contractors, vendor contacts)
- [x] Fields: name, email, phone, division, department, cost_center, manager, type
- [ ] Employees sync from auth; contractors/vendor contacts managed manually
- [ ] Link person to user account where applicable

**Asset registry management**
- [x] List assets with filters (type, role, status, location, assigned person)
- [x] Create/edit assets: name, type, role (fixed/personal/pooled), tag, serial number, assigned space, assigned person, purchase date, lifecycle state, external source ID
- [ ] View assignment history per asset
- [x] Pooled asset management comes in Phase 3; basic registry and fixed/personal assignment here

**Delegation management**
- [x] Managers can set delegation: "From [date] to [date], delegate my approvals to [person]"
- [~] Auto-revert after end date
- [x] Active delegations visible to the delegate and to admins

**Location management**
- [x] Create/edit site → building → floor → room/desk hierarchy
- [x] Set reservable flag, capacity, amenities

**Business hours calendar management**
- [x] Create/edit calendars: name, timezone, working hours per day, holidays

**Notification template management**
- [x] View default templates
- [x] Edit template content (token-based: {{ticket.title}}, {{assignee.name}})
- [x] Save & publish

### Line Manager / Department Head Views

**My team's requests**
- [ ] List of tickets submitted by or assigned to people in the manager's department
- [ ] Filter by status, priority, team member
- [ ] Read-only view of ticket detail (external comments + status, no internal notes)

**Departmental dashboard**
- [ ] Ticket volume for the department
- [ ] SLA performance for department-originated tickets
- [ ] Pending approvals count

### Mobile-Optimized Screens (Phase 1)

The following screens are built mobile-first from Phase 1:

[ ] **Employee portal** (all screens) — mobile-first responsive design
[ ] **Approval queue** — one-tap approve/reject on phone
[ ] **My requests** — status tracking from phone
[ ] **Field technician task list** — mobile-first view of assigned tasks, sorted by location. Large tap targets. Quick status updates (arrived, in progress, completed). Photo upload via camera integration. Location context per task. Create new ticket from the field ("I found an additional issue while here").
[ ] **Service desk mobile fallback** — simplified queue view for agents checking tickets from their phone. View ticket detail, update status, reassign. Not the full dense desktop workspace, but enough to act on urgent tickets.

### Reporting

**Operational dashboard**
- [~] Ticket volume (open, resolved, closed) — by day/week/month
- [x] SLA performance (% met, % breached)
- [ ] Average resolution time
- [x] Tickets by status, priority, team, location
- [~] Filter by date range, domain, location

### Observability

- [ ] Structured logging (JSON logs with tenant_id, user_id, request_id per log entry)
- [ ] Workflow execution traces (log each node transition per workflow instance)
- [ ] Scheduled job monitoring (SLA timer jobs, maintenance schedule triggers, reminder dispatches)
- [ ] Per-tenant visibility (ability to filter logs and metrics by tenant)
- [ ] Alerting: SLA timer job failures, notification delivery failures, workflow execution errors

### Technology Stack (Phase 1)

- [x] **Frontend:** React 19, Vite, TypeScript, Tailwind CSS
- [x] **Backend:** NestJS, Node.js, TypeScript
- [x] **Database:** Supabase-managed PostgreSQL with RLS
- [x] **Auth:** Supabase Auth (SSO/OIDC/SAML)
- [ ] **Storage:** Supabase Storage (attachments, logos, documents)
- [ ] **Real-time:** Supabase Realtime (service desk queue updates)
- [ ] **Caching:** Redis for caching, coordination, and ephemeral state (session data, rate limiting, frequently accessed tenant config)
- [ ] **Timers:** pg_cron for workflow timers, SLA deadline checks, maintenance schedule triggers
- [ ] **Search:** PostgreSQL full-text search

### Deployment Infrastructure

- [ ] Containerized deployment (Docker)
- [ ] CI/CD pipeline for automated builds and deployments
- [ ] Kubernetes-compatible target for production (or managed container platform initially)
- [ ] Environment separation (development, staging, production)

### Performance Targets

Phase 1 must meet these targets from day one — performance is a core differentiator:

| Metric | Target |
|---|---|
| Service desk queue load (filtered) | < 200ms |
| Ticket detail open (with activity timeline) | < 150ms |
| Inline edit save (status, priority, assignment) | < 100ms perceived |
| Employee portal ticket submission | < 500ms end-to-end |
| Booking availability check | < 300ms (API ready, UI in Phase 2) |

Achieved through:
- [ ] Composite indexes on ticket table for common filter combinations
- [x] SLA breach status as computed fields (never calculated at query time)
- [x] Cursor-based pagination
- [~] Simple RLS policies referencing JWT claims directly
- [ ] Query plan validation with EXPLAIN ANALYZE under RLS during development

---

## What Phase 1 Users Experience

**Employee:**
"I open the portal, browse the service catalog, find 'Report an IT issue,' fill in the form, submit. I get a confirmation. I can check 'My requests' to see the status. It's fast and clean."

**Service desk agent:**
"I open my queue, see all tickets assigned to my team. I filter by priority. I click a ticket, the side panel shows the full detail. I add an internal note, change the status to 'In Progress,' assign it to myself. I resolve it when done. The queue updates in real-time. Keyboard shortcuts make me fast."

**Admin:**
"I create a new request type, build a form, link it to an SLA policy and a routing rule, publish it. Employees can now submit this request type. I don't need a developer."

**FM Manager:**
"I see the operational dashboard. SLA performance this month is 94%. Building A has the most open tickets. I drill down to see what's going on."

**Line Manager:**
"I open 'My team's requests' and see all open tickets from my department. I check my approval queue — two pending. I approve one from my phone with one tap."

**Field Technician:**
"I open the app on my phone, see my tasks for today sorted by building. I tap a task, see the room and description. I update the status to 'In Progress.' When done, I take a photo of the completed work, attach it, and mark it as resolved."

---

## What Phase 1 Users Do NOT Experience

- Room/desk booking UI (API ready — Phase 2)
- Order catalog / catering UI (API ready — Phase 2)
- Visitor management UI (API ready — Phase 2)
- AI assistant (Phase 2)
- Visual workflow builder (engine ready, templates used instead — Phase 3)
- Parent-child ticket creation button (API ready — Phase 2)
- AI copilot for service desk (Phase 3)
- Advanced reporting / exports / custom dashboards (Phase 4)
- Recurring reservation UI (API ready — Phase 2)
- Preventive maintenance scheduling UI (API ready — Phase 3)
- Satisfaction surveys (Phase 3)
- Tags, watchers, cost fields on ticket UI (in database, exposed in Phase 2-3)
- Pooled/loanable asset management UI (Phase 3)
- Standalone order flow UI (Phase 2)
- Catering coordinator / fulfillment team views (Phase 2)
- Catalog item management admin (Phase 2)
- Knowledge base (Phase 4)
- Email-to-ticket (Phase 4)
- Integration framework (Phase 4)
- Vendor portal (Phase 4)
