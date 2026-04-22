# Service Management Current-State Review

Date: 2026-04-20

Related docs:
- [Service Management Improvement Roadmap](./service-management-improvement-roadmap-2026-04-20.md)
- [Assignments, Routing, Fulfillment](./assignments-routing-fulfillment.md)
- [Visibility](./visibility.md)
- [Competitive Gap Analysis](./competitive-gap-analysis-2026-04-20.md)

## Purpose

This review captures the shipped state of Prequest's service-management product as it exists in the repo today. It is meant to give later agents a grounded starting point before they propose or implement improvements.

The review is intentionally code-backed. It focuses on:

- employee portal and intake
- service desk queue and operator workflow
- ticket detail and collaboration
- work orders and vendor fulfillment
- approvals, SLA, notifications, and workflow
- reporting, visibility, and migration-facing gaps

It does not review the legacy system. It reviews the current Prequest codebase and notes where that current state will block migration from the legacy product.

## Executive Summary

Prequest already has a stronger service-operations core than the UI first suggests.

The strongest parts today are:

- a clear `case` vs `work_order` model
- strong backend routing and dispatch foundations
- a rich ticket detail surface with useful inline editing and activity history
- solid SLA and business-hours administration
- a genuinely good workflow editor with validation and simulation

The biggest problem is not lack of core model. The problem is that the most important operator-facing surfaces are still under-productized.

The clearest pattern across the codebase is:

- engine capability is ahead of UI surface
- ticket detail is ahead of queue workspace
- admin foundations are ahead of governance and release safety
- portal navigation promises more than the portal currently ships

If the goal is "best service management for employee portal + desk + work orders + vendors", Prequest should not replace its current model with a generic helpdesk shape. It should productize the model it already has.

## Review Method

Reviewed code and docs included:

- portal pages in `apps/web/src/pages/portal/*`
- desk pages in `apps/web/src/pages/desk/*`
- ticket detail and work-order components in `apps/web/src/components/desk/*`
- request type, routing, SLA, business hours, vendor, notification, and workflow admin surfaces
- ticket, dispatch, workflow, reporting, notification, and config-engine backend services
- architecture docs already in `docs/`

## 1. Employee Portal And Intake

### What is already strong

- The portal home is a clean service-catalog entry point with searchable categories in `apps/web/src/pages/portal/home.tsx:55`.
- Category pages correctly map catalog categories to request types in `apps/web/src/pages/portal/catalog-category.tsx:33`.
- Request submission is driven by request type selection, shared dynamic fields, and bound fields such as asset and location in `apps/web/src/pages/portal/submit-request.tsx:94` and `apps/web/src/pages/portal/submit-request.tsx:288`.
- Intake already understands fulfillment shape. Asset and location pickers appear based on request-type configuration in `apps/web/src/pages/portal/submit-request.tsx:219` and `apps/web/src/pages/portal/submit-request.tsx:236`.
- The "My Requests" list already exposes status and SLA posture in `apps/web/src/pages/portal/my-requests.tsx:119`.

### What is thin or missing

- The portal nav advertises `Book a Room`, `Invite Visitor`, and `Order`, but those routes are placeholders that redirect back to `/portal` in `apps/web/src/layouts/portal-layout.tsx:38` and `apps/web/src/App.tsx:71`.
- The portal request list navigates to `/portal/my-requests/${ticket.id}` in `apps/web/src/pages/portal/my-requests.tsx:123`, but the router defines no matching detail route in `apps/web/src/App.tsx:67`. This is a shipped navigation defect.
- Dynamic forms do not yet support attachments. The file field is still a placeholder in `apps/web/src/components/form-renderer/dynamic-form-fields.tsx:161`.
- The current form renderer has no conditional show/hide logic or dynamic required logic. It renders fields, but it is not yet a guided smart intake experience.
- Portal search is category search only in `apps/web/src/pages/portal/home.tsx:66`. There is no knowledge base or unified search layer yet.
- Reservations, visitors, and ordering are not just missing features; they are already visible in navigation, which makes the gap customer-visible.

### Current judgment

Portal intake is directionally strong because it is already tied to request types, routing shape, and structured data. But it is not yet migration-safe for customers who expect request detail, attachments, knowledge, reservations, visitors, and order flows.

## 2. Service Desk Workspace

### What is already strong

- The desk uses a split queue/detail layout in `apps/web/src/pages/desk/tickets.tsx:297`.
- Ticket creation from the desk is reasonably strong, including requester, request type, source channel, asset, location, and shared form fields in `apps/web/src/components/desk/create-ticket-dialog.tsx:132`.
- The backend list endpoint already supports far richer filtering than the UI exposes, including status, priority, kind, assigned team, assigned user, requester, location, search, and `sla_at_risk` in `apps/api/src/modules/ticket/ticket.controller.ts:48`.

### What is thin or missing

