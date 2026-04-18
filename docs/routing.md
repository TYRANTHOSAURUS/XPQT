# Routing & Rerouting — Living Reference

**Status:** current as of 2026-04-18. Keep this updated whenever `RoutingService`, `ResolverService`, `UpdateTicketDto`, `ReassignDto`, or any endpoint that changes a ticket's assignee/scope changes. If you touch those files, update this doc in the same PR.

## Two-layer model

Ticket assignment is resolved in this order:

1. **Overrides** — admin-defined rows in `routing_rules`. First match wins. Intended for narrow, situational bypasses (e.g. "all HVAC requests from Building B go to vendor X").
2. **Resolver chain** — `ResolverService.resolve()` in `apps/api/src/modules/routing/resolver.service.ts`. Branches on the request type's `fulfillment_strategy`:
   - `asset` → asset's `override_team_id` → asset type's `default_team_id`/`default_vendor_id` → request type default → unassigned
   - `location` → `location_teams(space, domain)` → walk parent spaces → request type default → unassigned
   - `auto` → asset first, then location, then request type default
   - `fixed` → request type default → unassigned

Vendors are first-class assignees alongside teams and users. See `tickets.assigned_vendor_id`, `asset_types.default_vendor_id`, `location_teams.vendor_id`.

Every resolver run persists a row in `routing_decisions` with `{strategy, chosen_team_id, chosen_user_id, chosen_vendor_id, chosen_by, trace, context}`. The trace is the full reasoning tree.

Debug query:

```sql
select chosen_by, strategy, trace
from routing_decisions
where ticket_id = '…'
order by created_at desc;
```

## When the resolver runs

| Trigger | Where | Notes |
|---|---|---|
| Ticket create | `TicketService.runPostCreateAutomation` | Skipped if `ticket_kind = 'work_order'` or ticket already has an assignee |
| Approval granted | `TicketService.onApprovalDecision('approved')` | Delegates to `runPostCreateAutomation` |
| Manual reassign with rerun | `TicketService.reassign({rerun_resolver: true})` | Clears current assignment, re-evaluates, records new `routing_decisions` row |

The resolver **does not** run on generic `PATCH /tickets/:id`. Changing priority, status, tags, watchers, etc. does not re-route.

## Two ways to change an assignee today

Both exist on the backend. They differ in audit trail and intent.

### A. Silent PATCH — `PATCH /tickets/:id`

`UpdateTicketDto` (`apps/api/src/modules/ticket/ticket.service.ts:29`) accepts `assigned_team_id`, `assigned_user_id`, `assigned_vendor_id`. On change:

- Writes the ticket row.
- Posts a `system_event` activity (`assignment_changed`) and a `domain_events` row (`ticket_assigned`).
- **Does not** write a `routing_decisions` row.
- **Does not** require a reason.

Use when: bulk tooling, background jobs, or trusted system actions where a reason is meaningless.

### B. Audited reassign — `POST /tickets/:id/reassign`

`ReassignDto` (`apps/api/src/modules/ticket/ticket.service.ts:46`) requires a `reason` string. Two modes:

- **Manual** (`rerun_resolver: false | undefined`): caller supplies `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id`. Clears previous assignment, sets the new one.
- **Rerun resolver** (`rerun_resolver: true`): clears assignment, re-invokes `ResolverService.resolve()` with current `{location, asset, request_type, priority, domain}` (falls back to `asset.assigned_space_id` if `location_id` is null).

Either mode:

- Writes a `routing_decisions` row with `chosen_by: 'manual_reassign'` or `'rerun_resolver'`. In rerun mode, the resolver's own trace is appended after a `manual_reassign` step so both the human reason and the machine decision are captured.
- Posts an **internal-visibility** activity (not `system_event`) with the reason in the `content` field — it shows up in the ticket timeline as a note.

Use when: a human is making the call and the reason matters for audit/ops review.

**Frontend status (2026-04-18):** no web code currently calls `/reassign`. The sidebar (`apps/web/src/components/desk/ticket-detail.tsx`) uses `PATCH` for the Team dropdown, so today's assignee changes leave no `routing_decisions` trail. This is a known gap — see "Known gaps."

## What happens on status transitions

`TicketService.update` has two side-effects beyond writing the row:

- `status_category = 'resolved'` sets `resolved_at`; `= 'closed'` sets `closed_at`.
- `applyWaitingStateTransition` pauses or resumes SLA timers when `status_category` or `waiting_reason` changes, based on the SLA policy's `pause_on_waiting_reasons`.

