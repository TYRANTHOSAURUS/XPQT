# Change Request Type on Existing Ticket — Design

**Status:** Draft
**Date:** 2026-04-21
**Scope:** Allow agents to change the `request_type_id` on a non-terminal parent ticket, cascading the change through workflows, child work orders, SLA timers, routing, and audit.

---

## 1. Problem

Today a ticket's request type is set once, at creation, and is effectively immutable. The API (`UpdateTicketDto` in `apps/api/src/modules/ticket/ticket.service.ts`) does not expose `ticket_type_id` as an updatable field, and the frontend renders it as read-only on the ticket detail page.

When a requester misclassifies a ticket at submission, or an agent's triage reveals the wrong classification, the current workaround is to close the ticket and create a new one — losing context, comments, and the requester's original submission thread. Agents need a first-class way to reclassify in place.

Reclassification has cascading effects because multiple subsystems key off request type:
- **Workflow** — the request type's `workflow_definition_id` drives what workflow runs and what child work orders are auto-created
- **SLA** — the request type's `sla_policy_id` drives which SLA timers attach
- **Routing** — `RoutingService.evaluate()` uses request type as a first-class input
- **Child work orders** — created by the workflow's `create_child_tasks` action, scoped to the original request type's expected fulfilment shape

A correct reclassification must coherently update all four.

## 2. Goals & non-goals

### Goals
- Agents (not just admins) can change a parent ticket's request type in place.
- All cascading subsystems update coherently in a single atomic operation.
- The agent sees a full impact preview before confirming — no blind destructive actions.
- A required free-text reason is captured, visible on the parent, on each affected child, and in the audit stream.
- The ticket's history (comments, original requester, creation context) is preserved.

### Non-goals (v1)
- Bulk reclassify across multiple tickets
- Undo reclassify as a single action (agent can reclassify back; audit records both)
- Reclassifying child work orders directly
- Forcing reclassify to a target request type that has no workflow AND no SLA
- Real-time conflict detection when two agents have the same ticket open (see §10)

## 3. Product decisions (settled before design)

Decisions captured from brainstorming, recorded here so the spec is self-contained:

1. **Workflows:** cancel in-flight workflow, start new.
2. **Child work orders:** close all existing children with reason. Confirmation dialog shows which children are in progress so the agent understands the impact.
3. **SLA:** stop old timers, start new. No carryover of elapsed time. Reclassification is flagged on the ticket for audit visibility, mitigating the SLA-reset gaming risk via transparency rather than clock math.
4. **Routing:** always re-run. If the previous assignee was a user, they become a watcher so they retain visibility. Vendors and teams are not added as watchers (not supported by the watcher model).
5. **Permissions:** any user with ticket write access — same gate as other ticket-mutating actions. No new permission introduced.
6. **UX:** itemized preview + required reason. Required reason is written in three places: `tickets.reclassified_reason` on parent, `tickets.close_reason` (prefixed) on each closed child, and the domain event payload.

## 4. Architecture

```
apps/api/src/modules/ticket/
├── reclassify.service.ts          NEW — computeImpact + execute
├── reclassify.controller.ts       NEW — /tickets/:id/reclassify{,/preview}
├── dto/reclassify.dto.ts          NEW — preview/execute DTOs
├── ticket.service.ts              unchanged public surface; private setRequestType() helper
└── ticket.module.ts               register new service + controller

apps/api/src/modules/workflow/
└── workflow-engine.service.ts     + cancelInstanceForTicket(ticketId, reason, actorId)

apps/api/src/modules/sla/
└── sla.service.ts                 + stopTimers(ticketId, reason)
                                   (existing queries updated to filter stopped_at is null)

apps/api/src/modules/routing/
└── routing.service.ts             + optional persistDecision: false mode on evaluate()

apps/web/src/components/desk/
├── reclassify-ticket-dialog.tsx   NEW — Sheet with three stages
├── reclassify-impact-panel.tsx    NEW — presentational impact preview
└── ticket-actions-menu.tsx        + "Change request type" item (create if absent,
                                     hoist existing overflow actions into it)

supabase/migrations/
└── 00039_reclassify_support.sql   NEW — schema changes (§5)
```

`ReclassifyService` mirrors the existing `DispatchService` pattern — thin controller, fat service, DI'd dependents. Lives in the ticket module because reclassify is fundamentally a ticket-level operation that orchestrates workflow/SLA/routing; it does not belong in any of those subsidiary modules.

## 5. Data model