- The queue page only exposes free-text search plus a basic table in `apps/web/src/pages/desk/tickets.tsx:133` and `apps/web/src/pages/desk/tickets.tsx:183`.
- Bulk action controls are mostly placeholders in `apps/web/src/pages/desk/tickets.tsx:144`. The UI exposes selectors but does not provide an operator-grade bulk workflow.
- The queue does not expose the backend's richer filters and does not offer saved views, queue presets, work-order specific views, keyboard-first triage, or real-time updates.
- The queue columns are narrow for real service management: title, status, priority, team, SLA, age in `apps/web/src/pages/desk/tickets.tsx:183`. There is no requester, location, vendor, waiting reason, request type, or routing trace column strategy.
- There is no explicit workspace mode for `cases` vs `work_orders`, even though the backend model depends heavily on that distinction.

### Current judgment

The desk queue is usable, but not yet a workspace agents can comfortably live in all day. This is the single clearest productization gap in the current service-management surface.

## 3. Ticket Detail And Collaboration

### What is already strong

- Ticket detail is one of the strongest parts of the current product.
- Title and description are inline editable in `apps/web/src/components/desk/ticket-detail.tsx:462`.
- Custom fields are rendered inside the detail view in `apps/web/src/components/desk/ticket-detail.tsx:486`.
- Work orders are visible directly from the parent case in `apps/web/src/components/desk/ticket-detail.tsx:508`.
- The activity timeline is useful and nuanced. It distinguishes internal, external, and system events and supports attachments in `apps/web/src/components/desk/ticket-detail.tsx:521`.
- The right-hand property pane already supports status, priority, waiting reason, team, assignee, requester, location, asset, labels, watchers, cost, vendor, and workflow links in `apps/web/src/components/desk/ticket-detail.tsx:842`.
- Waiting reason support is already present in `apps/web/src/components/desk/ticket-detail.tsx:881`.
- Vendor assignment is present when the interaction mode is external in `apps/web/src/components/desk/ticket-detail.tsx:1039`.

### What is thin or missing

- Ticket detail exposes strong case context, but the queue does not surface enough of that context before the click.
- There is no operator-facing routing trace in the main detail flow even though routing decisions are recorded in the backend.
- There is no integrated requester history, asset history, location history, or similar-ticket context in the current detail UI.
- There is no formal vendor conversation surface yet beyond ticket activities and vendor assignment metadata.

### Current judgment

Ticket detail is already ahead of many other areas of the product. The next desk improvements should build around this surface, not replace it.

## 4. Work Orders And Vendor Fulfillment

### What is already strong

- The architecture clearly separates `case` and `work_order` in `docs/assignments-routing-fulfillment.md:20`.
- Dispatch creates child work orders with SLA, routing, activity logging, and parent linkage in `apps/api/src/modules/ticket/dispatch.service.ts:66`.
- Dispatch can assign team, user, or vendor and can fall back to routing when explicit assignment is absent in `apps/api/src/modules/ticket/dispatch.service.ts:86`.
- Parent-case rollup behavior is part of the architecture in `docs/assignments-routing-fulfillment.md:224`.
- The sub-issues section is already useful in the UI, showing status, assignee, and SLA for child work in `apps/web/src/components/desk/sub-issues-section.tsx:149`.
- The add-sub-issue dialog is strong. It supports team, user, or vendor assignment plus explicit, inherited, or no SLA in `apps/web/src/components/desk/add-sub-issue-dialog.tsx:183` and `apps/web/src/components/desk/add-sub-issue-dialog.tsx:235`.

### What is thin or missing

- Routing rule admin cannot assign vendors today. The current admin UI only supports a single condition and team assignment in `apps/web/src/pages/admin/routing-rules.tsx:59`.
- Vendor identity is not yet formalized enough for a true vendor portal path. `docs/visibility.md:76` explicitly calls this out.
- The portal and desk do not yet expose a dedicated vendor inbox, vendor workspace, quote/ETA loop, or external completion workflow.
- The architecture doc still lists missing work around vendor assignment via rules and queue defaults in `docs/assignments-routing-fulfillment.md:497`.

### Current judgment

This is a real differentiator for Prequest. The model is stronger than the current product surface. The next step is not inventing a new fulfillment model; it is hardening and exposing the one that already exists.

## 5. Approvals, SLA, Business Hours, And Notifications

### What is already strong

- Request types can require approval and define approver teams in `apps/web/src/components/admin/request-type-dialog.tsx:345` and `apps/web/src/components/admin/request-type-dialog.tsx:357`.
- There is a dedicated approvals queue in `apps/web/src/pages/desk/approvals.tsx`.
- SLA policy admin is already solid. It supports response targets, resolution targets, business hours calendars, pause-on-waiting reasons, and escalation thresholds in `apps/web/src/pages/admin/sla-policies.tsx:115`.
- Business-hours admin supports working hours, holidays, and time zones in `apps/web/src/pages/admin/business-hours.tsx:170`.
- Notification templates are configurable per event type and per channel in `apps/web/src/pages/admin/notifications.tsx:135`.

### What is thin or missing