Status changes do not re-route and do not touch request type / location / asset.

## What happens to SLA on reassignment

**Nothing.** Reassigning a ticket — via silent PATCH or `POST /tickets/:id/reassign`, manual or `rerun_resolver` — does not touch SLA timers. `due_at`, `sla_response_due_at`, `sla_resolution_due_at`, `sla_at_risk`, and breach timestamps all persist unchanged.

This is intentional and matches standard ITSM behavior: SLA is a promise to the requester, not to the assignee. Shuffling ownership internally does not reset the customer clock. If a ticket sat on the wrong team for three hours before reassignment, the new team inherits whatever's left of the window.

SLA pause/resume fires **only** on `status_category` or `waiting_reason` changes (`applyWaitingStateTransition` in `ticket.service.ts`). The per-minute `checkBreaches` cron in `sla.service.ts` is team-agnostic — it only looks at `due_at` and `paused` flags.

**Edge case worth knowing:** the business-hours calendar is attached to the **SLA policy** (`sla_policies.business_hours_calendar_id`), not the team. A 9–5 team and a 24/7 team working the same policy share the same business-minute calculation. There is no per-team calendar override today. If that matters for a product decision, it's a schema change.

## Scope fields — not editable today

`UpdateTicketDto` deliberately omits `location_id`, `asset_id`, `ticket_type_id`, `requester_person_id`. There is no endpoint to change any of them on an existing ticket. Changing them would have cascading effects:

| Field | Cascade if changed |
|---|---|
| `location_id` | Resolver result changes (location chain differs). SLA/workflow unaffected. |
| `asset_id` | Resolver result changes (asset override path differs). SLA/workflow unaffected. |
| `ticket_type_id` | Resolver **and** SLA **and** workflow all tied to request type. SLA policy, workflow definition, approval gate, fulfillment strategy all change. High-impact. |
| `requester_person_id` | No resolver impact but changes who receives external notifications. Probably should not be mutable — effectively recreating the ticket. |

Until a scope-rerouting flow is built, these fields remain read-only in the UI. If/when we build it:

- New endpoint (probably `POST /tickets/:id/rescope`) that accepts the new field(s) + a reason, re-runs the resolver, and for `ticket_type_id` changes, restarts SLA timers and potentially the workflow instance.
- `routing_decisions` row with `chosen_by: 'rescope'` so the audit trail explains why the assignee changed.

## Known gaps

Tracked here so nobody re-discovers them. Move an item to the "Resolved" section below once fixed.

1. **Sidebar assignee edits bypass the audit trail.** `TicketDetail` calls `PATCH /tickets/:id` for team changes. Should call `/reassign` with a reason (UI: prompt for reason, or provide a lightweight inline "why?" field). Assignee (user) and Vendor pickers don't exist in the sidebar at all yet.
2. **No scope-rerouting endpoint.** See table above.
3. **No workflow impact on request-type change.** When we build rescoping, decide whether in-flight workflow instances (`workflow_instances`) should be terminated and restarted or migrated.
4. **Bulk update does not re-route.** `PATCH /tickets/bulk/update` accepts the same DTO as single update — same silent-assignment behavior. If bulk reassignment needs to be audited, build a `/tickets/bulk/reassign` that wraps `/reassign`.
5. **Overrides are not re-evaluated on ticket updates.** If an admin adds a `routing_rules` row that would have matched an existing ticket, the existing ticket is unaffected until someone calls `/reassign` with `rerun_resolver: true`. This is intentional but worth knowing when debugging "why didn't my new rule fire."

## Keeping this doc current

Trigger points — if you edit any of these, update this doc:

- `apps/api/src/modules/routing/resolver.service.ts` — resolver order, trace shape
- `apps/api/src/modules/routing/routing.service.ts` — `evaluate`, `recordDecision`
- `apps/api/src/modules/ticket/ticket.service.ts` — `UpdateTicketDto`, `ReassignDto`, `reassign`, `runPostCreateAutomation`, `applyWaitingStateTransition`
- `apps/api/src/modules/ticket/ticket.controller.ts` — any new reroute/rescope endpoint
- Migrations that add/rename columns on `tickets`, `routing_rules`, `routing_decisions`, `location_teams`, `asset_types`

When adding a new endpoint that changes assignment or scope, add a row to the "Two ways to change an assignee" section or create a new section if it's a distinct flow (e.g. rescope).

## Resolved

_(Move items here with the date when a gap from above is closed. Keeps the doc honest about what was once broken and when it was fixed.)_
