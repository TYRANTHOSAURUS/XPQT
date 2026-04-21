# Service Management Improvement Roadmap

Date: 2026-04-20

Related docs:
- [Service Management Current-State Review](./service-management-current-state-review-2026-04-20.md)
- [Assignments, Routing, Fulfillment](./assignments-routing-fulfillment.md)
- [Visibility](./visibility.md)
- [Competitive Gap Analysis](./competitive-gap-analysis-2026-04-20.md)

## Goal

Make Prequest the best product in its segment for:

- employee portal intake
- ticket handling by the service desk
- work-order execution
- vendor-aware fulfillment

while also reaching enough migration parity that legacy customers can actually move.

That means the roadmap cannot be "service management first, FM later" and it also cannot be "copy the legacy product as-is." The right path is:

`migration parity on top of a better service-execution core`

## Product Strategy

### What to preserve

Do not flatten Prequest into a generic helpdesk.

The strongest things already in the product are:

- request-type-driven intake
- routing and fulfillment separation
- case vs work-order modeling
- dispatch with SLA and audit trail
- strong ticket detail

Those are the foundations to build on.

### What to change first

The main gap is productization, not concept.

The queue, portal completeness, reporting, config release safety, and vendor-facing execution all need to catch up to the underlying model.

### What "best" should mean

Prequest should aim to be:

`the best service-management platform for teams that coordinate internal staff and external vendors to deliver real-world workplace and support work`

That is more winnable than trying to out-breadth ServiceNow.

## Priority Order

1. Fix shipped defects and migration-facing dead ends.
2. Make configuration and workflow production-safe.
3. Upgrade the desk into an operator-grade workspace.
4. Productize the work-order and vendor model harder than competitors.
5. Reach migration parity on reservations, visitors, ordering, and related portal flows.
6. Deepen reporting, channels, and self-service.

## Workstream 0: Immediate Cleanup

### Objective

Remove obvious friction and broken paths before starting larger platform work.

### Work

- Fix the broken portal request-detail navigation.
- Hide or feature-flag `Book a Room`, `Invite Visitor`, and `Order` until the modules exist, or replace them with clear coming-soon states.
- Decide on first-class desk views for `cases` and `work_orders`.
- Either implement real bulk actions in the desk or remove the placeholder controls until they are functional.

### Done means

- no visible dead-end routes in the portal
- no broken click path from `My Requests`
- desk queue behavior is coherent and intentional rather than half-finished

## Workstream 1: Production-Safe Config And Workflow Releases

### Objective

Make the service-management core safe enough for serious operational use.

### Why this comes first

Reservations, visitors, ordering, routing, approvals, and notifications all increase config complexity. Shipping more modules before fixing governance will increase risk, not capability.

### Work

- Make request types, routing rules, SLA policies, notification templates, and workflows part of one governed config release model.
- Replace direct live CRUD on request types with versioned publish semantics.
- Change workflow publish from "mutate current row" to "create immutable released version".
- Add version diff, rollback, and impact preview.
- Add an automatic timer-resume scheduler for workflow instances waiting on timers.
- Decide which workflow state changes must halt execution on failure versus log-and-continue.
- Finish visibility rollout on reporting and bulk update paths.

### Done means

- config changes can be drafted, reviewed, published, and rolled back
- running workflow instances are tied to immutable released definitions
- timers resume automatically without manual API intervention
- reporting and bulk updates respect visibility rules

## Workstream 2: Operator-Grade Desk Workspace

### Objective

Turn the desk queue into a workspace agents can use all day.

### Work

- Add first-class queue filters for status, priority, request type, team, assignee, vendor, waiting reason, location, and SLA risk.
- Add saved views such as `My queue`, `Unassigned`, `At risk`, `Waiting on vendor`, `Waiting on requester`, `Work orders`, and `Today`.
- Add bulk actions that are actually wired end to end.
- Add keyboard-first triage flows.
- Add explicit `case` vs `work_order` workspace modes.
- Add live updates for queue freshness.
- Expose routing decisions, SLA posture, and fulfillment state directly in the queue.
- Add lightweight requester, asset, and location context previews without forcing every decision through full detail open.

### Done means

- agents can triage unassigned work quickly
- agents can manage queue slices without rebuilding filters every time
- work orders are not hidden inside a generic case queue
- bulk operations are safe, visible, and audit-friendly

## Workstream 3: Portal And Intake Baseline