- The approvals workspace is minimal compared with the rest of the system. It is mostly a pending list, not a rich decision surface.
- Notification templates exist, but actual email handling is not fully productized. `NotificationService` currently marks email notifications as sent without a real delivery pipeline in `apps/api/src/modules/notification/notification.service.ts:69`.
- There is no inbound email-to-ticket or threaded email reply handling in shipped code. That remains planned in `docs/phase-4.md:25` and `docs/spec.md:2640`.

### Current judgment

SLA administration is in better shape than channels and approvals UX. Buyers evaluating service management will likely react positively to the SLA model and negatively to the current email/channel baseline.

## 6. Workflow And Config Governance

### What is already strong

- The workflow editor is materially good. It supports autosave, validation, simulation, publish/unpublish, palette, inspector, and keyboard shortcuts in `apps/web/src/pages/admin/workflow-editor.tsx:30`.
- The engine supports assign, update, notification, condition, create child tasks, approval, wait, timer, end, and HTTP request nodes in `apps/api/src/modules/workflow/workflow-engine.service.ts:114`.
- Workflow activity can be inspected through instance and event endpoints in `apps/api/src/modules/workflow/workflow.controller.ts:64`.

### What is thin or unsafe

- Publishing mutates the current workflow row instead of creating an immutable production snapshot in `apps/api/src/modules/workflow/workflow.service.ts:77`.
- Workflow versions are initialized at `1` in create and clone and are not incremented during publish in `apps/api/src/modules/workflow/workflow.service.ts:43` and `apps/api/src/modules/workflow/workflow.service.ts:109`.
- The editor itself warns that future edits apply on next advance after unpublish in `apps/web/src/pages/admin/workflow-editor.tsx:226`. That is a useful warning, but it also confirms release semantics are not yet strong enough for serious operational governance.
- Timer nodes persist resume metadata, but resumption is manual via `POST /workflows/instances/:instanceId/resume` in `apps/api/src/modules/workflow/workflow-engine.service.ts:270` and `apps/api/src/modules/workflow/workflow.controller.ts:59`.
- Execution is single-path. `advance()` selects one next edge rather than supporting true parallel orchestration in `apps/api/src/modules/workflow/workflow-engine.service.ts:85`.
- Request types are still direct CRUD in `apps/api/src/modules/config-engine/request-type.service.ts:38`, which breaks the broader goal of governed config release.

### Current judgment

Prequest workflow is not weak. The editor is one of the better surfaces in the product. The gap is release safety and runtime maturity, not editor usability.

## 7. Reporting, Visibility, And Operational Controls

### What is already strong

- The reports page gives a basic operational overview with status, priority, SLA, and team slices in `apps/web/src/pages/desk/reports.tsx`.
- The backend reporting service already provides overview, volume, SLA performance, team, and location summaries in `apps/api/src/modules/reporting/reporting.service.ts:9`.
- Ticket visibility has a documented and fairly thoughtful model in `docs/visibility.md`.

### What is thin or missing

- Reporting depth is still limited to high-level aggregates. There is no serious work-order, vendor, aging, reopen, throughput, or reassignment analytics in `apps/api/src/modules/reporting/reporting.service.ts:9`.
- `docs/visibility.md:73` notes that reporting remains tenant-wide rather than visibility-scoped.
- `docs/visibility.md:74` notes that bulk ticket update does not call `assertVisible`, which matches the current implementation in `apps/api/src/modules/ticket/ticket.service.ts:1064`.
- `docs/visibility.md:75` notes there is still no search endpoint.

### Current judgment

Operational reporting exists, but it is not yet strong enough to support a "best service management" claim. Visibility design is ahead of its full rollout.

## 8. Migration-Parity Implications

Migration risk is not only about missing deep modules. It also comes from visible product promises that currently dead-end.

The most important migration-facing gaps from this review are:

- portal nav exposes reservations, visitors, and ordering before those products exist
- request-detail navigation in the portal is broken
- attachments are missing from intake
- no email-to-ticket baseline yet
- no knowledge base or unified search yet
- vendor execution is strong internally, but external vendor-facing workflows are not yet productized

For legacy customers, these are not optional roadmap niceties. They are go-live blockers.

## 9. Bottom-Line Assessment

Prequest is already stronger in architecture than it is in surface polish.

Today it is best described as:

- strong service-operations core
- promising portal and desk
- strong work-order model
- partial workflow/runtime governance
- incomplete migration parity

The product is closest to winning when the evaluation emphasizes:

- employee request intake tied to real fulfillment
- case plus work-order execution
- vendor-aware dispatch
- routing clarity
- operational auditability

The product is weakest when the evaluation emphasizes:

- operator-grade queue workflow
- migration parity for reservations and visitors
- email and knowledge channels
- reporting depth
- governed config release and runtime safety

## 10. Immediate Fixes Before Larger Roadmap Work

These should be treated as immediate cleanup, not deferred strategy items:

1. Fix portal request-detail navigation.
2. Remove or gate placeholder portal nav items until the corresponding modules ship.
3. Decide whether the desk queue should default to `case` only, or expose first-class `case` and `work_order` views.
4. Wire real bulk actions or remove the placeholder controls from the queue until they are functional.
5. Make the product status of email notifications explicit while real delivery and inbound handling are still incomplete.