Single migration file: `supabase/migrations/00039_reclassify_support.sql`.

### 5.1 `tickets` table

```sql
alter table tickets
  add column reclassified_at        timestamptz,
  add column reclassified_from_id   uuid references request_types(id),
  add column reclassified_reason    text,
  add column reclassified_by        uuid references users(id),
  add column close_reason           text;
```

`close_reason` is a generic "why was this closed" field, not reclassify-specific. Used here for cascaded child closures but available to any future close-with-context flow. Kept generic because scoping it (`reclassify_child_close_reason`) would preclude that reuse.

### 5.2 `workflow_instances` table

```sql
alter table workflow_instances
  add column cancelled_at       timestamptz,
  add column cancelled_reason   text,
  add column cancelled_by       uuid references users(id);

-- Extend workflow_instances.status to include 'cancelled'.
-- status is stored as text today, so no enum migration — a check constraint
-- update (if present) or no schema change at all (if free text) suffices.
-- Implementation verifies the exact shape and uses the minimum-change path.
```

### 5.3 `sla_timers` table

```sql
alter table sla_timers
  add column stopped_at      timestamptz,
  add column stopped_reason  text;

create index sla_timers_ticket_active_idx
  on sla_timers(ticket_id) where stopped_at is null and completed_at is null;
```

**Downstream code impact:** every query that reads "active SLA timers" must now filter `where stopped_at is null and completed_at is null`. This touches:
- The SLA minute cron (`apps/api/src/modules/sla/sla.service.ts`)
- The SLA escalation threshold cron
- `GET /sla/tickets/:id/crossings`

These updates are in scope for this feature's PR.

### 5.4 Domain events

`domain_events.event_type` is free-text (`00019_events_audit.sql`), so no enum migration is needed. The feature introduces two new values:
- `ticket_type_changed` — emitted on the parent ticket
- `workflow_cancelled` — emitted on the parent when a workflow is cancelled (used by reclassify today, available for other future cancellation flows)

The existing `ticket_closed` event payload gains two optional fields:
- `reason: string | null` — populated from `close_reason`
- `closed_by_reclassify: boolean` — set true when the close originates from a parent reclassification

`ticket_type_changed` payload:

```json
{
  "from_request_type_id": "uuid",
  "to_request_type_id": "uuid",
  "reason": "agent-supplied reason text",
  "cancelled_workflow_instance_id": "uuid | null",
  "new_workflow_instance_id": "uuid | null",
  "closed_child_ticket_ids": ["uuid", "..."],
  "stopped_sla_timer_ids": ["uuid", "..."],
  "new_sla_timer_ids": ["uuid", "..."],
  "previous_assignment": { "team_id": "uuid?", "user_id": "uuid?", "vendor_id": "uuid?" },
  "new_assignment":      { "team_id": "uuid?", "user_id": "uuid?", "vendor_id": "uuid?" },
  "previous_assignee_watched": true,
  "new_routing_rule": "rule name from RoutingService trace"
}
```

### 5.5 What is deliberately not added

- No `ticket_reclassifications` history table. The domain event + the `reclassified_*` columns on `tickets` are sufficient. Longitudinal analytics can reconstruct from the event stream.
- No `child_ticket_close_reasons` lookup table. `close_reason` is free text, consistent with how `waiting_reason` works today.
- No permission column on any table. Reuses the existing ticket-write gate.

## 6. API contract

Two endpoints on a new `reclassify.controller.ts`.

### 6.1 `POST /tickets/:id/reclassify/preview`

Read-only, idempotent. Safe to call on every request-type picker change. Backs the confirmation dialog.

**Request:**
```ts
{ newRequestTypeId: string }
```

**Response — `ReclassifyImpactDto`:**
```ts
{
  ticket: {
    id: string;
    current_request_type: { id: string; name: string };
    new_request_type: { id: string; name: string };
  };
  workflow: {
    current_instance: { id: string; definition_name: string; current_step: string } | null;
    will_be_cancelled: boolean;
    new_definition: { id: string; name: string } | null;
  };
  children: Array<{
    id: string;
    title: string;
    status_category: string;
    is_in_progress: boolean;
    assignee: { kind: 'user'|'vendor'|'team'; id: string; name: string } | null;
  }>;
  sla: {
    active_timers: Array<{ id: string; metric_name: string; elapsed_minutes: number; target_minutes: number }>;
    will_be_stopped: boolean;
    new_policy: { id: string; name: string; metrics: Array<{ name: string; target_minutes: number }> } | null;
  };
  routing: {
    current_assignment: { team?: {id,name}; user?: {id,name}; vendor?: {id,name} };
    new_decision: {
      team?: {id,name}; user?: {id,name}; vendor?: {id,name};
      rule_name: string;
      explanation: string;
    };
    current_user_will_become_watcher: boolean;
  };
}
```

