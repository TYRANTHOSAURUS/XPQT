# Plandate, Planning Board, and Preventive Maintenance — design

**Status:** Slice A shipped on `main`. Slice B (planning board) and Slice C (preventive maintenance) designed; not started. This doc is the source of truth for sequencing and open questions.

**Last updated:** 2026-04-30

---

## Why this exists

Three things were missing on tickets:

1. **A field for "when is the assignee planning to do this?"** — distinct from the SLA deadline (commitment) and `resolved_at` (actual). The desk had no way to record the assignee's commitment, so dispatchers, managers, and assignees all kept it in their heads.
2. **A surface to see all planned work in one place** — a planning board (resource calendar). Today every WO is an island; there is no view of "what does Tuesday look like for our team?" or "is this assignee overloaded?".
3. **A generator that fills the field automatically for recurring/preventive work** — the same field also unlocks CMMS-style preventive maintenance (HVAC quarterly check, fire-extinguisher annual, generator load test, etc.). Manual plandate is one slice; PM is the feature that pays for it.

Slice A solved (1). Slices B and C build on it.

---

## Slice A — Plandate field and edit control (SHIPPED)

### Schema (migration 00206 — applied to remote 2026-04-30)

```sql
alter table public.tickets
  add column planned_start_at timestamptz,
  add column planned_duration_minutes integer
    check (planned_duration_minutes is null or planned_duration_minutes > 0);
```

Plus four partial indexes for the planning-board lane queries:

- `idx_tickets_planned` — `(tenant_id, planned_start_at)` where set
- `idx_tickets_planned_assignee` — `(tenant_id, assigned_user_id, planned_start_at)`
- `idx_tickets_planned_vendor` — `(tenant_id, assigned_vendor_id, planned_start_at)`
- `idx_tickets_planned_team` — `(tenant_id, assigned_team_id, planned_start_at)`

### Concept boundaries (don't conflate)

| Field | Owns | Set by | Meaning |
|---|---|---|---|
| `sla_resolution_due_at` | SLA engine | `SlaService.startTimers` | Customer commitment / deadline |
| `planned_start_at` | Assignee or case team | `PATCH /tickets/:id/plan` | Assignee's intended start time |
| `planned_duration_minutes` | Assignee or case team | Same | Optional duration; renders spans on the board |
| `resolved_at` | Status transition | `update` when `→ resolved` | Actual completion |

A plan after the deadline is a red flag (the control surfaces the delta) but does not by itself breach SLA.

### API

- `PATCH /tickets/:id/plan` — body `{ planned_start_at: string|null, planned_duration_minutes?: number|null }`. Validates ISO + positive int. Clearing `start` clears `duration`. Emits `system_event` activity with `metadata.event = 'plan_changed'` + `previous` / `next`. Logs `ticket_plan_changed` domain event.
- `GET /tickets/:id/can-plan` — returns `{ canPlan: boolean }` so the UI can hide the affordance without a 403.

**No `note` field on the DTO.** Reasons / context for a plan change live in regular ticket comments — that's already the audit channel; a separate `note` would duplicate it.

### Permission gate — `TicketVisibilityService.assertCanPlan`

Narrower than the write gate. Allowed:

- WO `assigned_user_id` matches actor.
- WO `assigned_vendor_id` matches actor's vendor membership *(backend gate is exercisable; see Cross-cutting decisions for vendor-UI status)*.
- Actor is a team member of the WO's `assigned_team_id` **or** the parent case's `assigned_team_id`.
- Actor has a non-readonly role assignment whose domain + location scope matches.
- Actor has `tickets.write_all`.

Excluded: requesters, watchers, readonly cross-domain roles.

### Frontend

- `apps/web/src/components/desk/plan-field.tsx` — clickable summary row + popover. Calendar-clock icon, formatted summary (`"Tue, 30 Apr, 14:00 CEST"`), delta line below the row (`"2h after deadline"` red / `"1h before deadline"` muted).
- Popover contents: `DateTimePicker` (date + time), 6 duration preset chips (`15 min · 30 min · 1 h · 2 h · 4 h · 8 h`) + custom-minutes input, Save / Cancel / Clear.
- Hardcoded `Europe/Amsterdam` zone (Benelux is the only market today). DST-correct via `zoneOffsetMinutes` so saving "14:00 on a date" composes the right UTC instant whether it's CET or CEST.
- Mounted in `apps/web/src/components/desk/ticket-detail.tsx` as a new "Plan" `SidebarGroup` between Properties and SLA, **work-order detail only**. Disabled state when `!canPlan`.
- Backfill (past dates) is allowed — operators sometimes log "scheduled for last Tue, missed". `minDate={new Date(0)}` opts out of the picker's default future-only constraint.

### What's deliberately not done in Slice A

- Mobile / tap-target work on the desk control. Desk stays desktop. Mobile users get the portal (and, for vendors, the separate vendor-portal project).
- Surfacing plandate to the requester portal. Plans slip; the requester's contract is the deadline.
- Case-level rollup (showing earliest planned child on the parent case detail). Real future work; flagged.
- Conflict detection (plan A overlaps plan B for the same assignee). Belongs to Slice B once the board exists.

