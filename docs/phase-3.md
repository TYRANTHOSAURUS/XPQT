# Phase 3 — Power Platform

**Goal:** Add the power features that differentiate the product — visual workflow builder, AI copilot, preventive maintenance, and advanced asset management.

**Timeline estimate:** 6-8 weeks for 2 people. Mix of frontend and targeted backend work (AI copilot, workflow builder canvas).

**Depends on:** Phase 2 complete. Multiple clients using the platform.

---

## New UI Screens

### Visual Workflow Builder

**React Flow canvas**
- [ ] Drag-and-drop nodes from a palette of 10 node types
- [ ] Connect nodes with edges (including conditional branches from Condition and Approval nodes)
- [ ] Properties panel per node type (configure assignment targets, conditions, templates, timers)
- [ ] Structural validation (connected graph, all branches handled, no orphans, no cycles)
- [ ] Visual preview of the entire flow

**Workflow management**
- [ ] List of workflows with status (draft/published), version, linked request types
- [ ] Create new workflow or edit existing (opens the canvas)
- [ ] Draft/publish with version history
- [ ] Impact preview before publish (which request types use this, how many active instances)
- [ ] Test mode: dry-run with sample ticket data

[ ] **Replaces Phase 1's template selection UI** — admins now design their own workflows visually instead of selecting from templates. Pre-built templates still exist as starting points that can be loaded into the builder and customized.

### AI Service Desk Copilot

**Sidebar panel on ticket detail**
- [ ] Automatically loads when agent views a ticket
- [ ] Contextual suggestions based on ticket content:
  - Suggested category and priority
  - Suggested routing (which team, based on historical patterns)
  - Summary of long ticket history (20+ activities → 3-sentence summary)
  - Draft response for the agent to review and edit
  - Similar past tickets and how they were resolved

**Actionable cards**
- [ ] Each suggestion is a card the agent can accept with one click
- [ ] "Apply category: HVAC Maintenance" → applies through normal ticket update flow
- [ ] "Route to: FM Team Building A" → triggers reassignment
- [ ] "Send response" → opens the response as a draft comment for review

[ ] **Never auto-applies** — agent is always in control. Every accepted suggestion is audit-logged.

### Preventive Maintenance

**Maintenance schedule management**
- [ ] Create schedule: name, description, recurrence (daily/weekly/monthly/quarterly/annual/custom)
- [ ] Link to: request type template, assigned team, location, asset
- [ ] Preview upcoming occurrences
- [ ] Enable/disable schedule

**Maintenance dashboard**
- [ ] Upcoming scheduled maintenance
- [ ] Overdue maintenance (ticket not completed before next occurrence)
- [ ] Schedule history
- [ ] Filter by building/asset type

**Auto-ticket generation**
- [ ] Scheduled jobs create tickets from templates
- [ ] Tickets enter the queue like any other ticket
- [ ] FM technicians see them in their mobile task list

### Pooled Asset Management

**Asset pool view**
- [ ] See all pooled assets of a type (e.g., all 5 portable beamers)
- [ ] Current status per asset (available / checked out to [person] until [date])
- [ ] Check-out history

**Return tracking**
- [ ] Overdue returns flagged
- [ ] Reminder notifications to borrower
- [ ] Escalation to team after configurable overdue period

**Integration with order catalog**
- [ ] When employee orders a catalog item linked to an asset pool, availability is checked against the pool
- [ ] Specific asset instance is reserved
- [ ] After fulfillment, asset shows as temporarily assigned
- [ ] After return, asset becomes available again

### Advanced SLA UI

**SLA detail on ticket**
- [ ] Multiple timer display (response SLA, resolution SLA, vendor SLA on child tasks)
- [ ] Pause/resume indicator (shows when clock is stopped and why)
- [ ] Business hours context (timer only ticks during working hours)

**SLA management dashboard**
- [ ] SLA performance by team, domain, location, request type
- [ ] Breach trends over time
- [ ] Near-breach alerts

---

## Existing Screens Enhanced

### Service Desk Workspace

- [ ] AI copilot sidebar (new)
- [ ] Cost field on ticket detail (for chargeback tracking)
- [ ] Satisfaction rating display (after employee rates)

### Employee Portal

- [ ] **Satisfaction survey**: after ticket resolution, employee sees a prompt to rate their experience (1-5 stars + optional comment). Rating stored on ticket. Configurable delay before prompt appears. Low ratings trigger notification to team lead. This is the full satisfaction survey feature — Phase 4 only adds scheduled report delivery for satisfaction trends.
- [ ] AI assistant improvements based on Phase 2 usage data

### Admin

- [ ] Visual workflow builder replaces template selection
- [ ] Maintenance schedule management section

### Reporting

- [ ] SLA deep-dive dashboard
- [ ] Maintenance schedule compliance (% on-time)
- [ ] Asset utilization (pooled assets: usage rate, overdue rate)
- [ ] Cost tracking by department (if cost field is populated)
- [ ] Vendor performance metrics (response time, resolution time, overdue rate for external/vendor child tasks)

---

## What Phase 3 Users Experience

**Admin:**
"I open the workflow builder, drag nodes onto the canvas, connect them with conditions and approvals. I test it with sample data. I publish. New tickets of that type now follow my custom workflow."

**Service desk agent:**
"I open a complex ticket with a long history. The AI copilot sidebar summarizes it in three sentences and suggests routing to FM Team Building A. I click 'Apply' — done. It also drafts a response to the requester that I review and send."

**FM Manager:**
"Preventive maintenance runs automatically. Every month, HVAC filter change tickets appear in the queue for each building. My technicians pick them up on their phones. I see on the dashboard which buildings are on schedule and which are overdue."

**Employee:**
"I booked a conference room and ordered an extra projector. After the meeting, I got a reminder to return it to the equipment room. The whole process was smooth."