The preview calls `RoutingService.evaluate(..., { persistDecision: false })`. Nothing is written.

### 6.2 `POST /tickets/:id/reclassify`

Executes the change.

**Request — `ReclassifyExecuteDto`:**
```ts
{
  newRequestTypeId: string;
  reason: string;                           // required, min 3, max 500
  acknowledgedChildrenInProgress?: boolean; // required true if preview shows
                                            // any is_in_progress child
}
```

**Response:** the full updated ticket payload, same shape as `GET /tickets/:id`, so the client can swap it into the React Query cache.

**Error responses:**
- `400` — same type as current, reason missing/too short, `acknowledgedChildrenInProgress` missing while WIP children exist
- `403` — caller lacks ticket write access (via `TicketVisibilityService.assertVisible`)
- `404` — ticket or new request type not found (scoped to tenant)
- `409` — ticket is `closed`/`resolved`, or concurrent reclassify detected (advisory lock)
- `422` — new request type has neither workflow nor SLA AND current has both (v1 rejects; future "force" flag will bypass)

### 6.3 Endpoint design choices

- **Separate preview and execute URLs**, not a `dryRun` flag on one URL. Two endpoints make intent unmistakable in logs and client code; dry-run flags are easy to misuse.
- **No change to `UpdateTicketDto`** or the generic `PATCH /tickets/:id`. Reclassify is a distinct operation with cascading side effects, not a field edit. Keeping the update path unchanged prevents accidental bulk updates from triggering reclassification.
- **No idempotency key.** The execute endpoint's first guard is `current_request_type_id !== newRequestTypeId`; duplicate submissions hit it and return 400.

## 7. `ReclassifyService.execute()` orchestration

### 7.1 Execution order

1. Load current ticket + new request type config (read).
2. Validate preconditions (read):
   - ticket not `closed` / `resolved`
   - `newRequestTypeId !== currentRequestTypeId`
   - new request type belongs to tenant and has `active = true`
   - caller has ticket write access (`TicketVisibilityService.assertVisible`)
   - if any child is in progress, `acknowledgedChildrenInProgress === true`
   - new request type isn't the "neither workflow nor SLA while current has both" v1-rejected shape