---

## Slice B — Planning Board (DESIGNED, NOT STARTED)

A resource calendar so dispatchers, managers, and assignees can see and reshape all planned work in one place.

### Why a resource calendar, not a Gantt

Workorders are mostly independent and short. Gantt earns its keep when tasks have dependencies and multi-day spans; that's not workorders. The right shape is the same as the existing room-booking scheduler: rows = resources, x-axis = time, items as blocks. Reuse the SchedulerLane primitives + the perf work from the scheduler-perf overhaul.

Gantt may earn its place later if cross-WO dependencies become a real workflow (e.g. "AV install blocked by electrician") — separate view, not the default.

### Open design questions (need answers before starting)

Each has a recommendation. Answer in one line per question; flip the ones you disagree with.

**Q1. Lane axis (rows).** What does a row represent?
- (a) Per-assignee (users + vendors + teams as separate lanes). Operator/dispatcher view.
- (b) Per-team (items inside coloured by assignee). Manager / capacity view.
- (c) Toggle between (a) and (b).
- **Recommend (c), default (a).**

**Q2. Time scale.**
- (a) Day-only (hour grid) — pixel-precise scheduling.
- (b) Week-only (day grid; items as bars across hours).
- (c) Day + Week toggle, Month deferred.
- **Recommend (c).** Day for scheduling; Week for capacity reads.

**Q3. Filters.**
- Match the existing tickets list filters (`TicketListFilters` shape): location, team, request type, status, requester, assignee, etc.
- Mandatory minimum: location (building/site), team, request type, status (open / all).
- **Recommend: reuse `TicketListFilters` so the mental model carries over.**

**Q4. Drag-to-reschedule.**
- (a) Yes — drag block to new slot; drag right edge to resize duration. Modest impl cost since the booking scheduler already has the primitives.
- (b) No — click block → opens the existing PlanField popover.
- **Recommend (a).** The board's whole point is fast rescheduling; click-to-open-popover is just the WO-detail flow on a different page.

**Q5. Route + nav.**
- **Recommend `/desk/planning`** as a sibling of `/desk/scheduler`, `/desk/tickets`, `/desk/bookings`. Top-nav entry.

**Q6. Unscheduled rail.**
- Should the board show *unplanned* WOs in a left-rail "Unscheduled" backlog you drag from?
- **Recommend yes.** That's the dispatcher's primary loop: queue → drag onto someone's lane.

**Q7. Bundles / parent cases.**
- Should the board also render parent cases that span multiple children?
- **Recommend no for v1.** Too much UI complexity. Filter `kind = work_order` only. Revisit when case-level rollup ships.

### Sketch of build sequence (post-decisions)

1. **Route + shell.** `/desk/planning` page with the SchedulerLane primitives (already in repo from the booking-scheduler perf work). Day view first.
2. **Read path.** New endpoint or extend `GET /tickets` with `planned_start_at_gte` / `planned_start_at_lte` window filters; stream by lane (assignee / team).
3. **Render.** Blocks coloured by status / origin; deadline overlay (vertical red rule when block extends past `sla_resolution_due_at`).
4. **Drag-to-reschedule.** Calls `PATCH /tickets/:id/plan` (existing endpoint) on drop. Optimistic update + rollback.
5. **Unscheduled rail.** Sidebar list of WOs with `planned_start_at IS NULL` matching current filters; drag onto a lane.
6. **Filters.** Lift `TicketListFilters` shape into board state.
7. **Week toggle, manager view (Q1c), capacity heatmap.** Layered after v1 lands.

### Out of scope for Slice B

- Mobile UX of the board. Desktop only — same rule as the rest of `/desk/*`.
- Surfacing the board to vendors. Vendor portal is a separate codebase.
- Conflict resolution flows (over-allocation warnings beyond visual overlap). Pencil-in for v1.5.

---

## Slice C — Preventive Maintenance (DESIGNED, DEFERRED)

The same `planned_start_at` field, populated automatically by a recurring-work generator. This is the CMMS feature: HVAC quarterly inspection, fire-extinguisher annual check, elevator monthly, generator load test, coffee machine descaling, etc.

### Why this matters

Preventive maintenance is CMMS table-stakes — Planon, Eptura, MaintainX, Fiix all ship it. For legacy replacement (memory: `project_legacy_replacement`), it's almost certainly Tier 1, not v2. Compliance use cases (regulated PM for fire / elevator / gas with proof-of-execution + certificates) are real moats against ticketing-only competitors. Worth slotting properly into the booking-platform roadmap rather than smuggling in.

### Minimum data model

