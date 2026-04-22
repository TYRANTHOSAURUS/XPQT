# Workplace Booking, Visitors, and Hospitality Blueprint

Date: 2026-04-21

Related docs:
- [Spec](./spec.md)
- [Build Strategy](./build-strategy.md)
- [Service Management Improvement Roadmap](./service-management-improvement-roadmap-2026-04-20.md)
- [Competitive Gap Analysis](./competitive-gap-analysis-2026-04-20.md)

## Goal

Define the product shape for reservations, visitors, catering, equipment, and related workplace services so Prequest can become the strongest product in its segment without copying the fragmentation of legacy FMIS suites.

This should optimize for:

- one excellent employee flow
- separate operational lifecycles underneath
- strong reception and fulfillment operations
- safe configuration and workflow changes in production
- migration credibility for FM-heavy buyers

## Bottom Line

Prequest should not model everything as one giant reservation record.

Prequest should also not force users through separate disconnected tools for room booking, visitors, catering, and service setup.

The best product shape is:

- one integrated `Schedule meeting` / `Book space` experience for the common case
- separate linked records for `reservation`, `visit`, `order`, and fulfillment `ticket/work_order`
- an optional orchestration record for composite bookings
- role-specific workspaces for host, receptionist, service desk, and fulfillment teams
- one governed configuration and workflow release model across all of it

## Segment To Win

Do not position this as "broader than ServiceNow."

The winnable position is:

`the best workplace operations platform for mid-market organizations that need rooms, visitors, services, and vendor-aware fulfillment in one coherent system`

That means:

- simpler than ServiceNow
- more operationally coherent than TOPdesk
- more fulfillment-aware than pure workplace apps
- stronger on governance and execution than lightweight ESM tools

## What Competitors Actually Do

The current market pattern is consistent:

- `TOPdesk` is reservation-centric. It supports rooms, services, participants, and visitor registration from the reservation flow, but still exposes visitor registration and order-like capabilities as separate operating functions.
- `ServiceNow` uses one workplace experience with linked reservations, visitors, and workplace services, but visitors have their own lifecycle, own portals, and their own requirements model.
- `Eptura`, `Planon`, `Spacewell`, and `Facilio` present a unified hospitality or workplace story, but under the hood still separate booking, visitors, and work-order or service execution.
- `Jira Service Management` and `Freshservice` are useful references for service workflows and assets, but they are not the right north-star for hospitality-grade reservation and visitor operations.

The design decision for Prequest should therefore be:

- integrated entry point
- separate linked domain records
- stronger execution and governance than the market baseline

## Strong Parts Already In `spec.md`

The current spec already contains several decisions worth preserving.

### 1. Unified front door

This is correct and should stay.

`spec.md` is right that employees should be able to book rooms, invite visitors, request catering, and track work from one portal entry point without turning the UI into one cluttered screen.

### 2. Separate core entities

The spec is already directionally correct in separating:

- `Reservation`
- `Visitor`
- `Order`
- `Order Line Item`

That is a better foundation than a single mega-object.

### 3. Combined booking plus linked order model

This is one of the strongest parts of the current spec.

The idea that one booking flow creates:

- one reservation
- one linked order
- routed fulfillment per line item

is exactly the right shape for workplace hospitality.

### 4. Fulfillment-aware catalog

The unified order catalog in the spec is strong because it already treats food, equipment, supplies, and services as fulfillable operational items rather than static extras on a room booking.

### 5. Recurrence and per-occurrence handling

The spec is right to treat recurring reservations as first-class and not as a crude copy loop.

### 6. Reception-first visitor operations

The visitor section is also directionally right:

- preregistration
- walk-ins
- host notification
- check-in / check-out
- badge handling
- reception-friendly UI

### 7. Shared platform primitives

The spec is strongest when reservations and visitors reuse shared platform capabilities:

- approvals
- notifications
- routing
- assets
- spaces
- service catalog

That shared-core approach should be preserved.

## Product Principles

### 1. One front door, not one blob

