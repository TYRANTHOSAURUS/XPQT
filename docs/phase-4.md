# Phase 4 — Enterprise Ready

**Goal:** Add enterprise features, integrations, and capabilities that mature the platform for larger and more demanding clients.

**Timeline:** Ongoing. These are independent feature streams that can be prioritized based on client demand and sales pipeline.

**Depends on:** Phase 3 complete. Platform proven with multiple clients.

---

## Features

### Email-to-Ticket

- Inbound email parsing (support@acme.com → new ticket)
- Subject → title, body → description, attachments preserved
- Auto-routing via routing rules (same as portal-submitted tickets)
- Agent replies from platform → delivered to requester's inbox as email reply
- Requester replies to email → appears as activity entry on ticket
- Thread matching by ticket reference ID in subject line

### Knowledge Base / Self-Service

- Admin creates articles organized by category
- Employees search knowledge base before submitting a ticket
- AI assistant can reference knowledge base articles in responses
- "Did this help?" feedback per article
- Reduces ticket volume for common questions ("How do I connect to the printer?")

### Satisfaction Survey Enhancements

The core satisfaction survey (prompt, rating, storage, team lead alerts) is delivered in Phase 3. Phase 4 adds:

- Tenant can customize the survey question text and rating scale
- Satisfaction trend reporting over time (scheduled delivery to ops managers)
- Correlation reporting: satisfaction by team, domain, location, request type

### Advanced Reporting & Exports

- Custom dashboard builder (drag-and-drop widgets)
- Cross-domain insights (FM + IT + reservations in one view)
- Export to PDF, CSV, Excel
- Scheduled report delivery (email weekly summary to ops managers)
- Departmental chargeback reports (cost by department, cost center)

### Integration Framework

**Identity & HR sync:**
- Employee data sync from HR systems (new hires, departures, department changes)
- Automatic person record creation/deactivation
- Department and manager hierarchy sync

**Calendar integration:**
- Room bookings sync to Outlook/Google Calendar
- Calendar events create reservation suggestions
- Free/busy awareness for room suggestions

**IWMS/BIM/CAD import:**
- Space hierarchy import from external facility management systems
- Floor plan data import
- Asset import from CMDB/ERP

**Access control / security system integration:**
- Integration with physical access control systems (badge readers, door controllers)
- Badge activation/deactivation linked to visitor check-in/check-out and employee onboarding/offboarding workflows

**Webhook connectors:**
- Outbound webhooks on domain events (ticket_created, approval_approved, etc.)
- Inbound webhooks for external event triggers
- Slack/Teams notifications via webhook

### Dedicated Database Tier (Enterprise)

- Provision dedicated Supabase project or self-managed PostgreSQL for enterprise clients
- Same application code, same schema — different connection target
- Tenant registry updated with dedicated connection config
- Migration runner for dedicated databases

### Deployment Rings

- Stable and canary deployment tracks
- Tenant registry records which ring each client is on
- Canary receives releases 1-2 weeks before stable
- Automated promotion from canary to stable after stability period

### Vendor Portal

- External-facing login for vendor teams
- Vendor sees only their assigned tasks
- Update status, add comments, upload attachments
- No access to queue browsing, asset registry, or location data
- Notifications on new task assignment and overdue reminders

### Interactive Floor Plans

- Upload floor plan images per floor
- Map rooms/desks/spaces to positions on the floor plan
- Employee can click a room on the map to book it
- Ticket detail shows location on floor plan
- Occupancy visualization (future)

### Offline Mobile Support

- Field technicians can view their task list offline
- Status updates queued and synced when connectivity returns
- Photo uploads queued for sync
- Read-only task detail available offline

### ITIL Change Management

- Change request type with risk assessment fields
- Change advisory board approval workflow
- Change windows and blackout periods
- Change calendar
- Post-implementation review workflow

### Admin AI

- Natural language workflow generation ("create a workflow for office moves with IT and FM tasks" → AI generates workflow in the builder)
- Form schema suggestions ("suggest fields for a parking access request")
- Configuration explanation ("why is this ticket routed to Team B?")
- Routing optimization suggestions based on historical patterns

### Internal Team Tools

**Platform-level admin view (cross-tenant)**
- Internal team can view all tenants and their status
- Filter logs and metrics by tenant for troubleshooting
- View tenant configuration state (which workflows, which request types, etc.)
- Not exposed to client admins — internal tooling only

**Configuration copy/export between tenants**
- Export a working configuration from one tenant as a template
- Import/adapt into another tenant during onboarding
- Speeds up multi-client onboarding with similar setups

---

## Beyond Phase 4

The following are acknowledged as potential future expansion areas but are explicitly beyond the Phase 4 scope. They may be built based on market demand and product evolution:

- **Predictive maintenance** — ML-based prediction of equipment failure based on ticket and maintenance history
- **Native mobile app** — dedicated iOS/Android apps if responsive web proves insufficient for field technicians or employees
- **Advanced occupancy intelligence** — sensor integration, real-time occupancy tracking, space optimization recommendations
- **Follow-the-sun support models** — time-zone-aware routing for global organizations with 24/7 support across regions
- **Sandboxed custom action plugins** — allow tenants to write constrained custom actions that execute within workflow nodes (requires security sandbox)

---

## Prioritization Guidance

Phase 4 features should be prioritized based on:

1. **Client demand** — which clients are asking for what? Email-to-ticket and calendar integration are typically high demand.
2. **Sales pipeline** — which features close deals? Enterprise dedicated database and SSO with specific providers are often deal-blockers.
3. **Operational impact** — which features reduce support burden? Knowledge base and satisfaction surveys improve self-service and quality signal.
4. **Revenue opportunity** — which features enable upsell? Dedicated database tier, vendor portal, advanced reporting.

Not all Phase 4 features need to be built. Some may never be needed. Build what clients and revenue demand.