```sql
create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  asset_id uuid references public.assets(id),                    -- per-asset PM
  asset_type_id uuid references public.asset_types(id),          -- or per-class fleet PM
  request_type_id uuid not null references public.request_types(id),
  recurrence jsonb not null,                                     -- RRULE or {interval, unit}
  next_run_at timestamptz not null,
  last_completed_at timestamptz,
  lead_days integer not null default 7,                          -- spawn N days ahead
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
  check (asset_id is not null or asset_type_id is not null)
);

alter table public.tickets
  add column origin text not null default 'reactive'
    check (origin in ('reactive', 'preventive', 'corrective')),
  add column maintenance_plan_id uuid references public.maintenance_plans(id);
```

### Generator

A nightly worker:

1. Selects active plans with `next_run_at <= now() + lead_days`.
2. For each: creates a WO with `ticket_kind = 'work_order'`, `origin = 'preventive'`, `maintenance_plan_id = plan.id`, `planned_start_at = plan.next_run_at`, `due_at` derived from request type SLA, `asset_id` set, request type set, **assignee resolved by the routing engine** (no separate routing path — PM benefits from existing routing rules).
3. Bumps `plan.next_run_at` per the recurrence rule.
4. On WO completion → updates `plan.last_completed_at`. If the operator finds defects, they spawn a child WO with `origin = 'corrective'` linked to the same plan (via `parent_ticket_id`).

### Permission gate for the generator

The generator runs as `SYSTEM_ACTOR`. It bypasses `assertCanPlan` per the existing convention (system actors skip visibility checks). Audit trail lands as the standard `system_event` activity with `metadata.event = 'plan_changed'` + a marker that it came from the generator.

### Compliance dimension (v1.5+, flagged not scoped)

Regulated PM (fire, elevator, gas) needs proof-of-execution: signed-off checklist, attached certificate, technician identity, photo evidence. Possible later add-ons:

- `maintenance_plans.compliance_kind` enum.
- A signed completion artifact attached on close (links into the existing GDPR-baseline audit infrastructure).
- A read-only compliance report per asset / per category with retention timers.

Not in scope of Slice C v1, but the schema above doesn't preclude it.

### Sequencing relative to Slice B

- Slice B can ship without Slice C — the board renders any WO with a plandate, regardless of origin.
- Slice C lands cleanly on top — once the generator populates the field, the board picks them up automatically. The only board-side change is **filter / colour by `origin`** so dispatchers can see preventive load distinct from reactive.

### Open questions for Slice C (answer when starting Slice C, not now)

- Should `maintenance_plans` carry assignee defaults (preferred team / vendor) that override routing? Or always defer to the routing engine?
- Recurrence representation: full RRULE (with EXDATE / RDATE) or just `{ interval, unit }` for v1?
- Multi-asset plans (one plan covers an entire HVAC fleet, generates N WOs each cycle)? Probably yes via `asset_type_id`, but UX needs design.
- How are PM plans authored? Per-asset on the asset detail page, or a dedicated `/admin/maintenance` index?
- Calendar adjustments: business-hours awareness on `next_run_at` (so nothing schedules itself for Saturday).

---

## Cross-cutting decisions (LOCKED)

These apply to all three slices and any future related work.

### Vendor portal is a separate codebase

Backend permission gates (`assertCanPlan` allowing `assigned_vendor_id`) are valid — they cover the cross-project API call. **Don't mount vendor-facing UI inside `apps/web/`.** If a feature notionally serves vendors, ship the desk-side first; queue the vendor mirror against the separate vendor-portal project. The daglijst stays inside XPQT (it's an operator/desk artifact, not the vendor portal proper).

Memory: `project_vendor_portal_separate_codebase`.

### Plandate is hidden from requesters

`tickets.planned_start_at` and `planned_duration_minutes` are operator/desk-only. Plans slip; the requester's contract is the deadline (`sla_resolution_due_at`). Following the same logic as hiding vendors from requesters (memory `feedback_hide_vendor_from_requester`):

- `apps/web/src/pages/portal/**` must not render these fields.
- Notifications/emails to requesters: include status + deadline, not plan.
- Desk and admin surfaces can show them freely.

Memory: `project_plandate_not_for_requester`.

### Plan-change context lives in comments, not a separate `note`

Operators explain *why* a plan moved by posting a normal internal comment. The activity timeline already does this; a separate `note` field would duplicate the audit channel.

### Desktop is desktop, mobile is the portal (or the separate vendor portal)

Don't degrade desk/admin UX (tap targets, popover-on-phone, "responsive" treatment) for mobile concerns. Mobile users have purpose-built surfaces:

- **Portal** (`/portal/*`) — already mobile-first.
- **Vendor portal** — separate codebase, mobile-first PWA by design.

If a real mobile use case for an internal-team field tech emerges, build a portal/vendor-portal variant — don't retrofit the desk component.

Memory: `feedback_desktop_separate_from_mobile`.

---

## Doc maintenance

This doc is sequenced ahead of code. **When Slice B starts, update §Slice B status from "designed" to "in progress" and append decisions taken from the open questions.** When Slice C starts, same treatment. When either ships, fold the operational details (endpoints, components, files) into `docs/assignments-routing-fulfillment.md` (already updated for Slice A) and demote this doc to historical/decision-record only.