### Objective

Make self-service credible for both new customers and migrating legacy customers.

### Work

- Add a real portal request-detail page with timeline, comments, attachments, and child-work visibility as appropriate.
- Add file attachment support to shared dynamic forms.
- Add conditional field logic and guided request-type-specific intake.
- Improve request confirmation and progress communication.
- Add a clearer distinction between service catalog browsing and direct request submission.
- Add knowledge and search later in this workstream, but do not block the basic portal fixes on that.

### Done means

- portal users can submit, review, and follow their own requests without broken links
- attachments work from both portal and desk intake
- form quality improves routing quality

## Workstream 4: Work Orders And Vendor Execution Moat

### Objective

Make Prequest visibly best-in-class at real-world service execution.

### Work

- Expand routing rules so they can assign vendors as well as teams.
- Support richer routing conditions than one field plus `equals`.
- Create a dedicated work-order queue view with work-order-first actions.
- Add vendor-facing status model improvements such as ETA, scheduled visit, quote required, waiting on material, completed, and rejected.
- Add external/internal comment separation that is obvious in both the model and UI.
- Add vendor SLA and cost reporting.
- Add vendor portal-lite or vendor inbox capabilities once vendor identity is formalized.
- Improve parent-case rollup transparency so agents can see why a case remains open.

### Done means

- vendor fulfillment is not just architecturally strong but operationally obvious
- routing can directly land work with the right external party
- parent and child work remain easy to understand

## Workstream 5: Approvals, Reporting, And Control Surfaces

### Objective

Move from "core flow exists" to "operations can run the service with confidence."

### Work

- Upgrade the approvals queue with richer entity context, requester context, and related ticket/work-order context.
- Add reporting for queue aging, reopen rate, reassignment, first response, resolution trend, work-order throughput, vendor performance, and SLA breach causes.
- Add visibility-safe reporting slices by team, request type, location, vendor, and asset.
- Add operational dashboards for desk managers, not just summary cards.

### Done means

- managers can see what is getting stuck
- vendor performance is measurable
- SLA failures can be traced back to causes instead of only counted

## Workstream 6: Migration-Parity Modules

### Objective

Ship the legacy-dependent modules required for customer migration without recreating the legacy architecture.

### Rule

Build for real customer usage, not theoretical legacy scope.

Every legacy customer should have a migration matrix with:

- module
- actually used today
- required at day-one go-live
- acceptable workaround
- phase-1 or later

### Reservations

Build reservations as a shared-core module, not as a disconnected calendar tool.

Reservations should connect to:

- requester and host identity
- locations and rooms
- approvals where needed
- linked fulfillment work where setup or services are required
- notifications and audit trail

### Visitors

Build visitors as a service flow, not just a guest list.

Visitors should connect to:

- host notifications
- optional approval
- expected arrival window
- reception check-in
- linked tasks where support or facilities work is needed

### Ordering

Treat ordering as fulfillment-aware service ordering, especially where vendor menus already exist.

Ordering should connect to:

- requester
- location and delivery context
- vendor
- approval rules
- work-order follow-up when fulfillment is not purely catalog-digital

### Done means

- legacy customers can migrate core day-one flows
- the new modules reuse shared people, location, routing, notification, SLA, and fulfillment primitives
- the architecture gets stronger as modules are added instead of more fragmented

## Workstream 7: Channels, Knowledge, And Search

### Objective

Reach baseline expectations for modern service management.

### Work

- Add real outbound email delivery.
- Add inbound email-to-ticket and threaded reply handling.
- Add knowledge base and unified search.
- Add later integrations for Teams, Slack, HR, calendar, and IWMS where they materially improve adoption or migration.

### Done means

- customers are not forced into portal-only intake
- self-service gets better before agents get involved
- email becomes a real channel rather than a placeholder status update path

## Recommended Sequence

### Phase A: 0-30 days

- Workstream 0
- start Workstream 1
- start the desk view split for `cases` and `work_orders`

### Phase B: 30-90 days

- finish Workstream 1
- deliver the first meaningful slice of Workstream 2
- deliver portal request detail and attachments from Workstream 3

### Phase C: 90-180 days

- deliver routing-rules v2 and work-order workspace from Workstream 4
- deliver reporting v2 from Workstream 5
- deliver migration-critical reservations and visitors MVPs from Workstream 6

### Phase D: after parity