Users should feel like they are scheduling one thing.

Operations should still see:

- a reservation
- one or more visitor invites / visits
- an order
- fulfillment work

### 2. Standalone flows still matter

Not everything starts with a meeting.

The product must support:

- room-only booking
- visitor-only preregistration
- standalone catering or service order
- walk-in reception
- desk and parking reservations

### 3. Each lifecycle keeps its own owner and status model

Visitors are managed by hosts and reception.
Reservations are managed by hosts, employees, and workplace teams.
Orders are managed by fulfillment teams and vendors.
Work orders are managed by agents and executing teams.

Those must not collapse into one status field.

### 4. Composite UX, explicit relationships

The user can schedule a meeting in one flow, but the data model stays relational and explainable.

### 5. Configuration safety is part of the feature, not an admin afterthought

Reservation rules, visitor requirements, service availability, notifications, and workflows all change live operational behavior. They must use draft, simulate, publish, version, and rollback semantics.

## Recommended Domain Model

### Core records

Keep these as first-class records:

- `reservations`
- `visitors`
- `orders`
- `order_line_items`
- fulfillment `tickets` / `work_orders`

### Add an optional orchestration record

Add a new optional parent record for composite workplace flows:

- `booking_bundles`

This is not the operational source of truth for room occupancy, visitor check-in, or service fulfillment.

It is the coordination object for:

- one combined user-facing booking summary
- shared timeline and notifications
- approval rollup
- calendar sync context
- edit and cancellation impact preview
- recurrence coordination

Create a `booking_bundle` only when the flow is composite or needs shared coordination.

Examples:

- room + visitors + catering: yes
- executive visit with room and security tasks: yes
- room-only booking: optional
- visitor-only preregistration: no
- standalone order: no

### Recommended `booking_bundles` fields

- `id`
- `tenant_id`
- `bundle_type` (`meeting`, `event`, `desk_day`, `parking`, `hospitality`, `other`)
- `requester_person_id`
- `host_person_id`
- `site_id`
- `primary_space_id`
- `start_at`
- `end_at`
- `timezone`
- `attendee_count`
- `external_guest_count`
- `status_rollup`
- `source` (`portal`, `calendar`, `desk`, `api`, `reception`, `agent`)
- `calendar_event_id`
- `config_release_id`
- `policy_snapshot`
- `created_at`
- `updated_at`

### Relationship model

- `reservations.booking_bundle_id` nullable
- `visitors.booking_bundle_id` nullable
- `visitors.linked_reservation_id` nullable
- `orders.booking_bundle_id` nullable
- fulfillment `tickets` / `work_orders`.booking_bundle_id nullable

Use both bundle and direct links where useful:

- `visitor -> reservation` helps front desk and host context
- `visitor -> bundle` helps composite summaries
- `order -> reservation` helps delivery context
- `order -> bundle` helps full booking timeline

## Recommended Changes To Existing Records

### Reservations

Current reservation shape is directionally correct but too thin for a best-in-market workplace module.

Add or plan for:

- `booking_bundle_id`
- `source`
- `calendar_event_id`
- `setup_buffer_minutes`
- `teardown_buffer_minutes`
- `check_in_required`
- `checked_in_at`
- `released_at`
- `policy_snapshot`
- `config_release_id`

Expand reservation status beyond the current minimal set:

- `draft`
- `pending_approval`
- `confirmed`
- `checked_in`
- `released`
- `cancelled`
- `completed`

`released` matters for no-show auto-release and occupancy analytics.

### Visitors

Current visitor shape is also directionally correct but needs stronger linkage and policy support.

Add or plan for:

- `booking_bundle_id`
- `linked_reservation_id`
- `expected_arrival_start_at`
- `expected_arrival_end_at`
- `visitor_type`
- `company_name`
- `host_notes`
- `reception_notes`
- `precheck_status`
- `precheck_completed_at`
- `policy_snapshot`
- `config_release_id`

Expand visitor status to support real operations:

- `draft`
- `pre_registered`
- `pending_approval`
- `approved`
- `checked_in`
- `checked_out`
- `cancelled`
- `no_show`
- `denied`

### Orders and line items

Orders should remain separate from reservations.

Add or plan for:

- `orders.booking_bundle_id`
- `orders.source`
- `orders.requested_for_start_at`
- `orders.requested_for_end_at`
- `orders.policy_snapshot`
- `orders.config_release_id`
- `order_line_items.linked_ticket_id` or `linked_work_order_id`
- `order_line_items.service_window_start_at`
- `order_line_items.service_window_end_at`

The line item to work-order link is important because "catering delivered" and "AV room setup complete" are execution events, not just cart states.

## UX Model

### 1. Primary flow: Schedule meeting

This is the default employee flow for the common case.

Steps:

1. Select time, duration, site, attendee count, and room criteria.
2. Choose a suggested room or desk.
3. Add optional modules:
   - visitors
   - catering
   - AV / equipment
   - room setup
   - parking
4. Review pricing, policies, and dependencies.
5. Submit once.
6. System creates linked records and returns one combined confirmation.

The user sees one booking summary.
Operations see separate records.

### 2. Standalone flow: Register visitor

Use for:

- guest without a room booking
- interview
- vendor visit
- contractor access
- walk-in preregistration

The host should still be able to optionally attach the visitor to:

- a reservation
- a bundle
- a space

### 3. Standalone flow: Order for a room or space

Use for:

- catering without room booking
- extra equipment for an existing reservation
- post-booking add-ons

### 4. Reception flow

Reception needs a dedicated board, not a generic list.

Views:

- expected today
- awaiting pre-check completion
- checked in
- checked out
- no-show
- denied / exception

Actions:

- check in
- check out
- collect missing data
- print badge
- notify host
- escalate to security or reception supervisor

### 5. Host workspace

Hosts need a lightweight, task-oriented view:

- upcoming bookings
- visitors requiring action
- room changes
- services at risk
- quick actions to add/remove visitors or edit a single occurrence

### 6. Fulfillment workspace

Do not hide hospitality work inside a generic queue.

Teams need service-specific views:

- room setup board
- AV setup board
- catering delivery board
- visitor support / reception exceptions

## Best-In-Market Interaction Rules

### Reservation edits

When a reservation changes, do not silently mutate downstream work.

Show impact preview:

- room change
- time change
- attendee count change
- recurrence scope
- services affected
- visitors affected
- approvals that must re-run

Actions should be:

- keep
- remap
- cancel
- re-approve

This should be clearer than ServiceNow and less hidden than legacy FMIS suites.

### Recurring series behavior

Every composite flow must support:

- edit this occurrence
- edit this and following
- edit entire series

Apply this to:

- reservation
- visitors
- services
- notifications

Never auto-create external guest invites for an entire series without explicit confirmation.

### Cancellation behavior

Do not hard-delete or blind-cascade.

Cancel should produce an explicit impact view:

- reservation cancelled
- linked visitors cancelled or retained
- linked services cancelled or remapped
- fulfillment tasks cancelled or converted
- notifications to send

### Room disruption behavior

If a room becomes unavailable:

- mark the reservation at risk
- suggest alternate spaces
- show which visitors and services are affected
- allow one-click move with service retention preview

This is a practical moat because many products are good at happy-path booking but weaker when real operations break.

## Workflow Model

### Use the existing workflow engine, but make it production-safe first

This module should not ship on a workflow model that mutates production definitions in place.

Required before broad rollout:

- immutable published workflow versions
- runtime version pinning
- timer resume scheduler
- config diff
- rollback
- impact preview

### Workflow templates to ship first

1. `standard_meeting_booking`
2. `meeting_with_visitors`
3. `meeting_with_catering_and_av`
4. `executive_guest_visit`
5. `interview_visit`
6. `contractor_visit`
7. `room_change_disruption`
8. `after_hours_or_high_security_visit`
9. `recurring_team_meeting`
10. `event_with_setup_and_teardown`

