# Phase 2 — Workplace Platform

**Goal:** Expand from a ticket platform into a full workplace operations platform. Add booking, visitors, child tasks, and AI.

**Timeline estimate:** 6-8 weeks for 2 people. Primarily frontend work — backend APIs already exist.

**Depends on:** Phase 1 complete and first client migrated.

---

## New UI Screens

### Room & Desk Booking

**Booking search**
- Search by: date, time, duration, capacity, amenities (projector, video conferencing, whiteboard, etc.)
- Results show available rooms/desks matching criteria
- Filter by building/floor
- Calendar view option (see availability at a glance)

**Booking flow**
- Select room → confirm date/time → done (simple path)
- Amenity-filtered search ensures employees find the right room

**Recurring bookings**
- "Repeat weekly for X weeks" option during booking
- System checks availability for all occurrences, flags conflicts
- Manage series: cancel single occurrence or entire series

**My bookings**
- Employee's upcoming and past reservations
- Cancel/modify options

**Order catalog integration**
- After selecting a room, "Add to your booking" shows the catalog
- Browse categories (Food & Drinks, Equipment, Supplies, Services)
- Add items to cart with quantities
- Dietary notes for food items
- Running cost total
- Review + confirm creates reservation + linked order
- Catalog filtered by location availability and user role
- Reservation approval step if booking policy requires it (e.g., premium rooms, large capacity, certain locations)
- Order approval step if total cost exceeds configured threshold

### Visitor Management

**Visitor registration (employee view)**
- Pre-register a visitor: name, company, email, visit date, host, site
- Bulk registration for multiple visitors
- Notification to visitor with visit details

**Reception screen**
- Today's expected visitors (default view)
- Quick search by name
- Check-in: one-tap for pre-registered visitors
- Walk-in registration: minimal form (name, host, company)
- Badge assignment
- Host notification on check-in
- Check-out

**Host notification**
- In-app + email: "Your visitor [Name] has arrived at reception"

### Child Task Management

**Create child task button on ticket detail**
- Agent clicks "Add task" on a ticket
- Form: title, description, assign to team, interaction mode (internal/external), priority
- Child task appears in the "Tasks" section of the parent ticket
- Each child task has its own status, activity timeline, and assignment

**Parent ticket task overview**
- List of all child tasks with status indicators
- Click through to child task detail
- Parent status reflects aggregate (all resolved → parent can be resolved)

**External vendor task handling**
- Interaction mode toggle: internal / external
- External tasks: agent logs all vendor communication as activity entries
- No vendor login needed

### AI Employee Portal Assistant

**Chat interface in employee portal**
- Conversational input: "The AC in my office is broken" or "I need a room for 8 people Thursday"
- AI identifies intent, suggests request type, pre-fills form fields
- Employee confirms and submits
- AI can search room availability conversationally
- AI can look up ticket status: "What's happening with my office move?"

**Technical:**
- Vercel AI SDK `useChat` on frontend
- NestJS backend builds tenant-scoped prompts (request types, locations, rooms)
- LLM tool calls for create_ticket, search_rooms, lookup_ticket
- All interactions logged for audit

### Full Configuration Engine Admin UI

**Admin shell**
- Entity list on the left
- Type-specific editor in the center
- Draft/publish bar with version indicator
- Version history drawer (view past versions, diff, rollback)
- Audit log viewer

**Applies to all config types:**
- Request types
- Form schemas (full builder with all field types, sections, conditional logic, live preview)
- SLA policies
- Routing rules
- Notification templates
- Branding
- Terminology
- Booking rules and approval rules (policy management beyond SLA)
- Assignment policies

### Service Catalog Category Management (Admin)

- List, create, edit, reorder service catalog categories
- Set name, description, icon, parent category (one level nesting)
- Assign request types to categories
- Enable/disable categories
- Preview how the catalog looks to employees

### Catalog Item Management (Admin)

- List catalog items with filters (category, active/inactive, location availability)
- Create/edit catalog items: name, description, category, subcategory, price, unit, lead time, dietary tags, fulfillment team, availability rules (location, role, department restrictions)
- Upload item images
- Enable/disable items
- Asset pool linkage for equipment items

### Catering Coordinator / Fulfillment Team Views

**Fulfillment queue**
- Incoming orders filtered by category (catering team sees food & drinks, FM sees equipment, etc.)
- Today's orders, upcoming orders, filtered by status and delivery time
- Each order shows: delivery location, date/time, headcount, items, dietary requirements
- Quick status updates per line item (confirmed → preparing → delivered)

**Order detail**
- Full order breakdown with line items
- Dietary notes highlighted
- Linked reservation context (which room, which meeting)
- Cancellation flag if reservation was cancelled

**Catalog management (per team)**
- Catering team manages food & drink items
- FM team manages equipment items
- Each team only sees and manages their own category

### Standalone Order Flow

- Employee can browse and order from the catalog without a room booking
- Entry point on the employee portal ("Order supplies / services")
- Same cart experience as the booking-linked flow
- Specify delivery location, date, time manually
- Approval triggers if cost exceeds threshold

### Enhanced Notifications

**User notification preferences**
- Employee can toggle which event types trigger email vs. in-app vs. both
- Per-event-type control (ticket status changes, approval requests, visitor arrivals, etc.)

---

## Existing Screens Enhanced

### Service Desk Workspace

- Tags input on ticket detail (free-form labels)
- Watchers field (add people to follow a ticket)
- Saved filter views (save a filter as a named view, switch between views)

### Employee Portal

- Room booking entry point on the portal home
- Visitor registration entry point
- AI chat widget (floating or embedded)

### Reporting

- Reservation utilization (room/desk usage rates)
- Visitor volume per site
- Child task resolution metrics

---

## What Phase 2 Users Experience

**Employee:**
"I book a meeting room, add lunch for 10 and an extra beamer, all in one flow. I register my visitor for the same meeting. The AI helped me find the right room. Everything is in one place."

**Service desk agent:**
"A complex ticket came in. I created three child tasks — one for FM, one for IT, one for the vendor. I track them all from the parent ticket. The vendor task is external — I log my calls and emails on it. When all three are done, I resolve the parent."

**Reception:**
"I see today's visitors on my screen. When someone arrives, I tap their name, they're checked in, and the host gets notified automatically."

**Admin:**
"I open the config admin, edit a routing rule, preview the change, and publish. I can see the version history and roll back if something goes wrong."