- vendor portal-lite
- email-to-ticket
- knowledge and unified search
- more advanced integrations

## Agent-Ready Work Packages

These are the best next implementation chunks for later agents.

### WP-01: Portal Request Detail

Build `/portal/my-requests/:id` with timeline, status, SLA, visible activities, and linked child work where appropriate.

### WP-02: Attachments In Shared Dynamic Forms

Replace the current attachment placeholder in `DynamicFormFields` with real upload support shared by portal and desk.

### WP-03: Desk Views And Filters

Expose backend ticket filters in the desk UI and add saved views for `cases`, `work_orders`, `unassigned`, `at risk`, and `waiting on vendor`.

### WP-04: Real Bulk Actions

Wire queue bulk actions end to end, including visibility enforcement, validation, confirmation, and activity logging expectations.

### WP-05: Workflow Release Model

Introduce immutable workflow versions, proper publish semantics, rollback, and runtime/version pinning.

### WP-06: Timer Resume Worker

Add automatic timer wake-up for workflow instances waiting on `timer_resume_at`.

### WP-07: Routing Rules V2

Support multi-condition routing, more operators, and vendor assignment in the admin UI.

### WP-08: Reporting V2

Add aging, throughput, reopen, reassignment, work-order, and vendor analytics with visibility-safe queries.

### WP-09: Reservations MVP

Implement migration-grade room booking on shared people, location, approval, and notification primitives.

### WP-10: Visitors MVP

Implement migration-grade visitor flow with host notification, optional approval, and reception lifecycle.

## Likely Starting Points In The Repo

- `WP-01 Portal Request Detail`
  `apps/web/src/App.tsx`, `apps/web/src/pages/portal/my-requests.tsx`, `apps/web/src/pages/portal/*`, `apps/api/src/modules/ticket/ticket.controller.ts`
- `WP-02 Attachments In Shared Dynamic Forms`
  `apps/web/src/components/form-renderer/dynamic-form-fields.tsx`, `apps/web/src/pages/portal/submit-request.tsx`, `apps/web/src/components/desk/create-ticket-dialog.tsx`, `apps/api/src/modules/ticket/ticket.service.ts`
- `WP-03 Desk Views And Filters`
  `apps/web/src/pages/desk/tickets.tsx`, `apps/api/src/modules/ticket/ticket.controller.ts`, `apps/api/src/modules/ticket/ticket.service.ts`
- `WP-04 Real Bulk Actions`
  `apps/web/src/pages/desk/tickets.tsx`, `apps/api/src/modules/ticket/ticket.service.ts`, `docs/visibility.md`
- `WP-05 Workflow Release Model`
  `apps/api/src/modules/workflow/workflow.service.ts`, `apps/api/src/modules/workflow/workflow-engine.service.ts`, `apps/web/src/pages/admin/workflow-editor.tsx`
- `WP-06 Timer Resume Worker`
  `apps/api/src/modules/workflow/workflow-engine.service.ts`, `apps/api/src/modules/workflow/workflow.controller.ts`, background-job or scheduler entry points to be added
- `WP-07 Routing Rules V2`
  `apps/web/src/pages/admin/routing-rules.tsx`, `apps/api/src/modules/routing/*`, `docs/assignments-routing-fulfillment.md`
- `WP-08 Reporting V2`
  `apps/web/src/pages/desk/reports.tsx`, `apps/api/src/modules/reporting/reporting.service.ts`, `docs/visibility.md`
- `WP-09 Reservations MVP`
  `apps/web/src/layouts/portal-layout.tsx`, `apps/web/src/App.tsx`, shared people/location/request primitives, likely new reservation module files
- `WP-10 Visitors MVP`
  `apps/web/src/layouts/portal-layout.tsx`, `apps/web/src/App.tsx`, notifications, approvals, and likely new visitor module files

## What Not To Do

- Do not rebuild the product around a generic ticket-only helpdesk model.
- Do not let migration pressure recreate the legacy architecture one screen at a time.
- Do not add more configurable modules before config and workflow release safety improves.
- Do not treat vendor fulfillment as an edge case. It is one of the strongest reasons this product can win.

## Final Recommendation

The best next move is a parallel strategy:

- harden the service-management core
- upgrade the desk into an operator-grade workspace
- deliver migration-critical modules on the same shared execution model

If this sequence is followed, Prequest can become both:

- better than the legacy system for daily operations
- credible enough in module coverage to migrate existing customers