3. Compute impact snapshot (same logic as `computeImpact`). Yields: cancel-workflow-id, child-ids-to-close, timer-ids-to-stop, previous-assignee, new-routing-result.
4. **Single transactional write block** — a Postgres RPC `reclassify_ticket(...)` that wraps:
   - **4a.** Mark matched `workflow_instances` rows cancelled (id, reason, cancelled_by, cancelled_at).
   - **4b.** Close non-terminal child tickets — `status_category='closed'`, `close_reason="Parent ticket reclassified: <reason>"`, `closed_at=now()`, `closed_by=actor`.
   - **4c.** Stop active `sla_timers` — `stopped_at=now()`, `stopped_reason` = reclassify reason.
   - **4d.** Update parent ticket in a single statement: new `ticket_type_id`; `reclassified_at`/`reclassified_from_id`/`reclassified_reason`/`reclassified_by`; new `assigned_team_id`/`user_id`/`vendor_id` from routing result; `watchers` union previous user-assignee (if any).
   - **4e.** Insert new `sla_timers` rows per new policy's metrics, starting `now()`.
   - **4f.** Insert new `workflow_instances` row (status `running`, step = definition's start step).
   - **4g.** Insert `routing_decisions` row with rule trace (this time persisted).
   - **4h.** Insert `ticket_type_changed` domain event on parent; insert `workflow_cancelled` event if a workflow was cancelled.
   - **4i.** Insert one `ticket_closed` domain event per closed child (with `reason` and `closed_by_reclassify: true`).
5. Commit transaction.
6. **Post-commit, best-effort side effects** (outside the transaction):
   - Notifications — to previous assignee ("you're now watching"), new assignee ("new ticket assigned via reclassify"), and each vendor of closed child WOs.
   - Workflow engine post-start hooks — in particular `create_child_tasks`, which itself creates new child WOs per the new workflow definition via `DispatchService`.
7. Return the fresh ticket payload.

### 7.2 Why steps 4a–4i are one transaction

Half-done reclassifies are worse than no reclassify. Example failure: children closed but the workflow cancel fails — the ticket sits with closed children, still running the old workflow, in a confusing mixed state requiring manual cleanup. A single RPC keeps the whole write block atomic.

### 7.3 Why step 6 is outside the transaction

Notifications go to external providers and can fail transiently; workflow post-hooks like `create_child_tasks` do their own writes via `DispatchService`. Neither should roll back a successful reclassify. If a notification fails, we log and move on — the user sees the ticket reclassified, and the notification system has its own retry story.

### 7.4 Concurrency

- Preview is read-only, no locking.
- Execute acquires a per-ticket advisory lock at the top of the RPC: `pg_try_advisory_xact_lock(hashtext(ticket_id::text))`. Second caller gets 409 immediately rather than deadlocking or interleaving writes.
- Child tickets and timers are not separately locked. In-flight vendor updates on a child being closed lose to our close — which is the intended outcome.

### 7.5 Permissions

Server-side check: `TicketVisibilityService.assertVisible(ticketId, userId, 'write')`. This already covers participants (requester/assignee/watcher), operators matching role+scope, and the `tickets:write_all` override. Per product decision, no new permission is introduced.

Client-side: menu item hidden when the existing "can write this ticket" flag is false, identical to other mutating actions.

## 8. Frontend

### 8.1 Entry point

A "Change request type" item in the ticket detail page's actions menu. If the page currently exposes overflow actions inline, this feature adds `ticket-actions-menu.tsx` and hoists them in — inline mutating buttons on ticket detail are an anti-pattern we clean up as part of this work.

Menu item visibility:
- Hidden when ticket is `closed` or `resolved`
- Hidden when ticket is a child work order (reclassify operates on parents only)
- Hidden when caller lacks ticket write access

### 8.2 Dialog — `reclassify-ticket-dialog.tsx`

shadcn `Sheet`, right-side, wider than a `Dialog` (the impact preview is content-heavy). All form markup uses shadcn Field primitives per CLAUDE.md form rules (`<FieldGroup>` / `<Field>` / `<FieldLabel>` / `<FieldDescription>`).

**Stage 1 — Pick:** Current type shown; `<Select>` for new type, excluding current and only listing tenant-active types. `[Cancel]` / `[Preview →]`.

**Stage 2 — Preview + confirm:** Renders `<ReclassifyImpactPanel>` (see 8.3) followed by a required reason textarea. The **in-progress acknowledgement checkbox appears only when at least one child has `is_in_progress: true`**. Confirm button is disabled until reason length ≥ 3 AND (if shown) the checkbox is checked. `[← Back]` / `[Confirm reclassify]`.

**Stage 3 — Executing + result:**
- On confirm: button shows spinner, POST fires.
- On 2xx: sheet closes, toast confirms, React Query invalidates `['ticket', id]`, `['tickets']` (list), `['ticket-children', id]`, `['ticket-sla-crossings', id]`, `['ticket-activity', id]`.
- On 4xx: stage 2 stays open, inline error banner at top of sheet shows server message, button returns to ready.

### 8.3 `reclassify-impact-panel.tsx`

Pure presentational component. Props: `{ impact: ReclassifyImpactDto }`. Renders four labelled blocks: Workflow, Assignment, SLA, Child work orders. Children block uses a warning icon on in-progress rows and shows the vendor/assignee name so the agent sees *who* is currently doing work that will be interrupted.

### 8.4 Hooks

- `useReclassifyPreview(ticketId, newTypeId)` — React Query query, enabled only when dialog is in Stage 2 and `newTypeId` is set, `staleTime: 0` (always refetch — preview must reflect current state).
- `useReclassifyTicket(ticketId)` — React Query mutation wrapping the execute POST. On success, performs the invalidation set from 8.2.

### 8.5 Ticket detail changes

If `reclassified_at` is set, render a small muted inline badge below the request-type field: *"Reclassified from HVAC Maintenance · 2h ago"*. Hover tooltip shows reason. Click opens the activity panel scrolled to the `ticket_type_changed` event.

### 8.6 Out of scope for v1 UI

- Bulk reclassify across multiple tickets
- "Undo reclassify" button
- Real-time conflict banner when another agent is viewing the same ticket

## 9. Edge cases

| Scenario | Behavior |
|---|---|
| Ticket already `closed` or `resolved` | 409; menu item hidden |
| `newRequestTypeId` = current | 400 |
| New request type not found in tenant | 404 |
| New type has no workflow (current does) | Cancel current; no new workflow starts. Valid. |
| New type has no SLA (current does) | Stop old timers; no new timers. Valid. |
| New type has neither workflow nor SLA AND current had both | 422 in v1 |
| Parent has no children | Skip 4b. Preview: "No child work orders." |
| All children already closed | Skip 4b. Preview: "N children (all already closed — will not be modified)." |
| Current assignee is a vendor | No watcher addition (vendors aren't watchers). Audit event records it; vendor notified of child WO closures via existing path. |
| No current assignee | Nothing to preserve; re-route normally. |
| New routing result = same team/user as current | Still persist a `routing_decisions` row (traceability); no assignee change; no watcher addition. |
| Multiple running workflow instances on parent | Cancel all (defensive; shouldn't happen by invariant). |
| Actor loses permission between preview and execute | Execute re-checks via `assertVisible` → 403. |
| Two agents execute simultaneously | Advisory lock + current_type check → second gets 409. |
| New request type deactivated (`active = false`) between preview and execute | Execute's active-and-in-tenant check fails → 422. |
| Ticket is a child WO itself | 422 "cannot reclassify child work orders — reclassify the parent instead". UI hides the menu item on child WOs. |

## 10. Future improvements (explicitly deferred)

Tracked here so they're not lost and so reviewers of the v1 PR don't raise them as gaps:

- **Real-time conflict detection** when multiple agents have the same ticket open (currently second reclassify gets a 409 and the agent sees an error — acceptable for v1, but a pre-confirmation banner would be a better UX).
- **Bulk reclassify** for triage backlog cleanup.
- **Undo reclassify** as a single action, restoring the previous workflow, children, and timers. Complex — requires immutable snapshots per reclassify event.
- **"Force" mode for reclassify to a request type with neither workflow nor SLA** — gated advanced option, not in v1 UI.
- **SLA elapsed-time carryover** across compatible metrics (v1 does a fresh start; a future version might allow preserving first-response clocks when both old and new policies track them).
- **Reclassifying a child work order** to a different parent request type context — currently out of scope; the child's classification is inherited from dispatch.

## 11. Testing

### Backend

`apps/api/src/modules/ticket/reclassify.service.spec.ts`:
- Preview with typical parent case — asserts impact DTO shape and values
- Preview with no children / no workflow / no SLA on new type (each variant)
- Execute happy path — asserts parent updated, children closed with prefixed reason, workflow cancelled, old timers stopped, new timers started, domain events written
- Execute with in-progress child, without `acknowledgedChildrenInProgress` → 400
- Execute on closed ticket → 409
- Execute when new type equals current → 400
- Execute with insufficient permissions → 403
- Concurrent execute (advisory lock) — two calls in parallel, one wins, one gets 409
- Partial-failure simulation — force an error mid-RPC, assert full rollback (no orphaned state)

### Frontend

`reclassify-ticket-dialog.test.tsx` + `reclassify-impact-panel.test.tsx`:
- Stage transitions (pick → preview → confirm)
- Confirm button disabled when reason length < 3
- Confirm button disabled when WIP children exist and acknowledgement checkbox unchecked
- Error state rendering on 4xx responses (banner visible, stage 2 still open)
- React Query invalidations fire on success (assert the expected keys)

### Integration

At least one end-to-end test: seeded ticket with workflow + SLA policy + 2 children → reclassify via API → assert DB end-state matches expected shape (workflow row cancelled, children closed with prefixed reason, old timers stopped with reason, new timers active, parent's `reclassified_*` columns populated, domain events present).

## 12. Rollout

- Single migration `supabase/migrations/00039_reclassify_support.sql`. Push to remote following the CLAUDE.md checklist — user confirms before `db:push` (or the psql fallback if push auth is still broken).
- No feature flag. The work is additive — existing flows are unchanged if the new UI is never invoked.
- Ship as a single PR. Split only if review feedback suggests the migration needs to land earlier for coordination.

## 13. Documentation updates

Per the CLAUDE.md "keep the reference doc in sync" rules, this feature touches multiple reference docs. Updates land in the same PR:

- `docs/assignments-routing-fulfillment.md` — add a section on reclassification showing how the four-axis model handles a mid-life change: routing re-runs, ownership changes, execution (children) closes, visibility updates follow.
- `docs/visibility.md` — add a note that reclassify promotes the previous user-assignee to watcher, which is a new path for entering the Participants tier.
- Activity/audit documentation, if a canonical index exists, noting the two new event types.