### Workflow triggers

Workflows should trigger from domain events, not only from one UI action.

Important events:

- `booking_bundle.created`
- `reservation.created`
- `reservation.updated`
- `reservation.cancelled`
- `visitor.created`
- `visitor.precheck_completed`
- `visitor.checked_in`
- `order.submitted`
- `order_line_item.at_risk`
- `approval.responded`
- `space.unavailable`

### Workflow actions

Support actions such as:

- create linked visitor records
- create or update orders
- create fulfillment tickets / work orders
- request approval
- wait for approval
- wait until service window
- notify host / guest / team
- escalate when preparation is late
- create fallback task on failure
- update bundle rollup state

### Failure behavior

Define which actions are blocking and which are best-effort.

Blocking:

- reservation conflict validation
- approval result
- mandatory visitor policy completion
- mandatory work-order creation for committed services

Best-effort with retry and alert:

- email notifications
- calendar sync
- badge printing calls
- guest Wi-Fi provisioning

## Configuration Model

### Make configuration release-driven

All of these should be on the same governed config lifecycle:

- request types
- room and desk booking policies
- visitor requirements
- approval policies
- service availability rules
- room setup and cleanup rules
- notification templates
- workflow templates
- routing rules
- SLA policies for fulfillment work

### Configuration object types

Recommended first-class config entities:

- `booking_policy`
- `visitor_policy`
- `approval_policy`
- `service_package`
- `service_availability_rule`
- `space_rule`
- `notification_template`
- `hospitality_workflow_template`
- `checkin_policy`
- `recurrence_policy`
- `buffer_policy`

### Rules dimensions

Policies should be rule-based across:

- site
- building
- floor
- space type
- reservation type
- requester department
- host department
- attendee count
- external guest count
- visitor type
- time window
- day of week
- total estimated cost
- VIP / high-security flag

### Config release flow

Required admin flow:

1. Draft changes.
2. Run validation.
3. Simulate against saved scenarios.
4. Preview impact.
5. Publish immutable release.
6. Pin new runtime instances to the release.
7. Roll back if needed.

### Saved simulation scenarios

Admins should be able to simulate:

- weekly team sync with coffee service
- customer visit with 3 external guests
- board meeting requiring reception and AV setup
- recurring booking with room change
- contractor visit after hours
- booking exceeding approval threshold

This is a meaningful differentiator because competitors often expose configuration, but not enough operational preview.

## Policy Recommendations

### Reservation policies

Support policies for:

- lead time and booking horizon
- max duration
- capacity tolerance
- mandatory check-in
- auto-release no-show window
- setup and teardown buffers
- recurring series limits
- who can book which spaces

### Visitor policies

Support policies for:

- preregistration requirement
- approval requirement
- required fields and documents
- NDA or policy acknowledgment
- arrival window rules
- host confirmation
- badge type
- escort required
- reception-only or self-service check-in

### Service policies

Support policies for:

- minimum notice
- cut-off times
- allowed delivery windows
- quantity limits
- location restrictions
- vendor routing
- approval thresholds
- service dependency rules

Example:

- coffee allowed for any room
- lunch buffet only for rooms above 6 people and 24-hour notice
- AV technician only for supported buildings

## Admin Surfaces

Ship dedicated admin surfaces for:

- spaces and reservability
- calendars and business hours
- booking policies
- visitor requirements matrix
- service catalog and service packages
- workflow templates
- notifications
- reception settings
- analytics and SLA views

Do not bury visitor requirements inside a generic form builder alone.
Do not bury hospitality logic entirely inside generic workflows alone.

Use purpose-built admin UIs backed by the shared config engine.

## Operational Workspaces

### Employee portal

Should expose:

- `Book a space`
- `Register a visitor`
- `Order services`
- `My bookings`
- `My visitors`

### Service desk

Should expose:

- booking exceptions
- approval queue
- disruptions
- hospitality at-risk views
- work-order rollups

### Reception

Should expose:

- expected arrivals board
- pre-check gaps
- badge and check-in actions
- host-notify actions
- visitor search

### Fulfillment teams

Should expose:

- date-based work board
- service windows
- room setup tasks
- delivery tasks
- issue escalation

## Notifications And Integrations

### Notifications

Core notifications:

- booking confirmation
- approval requested / approved / rejected
- visitor invite sent
- visitor pre-check incomplete
- visitor arrived
- room changed
- service at risk
- booking cancelled

### Calendar sync

Calendar is important, but it should not be the source of truth.

The source of truth stays in Prequest.
Calendar events mirror Prequest state.

### Access control and front-desk integrations

Design for connectors to:

- badge printing
- access control
- guest Wi-Fi
- digital signage / room panels

Treat these as integration actions attached to workflows, not as the workflow engine itself.

## Best-In-Market Differentiators For Prequest

If Prequest wants to be best in market, it should be better than competitors in these specific areas:

### 1. Change impact clarity

Before changing a booking, show exactly what else changes.

### 2. Safer admin operations

Versioned config and workflow releases with simulation and rollback should be stronger than the market mid-tier baseline.

### 3. Better execution visibility

Show one combined booking view with:

- room status
- visitor readiness
- service readiness
- work-order progress
- approvals

### 4. Better disruption handling

Handle room unavailability, late service prep, and visitor exceptions as first-class flows.

### 5. Better role-specific workspaces

Host, receptionist, and fulfillment users should each get a dedicated experience rather than one overloaded screen.

### 6. Better FM plus IT convergence

Use the existing routing, SLA, approvals, and work-order model as the execution engine for workplace services rather than building a disconnected booking silo.

## Delivery Strategy

Follow the repo's existing principle:

`phase the UI, not the architecture`

### Foundation first

Before exposing broad user-facing flows, finish:

- immutable workflow publish model
- automatic timer resume
- canonical config engine across request types, routing, policies, notifications, and workflows
- booking and visitor schemas with bundle linkage

### First shippable slice

Ship this first:

- room booking
- visitor preregistration
- linked catering / service order
- reception board
- host summary page
- approval support
- notifications

### Next slice

Add:

- recurring series management
- room change impact preview
- no-show release
- fulfillment team boards
- service packages
- stronger analytics

### Later

Add:

- AI-assisted planning
- calendar-driven meeting intent detection
- access control and badge integrations
- wayfinding and room panels

## Explicit Recommendations

### Do this

- Build one integrated meeting and hospitality flow.
- Keep reservations, visits, orders, and work orders as separate first-class records.
- Add an optional orchestration parent for composite bookings.
- Use the existing routing and fulfillment engine for service execution.
- Make workflow and config releases safe before broad module rollout.
- Build dedicated role workspaces.

### Do not do this

- Do not collapse all meeting data into one reservation object.
- Do not make visitors just an array on a reservation.
- Do not model catering and services as untracked notes on the booking.
- Do not ship this on mutable live workflow definitions.
- Do not force standalone visitor and order use cases through a room-booking flow.

## Definition Of Success

This module is successful when:

- an employee can schedule a meeting with room, visitors, and services in one clean flow
- reception can run expected arrivals without touching generic tickets
- fulfillment teams can work from service-specific boards
- admins can safely change policy and workflow behavior with preview and rollback
- a cancelled or changed booking does not create hidden downstream operational damage
- Prequest feels more coherent than FMIS suites and more operationally grounded than booking-only tools

## Source Notes

This recommendation is based on:

- existing repo direction in `docs/spec.md`, `docs/build-strategy.md`, and `docs/service-management-improvement-roadmap-2026-04-20.md`
- current official material reviewed on 2026-04-21 from:
  - TOPdesk reservations and visitor management
  - ServiceNow Workplace Reservation Management and Workplace Visitor Management
  - Eptura hospitality and visitor platform pages
  - Planon workplace services pages
  - Spacewell workplace reservations and service requests pages
  - Facilio workplace and visitor management documentation
  - Atlassian and Freshservice facilities and asset references
