# Plan B.2 — Transactional WO/case commands (survey + design)

> **Status:** planning. NO code, NO migrations. Produced during the B.0
> soak window so the implementation phase has a fully-scoped target
> when the user gives the go-ahead.
>
> **Reading order before implementation:** B.0 retrospective
> ([`b0-shipped.md`](./b0-shipped.md)) → CLAUDE.md "Multi-step writes
> are PL/pgSQL RPCs" → §1 of this doc → spec
> [`docs/superpowers/specs/2026-05-04-domain-outbox-design.md`](../superpowers/specs/2026-05-04-domain-outbox-design.md)
> §1 + §3.1 + §7.6 (canonical RPC pattern) → §10X (B.0's deferral list,
> which B.2 inherits in part).

---

## 0. Scope contract (read first)

**What B.2 covers.** Every multi-step write currently in TS on the
work-order + case command surface. Specifically:

- `apps/api/src/modules/ticket/ticket.service.ts`
- `apps/api/src/modules/ticket/dispatch.service.ts`
- `apps/api/src/modules/work-orders/work-order.service.ts`
- `apps/api/src/modules/sla/sla.service.ts` (escalation/reassign,
  `applyWaitingStateTransition`, `restartTimers`)
- `apps/api/src/modules/approval/approval.service.ts` — only the
  `target_entity_type='ticket'` path (booking already shipped in B.0.D.3;
  visitor_invite is a single-row CAS and is excluded).
- The booking-cancellation / standalone-order cascade reaches into
  `work_orders` (BundleCascadeService cancels work orders linked to
  cancelled order lines). Listed for visibility but explicitly
  **deferred** to Phase 6 §10X.1, because the cancellation surface is
  bigger than just the WO write.

**What B.2 does NOT cover.**

- Booking-cancellation cascade (§10X.1). Owned by Phase 6 hardening.
- Standalone-order creation (§10X.2). Same reason.
- Multi-room booking + service attach (§10X.3 / B.0 follow-up).
- Visitor pass assignment (§10X.3). Separate codebase.
- Recurrence-clone paths. Same.

**Architectural rule applied throughout.** From CLAUDE.md:

> If a feature has to write to ≥2 tables and any partial-write state
> is corrupting (cross-table invariants, FK chains, audit-trail
> integrity, outbox emit + domain mutation), the writes go inside one
> PL/pgSQL function called from TypeScript — NOT a sequence of
> supabase-js HTTP calls in TS.

**TS keeps:** input validation (UUID format / enum / range), permission
checks (visibility floor + per-action gates), tenant resolution,
deterministic UUID minting where needed, plan-assembly into jsonb.
**PG owns:** advisory lock → tenant validation of every FK ref →
state-machine check → atomic writes → outbox emit (if any) → return
outcome. Best-effort post-commit work (vendor email fan-out, slow
notifications) stays in TS via `OutboxService.emit()` per the B.0
pattern.

---

## 1. Survey — every multi-step write currently in TS

For each call site: signature, sequence of writes, side effects, the
failure mode if step N succeeds but step N+1 fails, and a severity
classification (`critical` | `important` | `nit`).

### 1.1 `TicketService.update()` (case-side)

`apps/api/src/modules/ticket/ticket.service.ts:881-1204`

**Signature:** `update(id, dto: UpdateTicketDto, actorAuthUid): Promise<Row>`

**Writes (in order):**
1. `tickets.UPDATE` (one row, multi-column) — line 1058.
2. `slaService.applyWaitingStateTransition(...)` if status_category /
   waiting_reason changed — wraps:
   - `sla_policies.SELECT` (read)
   - `sla_timers.UPDATE` (pause/resume)
   - `tickets.UPDATE` again (sla_paused / sla_paused_at / due dates)
3. `slaService.restartTimers(...)` if `sla_id` changed (currently
   throws BadRequestException at line 999 — case-side cannot change
   SLA today, so this branch is unreachable but kept for future
   re-enablement). Wraps:
   - `sla_timers.UPDATE` (complete existing)
   - `tickets.UPDATE` (clear SLA-derived columns)
   - `sla_timers.INSERT` (fresh timers)
   - `tickets.UPDATE` (new due dates)
4. `addActivity('status_changed' | 'assignment_changed' | 'priority_changed' | 'metadata_changed')`
   — `ticket_activities.INSERT`. One activity row per category, possibly
   3-4 total per call.
5. `logDomainEvent('ticket_status_changed' | 'ticket_assigned')` — multiple
   `domain_events.INSERT` rows.

**Failure modes if step N succeeds but step N+1 fails:**
- ✅ tickets row commits, SLA pause fails → DB has new status, SLA
  timer state stale. User sees success, SLA queue lies. **Critical:
  audit + monitoring divergence; SLA breach detection might fire late
  or not at all.**
- ✅ tickets row commits, activity row fails → row mutated but audit
  trail missing. **Critical: audit log lies.** This is the same hole
  the WorkOrderService methods explicitly call out as known debt.
- ✅ tickets row + SLA write commit, domain_events fails →
  notifications / downstream consumers don't fire. **Important.**
- ✅ tickets row + SLA + activity commit, second activity row fails →
  partial audit. **Important.**

**Severity:** `critical`. Two distinct corruption modes: SLA timer
divergence + audit divergence. Multi-field PATCHes (the desk UI
sends them constantly — status + priority + assignee in one save)
amplify the blast radius.

---

### 1.2 `TicketService.create()` + `runPostCreateAutomation()`

`ticket.service.ts:567-879`

**Signature:** `create(dto, options, actorAuthUid)`. Internal helper
`runPostCreateAutomation` is also called from `onApprovalDecision` and
the workflow engine via state transitions.

**Writes (in order):**
1. `tickets.INSERT` (the row itself) — line 588.
2. `addActivity('ticket_created')` — `ticket_activities.INSERT`.
3. `logDomainEvent('ticket_created')` — `domain_events.INSERT`.
4. *(if approval gate)* `tickets.UPDATE` to `awaiting_approval` /
   `pending_approval`.
5. *(if approval gate)* `approvalService.createSingleStep(...)` →
   `approvals.INSERT` + `domain_events.INSERT`.
6. *(if approval gate)* `addActivity('approval_requested')` — another
   `ticket_activities.INSERT`.
7. *(if no approval gate)* `runPostCreateAutomation` → routing →
   assignment write → SLA timers → workflow start. Each is a separate
   `tickets.UPDATE` + `routing_decisions.INSERT` + `sla_timers.INSERT`
   + `tickets.UPDATE` + `ticket_activities.INSERT` + workflow_engine
   side effects.

**Failure modes:**
- ✅ tickets.INSERT commits, addActivity('ticket_created') fails →
  ticket exists with no creation event. Visible everywhere except the
  audit feed.
- ✅ ticket created, approval row insert fails → ticket parked in
  `awaiting_approval` with no approval to grant. Stuck forever
  until a human notices.
- ✅ ticket created, routing succeeds, SLA fails → ticket assigned
  but no SLA timers. Silent breach later.
- ✅ ticket created, routing fails (caught + logged, fail-soft) → ticket
  unassigned, requesters confused. "Fail-soft" is a documented design
  choice today; B.2 should preserve that semantic but make sure the
  routing breadcrumb activity DOES land atomically with whatever wrote.

**Severity:** `critical` for the approval-gate path (parked-no-approval
is a user-visible "stuck" state that needs admin intervention). The
non-approval path is `important` — the row exists, downstream is
recoverable via cron + manual reassign.

---

### 1.3 `TicketService.onApprovalDecision()`

`ticket.service.ts:677-717`

**Writes:**
1. `tickets.UPDATE` (status + status_category + closed_at on reject;
   status='new' / 'new' on approve).
2. `addActivity('approval_rejected' | 'approval_approved')`.
3. *(approve only)* re-loads ticket and calls `runPostCreateAutomation`
   — see §1.2.

**Failure modes:** same shape as §1.2's post-create path, but the
hazard is sharper because the approval row is already `approved` /
`rejected` (committed by the approval CAS upstream). If `tickets.UPDATE`
fails after the approval row is approved, the ticket is stuck in
`pending_approval` with no path forward — admin must hand-edit or
the user re-clicks "approve" with a stale row.

**Severity:** `critical`. The approval path is the most fragile because
both sides (`approvals` + `tickets`) need to be consistent for the
desk UI to show the right thing.

---

### 1.4 `TicketService.reassign()`

`ticket.service.ts:1211-1376`

**Writes:**
1. *(rerun_resolver branch)* `tickets.UPDATE` clearing assignees →
   `routingService.evaluate()` → resolver-decision read.
2. `tickets.UPDATE` setting new assignment + status_category.
3. `routing_decisions.INSERT` audit row.
4. `addActivity('reassigned')` with the human reason.

**Failure modes:**
- ✅ Clear write commits, resolver fails → ticket left unassigned with
  status=`new`. UX limbo.
- ✅ Clear + new-assignment commits, routing_decisions write fails →
  audit silently missing. Operator sees the new assignment but
  there's no reason audit anywhere.
- ✅ Assignment commits, activity fails → reason text lost.

**Severity:** `critical`. Routing decisions are an operational audit
that admins use to debug "why did this ticket land here". Losing them
silently is the kind of bug that costs hours to root-cause.

---

### 1.5 `TicketService.bulkUpdate()`

`ticket.service.ts:1558-1605`

**Writes:** one `tickets.UPDATE ... WHERE id IN (...)`. Single
statement, atomic at the row level.

**Failure modes:** none beyond the single-row case. No activity rows,
no SLA churn — bulk update just splats fields onto N rows.

**Severity:** `nit`. The bigger concern is that it bypasses the
per-field audit emission entirely (no `metadata_changed` /
`status_changed` activities are written for bulk-PATCH'd rows). That's
a real audit drift but it's an existing UX choice, not a partial-commit
hazard. Worth flagging in §7.

---

### 1.6 `TicketService.createBookingOriginWorkOrder()`

`ticket.service.ts:1829-1934`

**Writes:**
1. `work_orders.INSERT`.
2. `ticket_activities.INSERT` (`booking_origin_work_order_created`).
3. `domain_events.INSERT`.

**Failure modes:** WO created, activity / domain event missing — the
work order exists but its provenance audit is incomplete.

**Severity:** `important`. This is called from a higher-level flow
(`SetupWorkOrderHandler`, B.0.E) which is itself the outbox handler
for setup-WO-create-required events. B.0 already wraps the
work_orders insert + the `setup_work_order_emissions` dedup row in
one RPC (`create_setup_work_order_from_event`, 00312). The activity +
domain event are NOT inside that RPC — they happen in TS after the
RPC returns. **B.2 should fold the activity + domain_event into the
RPC** so the post-commit window collapses to zero. Small scope, high
value (it's the first WO-write surface, sets the example for the
others).

---

### 1.7 `WorkOrderService.update()` (orchestrator)

`work-order.service.ts:158-406`

**Signature:** `update(workOrderId, dto: UpdateWorkOrderDto, actorAuthUid)`

**Writes:** dispatches to up to six per-field methods sequentially —
`updateSla` → `setPlan` → `updateStatus` → `updatePriority` →
`updateAssignment` → `updateMetadata`. Each is independently
non-atomic; the orchestrator's preflight closes the
**validation-failure** partial-commit hole but **NOT the runtime-error
mid-sequence partial commit**. The class itself documents this on
lines 213-234 (HONEST SCOPE NOTE).

**Failure modes (per orchestrator call):**
1. SLA branch commits → status branch fails (e.g. transient DB
   error) → user sees only SLA changed; status still old.
2. Status branch commits → priority branch fails → status committed
   without priority. Six independent UPDATE statements; any one of
   them can drop a connection mid-PATCH.
3. Within any branch: row commits, activity row fails (every method
   has `try { … } catch (err) { console.error(...) }` around the
   activity insert). Audit drift.
4. Within any branch: row commits, SLA timer write (status branch's
   pause/resume; SLA branch's restart) fails. Timer state stale.

**Severity:** `critical`. This is THE highest-traffic command surface
in the entire codebase (every desk-UI sidebar edit hits it). Multi-
field PATCHes (status + priority + assignee in one save) are the
norm, not the exception.

**Important nuance:** the per-field methods (`updateSla`,
`updateStatus`, `updateMetadata`, etc.) are ALSO directly callable
from controller endpoints (cron, workflow engine, SYSTEM_ACTOR
paths). When B.2 collapses these into one or more RPCs, the per-field
methods either need to (a) become thin wrappers around the same
RPC(s), or (b) get retired with their callers re-wired through the
orchestrator. (a) is the lighter touch; (b) is cleaner but bigger.
Recommended: (a) initially; (b) as part of §16.1 cleanup after the
RPC has soaked.

---

### 1.8 `WorkOrderService.updateSla()`

`work-order.service.ts:649-806`

**Writes:**
1. `work_orders.UPDATE` (sla_id + updated_at).
2. `slaService.restartTimers(...)` — wraps:
   - `sla_timers.UPDATE` (complete existing).
   - `work_orders.UPDATE` (clear SLA-derived columns).
   - `sla_timers.INSERT` (fresh timers if new policy).
   - `work_orders.UPDATE` (set new due dates).
3. `ticket_activities.INSERT` (`sla_changed`).

**Failure modes:**
- ✅ work_orders.UPDATE commits, restartTimers fails → sla_id changed
  but old timers still running OR new ones never started. **Critical:
  the SLA queue lies.**
- ✅ Both commit, activity fails → audit drift.

**Severity:** `critical`. Same SLA-divergence hazard as §1.1.

---

### 1.9 `WorkOrderService.setPlan()`

`work-order.service.ts:827-982`

**Writes:**
1. `work_orders.UPDATE` (planned_start_at + planned_duration_minutes
   + updated_at).
2. `ticket_activities.INSERT` (`plan_changed`).

**Failure modes:** plan committed, activity fails → audit drift.

**Severity:** `important`. Plan changes are operationally meaningful
(the assignee uses planned_start_at to schedule their day; missing
the audit hides a "was the plan moved?" question). Not a corruption
hazard, but a real audit gap that the WO file itself flags as known
debt.

---

### 1.10 `WorkOrderService.updateStatus()`

`work-order.service.ts:1032-1200`

**Writes:**
1. `work_orders.UPDATE` (status + status_category + waiting_reason
   + resolved_at/closed_at synthesis + updated_at).
2. `slaService.applyWaitingStateTransition(...)` — pauses/resumes
   timers based on policy's `pause_on_waiting_reasons`. Multi-write:
   `sla_policies.SELECT` + `sla_timers.UPDATE` + `work_orders.UPDATE`.
3. `ticket_activities.INSERT` (`status_changed`).
4. `domain_events.INSERT` (`ticket_status_changed`).

**Failure modes:** same SLA-divergence + audit-divergence hazard as
the case-side `update`. WO status transitions also affect parent-case
close eligibility (the parent close trigger reads child statuses) —
if the WO status commits but the activity / domain event miss, the
desk UI's "case can be closed" state is wrong.

**Severity:** `critical`.

---

### 1.11 `WorkOrderService.updatePriority()`

`work-order.service.ts:1211-1313`

**Writes:**
1. `work_orders.UPDATE` (priority + updated_at).
2. `ticket_activities.INSERT` (`priority_changed`).

**Failure modes:** priority committed, audit missing.

**Severity:** `important`. Single-row mutation + audit; same shape
as setPlan.

---

### 1.12 `WorkOrderService.updateAssignment()`

`work-order.service.ts:1329-1453`

**Writes:**
1. `work_orders.UPDATE` (assigned_team_id / assigned_user_id /
   assigned_vendor_id + updated_at).
2. `ticket_activities.INSERT` (`assignment_changed`).
3. `domain_events.INSERT` (`ticket_assigned`).

**Failure modes:** assignment committed, audit / domain event
missing → notifications fail to fire, audit is incomplete.

**Severity:** `critical`. Assignment changes drive notifications
(the assignee gets pinged); a missing domain_events row means the
new assignee never finds out they own the WO.

---

### 1.13 `WorkOrderService.updateMetadata()`

`work-order.service.ts:1474-1671`

**Writes:**
1. `work_orders.UPDATE` (title / description / cost / tags / watchers
   + updated_at).
2. `ticket_activities.INSERT` (`metadata_changed`).

**Failure modes:** metadata committed, audit missing.

**Severity:** `important`. Same audit-only drift class as setPlan +
updatePriority.

---

### 1.14 `WorkOrderService.reassign()`

`work-order.service.ts:1699-1869`

**Writes:**
1. `work_orders.UPDATE` (assignment + updated_at).
2. `routing_decisions.INSERT` (audit row, `chosen_by='manual_reassign'`).
3. `ticket_activities.INSERT` (`reassigned`, internal-visibility with
   the human reason in `content`).

**Failure modes:** identical shape to §1.4 (`TicketService.reassign`):
assignment commits, routing_decisions or activity miss → audit drift.

**Severity:** `critical`. Same reasoning as §1.4 — routing decisions
are operational audit.

---

### 1.15 `DispatchService.dispatch()`

`dispatch.service.ts:43-257`

**Writes:**
1. *(if no explicit assignees + has request_type)* routing evaluation
   (read-only, no writes).
2. `work_orders.INSERT` (the child WO row).
3. `routingService.recordDecision(...)` — `routing_decisions.INSERT`.
4. *(if resolvedSlaId)* `slaService.startTimers(...)` — wraps:
   - `sla_policies.SELECT`.
   - `sla_timers.INSERT` (one or two).
   - `work_orders.UPDATE` (sla_response_due_at / sla_resolution_due_at).
5. `addActivity('dispatched', on parent)` — `ticket_activities.INSERT`
   on the parent case (line 240).

**Failure modes (the dispatch surface is the canonical case of "the
v3-C{1..4} pattern that v5+ deleted"):**
- ✅ work_orders.INSERT commits, recordDecision fails → child WO
  exists with no routing audit. Operator sees a child appear with
  no breadcrumb of how/why.
- ✅ child created, SLA timers fail → child WO has sla_id=null even
  though resolveChildSla picked one. Silent breach later.
- ✅ child created + SLA timers committed, parent-case activity fails
  → parent's timeline doesn't show the dispatch event. Looks like
  the child appeared from nowhere.
- ✅ child created with a stale resolveChildSla result → race window
  if the rule changes between resolve + write (very low probability,
  but a combined-RPC closes it for free).

**Severity:** `critical`. Spec §10X.3 already lists this as a
deferred B.0 surface — B.2 picks it up. Dispatch is also called
from the workflow engine's `create_child_tasks` node
(`workflow-engine.service.ts:418`) — that path is system-actor and
loops over `tasks`, so the partial-commit hazard is multiplied per
task.

---

### 1.16 `SlaService.fireThreshold()` + `applyReassignment()`

`sla.service.ts:662-748` + `sla.service.ts:558-595`

This is the SLA escalation cron. Spec on the file itself (line 655)
says "Not atomic. Write order: reassign → activity → notify →
crossing → event." It already documents the failure mode and chose
to live with it.

**Writes (per threshold fire):**
1. *(if escalate)* `applyReassignment` — depending on target type:
   - `users.SELECT` (lookup person → user).
   - `tickets.UPDATE` OR `work_orders.UPDATE` via
     `updateTicketOrWorkOrder` (assigned_user_id / assigned_team_id
     + watchers).
2. *(if reassigned)* `ticket_activities.INSERT` (escalation activity).
3. `notifications.send*` (one or many — emails / persistent rows).
4. `sla_threshold_crossings.INSERT` (the idempotency anchor).
5. `domain_events.INSERT` (`sla_threshold_crossed`).

**Failure modes:**
- Reassign commits → activity fails → ticket reassigned silently.
- Reassign + activity commit → notifications fire → crossing INSERT
  fails (e.g. unique_violation on retry, currently swallowed for
  23505) → next cron tick re-runs, may notify again. The class
  comment notes this is "rare and the alternative is not justified
  at this scale."

**Severity:** `important`. The current code consciously trades atomicity
for cost. The class comment is honest about it. **B.2 SHOULD fold
this into a `fire_sla_threshold(...)` RPC** because it's structurally
the same shape as the dispatch RPC and the cost of the wrap is small.
Worth doing, but not the highest priority — the duplication window
on threshold crossings is small in practice, and the failure mode
is bounded (worst case: duplicate notification).

---

### 1.17 `SlaService.applyWaitingStateTransition()` and friends

`sla.service.ts:262-298`, `pauseTimers` 140-156, `resumeTimers` 180-230,
`restartTimers` 305-322, `startTimers` 73-125.

These are infrastructure called from §1.1, §1.8, §1.10. They are
**already non-atomic** internally (multiple writes, no tx). When
called from inside a B.2 RPC, the RPC's tx handles atomicity for
free. When called directly from cron / threshold-fire code paths,
they need their own atomic boundary.

**Severity:** `important` as standalone. The right model: extract the
SLA-mutating logic into one RPC (`mutate_sla_timers_for_entity(...)`)
that takes the (entity_id, transition_kind, payload) and does
everything atomically. Both the WO/case command RPCs (which need
SLA effects atomically) and the cron paths can call it.

---

### 1.18 `WorkflowEngineService.executeNode('create_child_tasks')`

`workflow-engine.service.ts:396-440`

Loops over `tasks` and calls `DispatchService.dispatch(...)` per
task. Each dispatch is a §1.15 multi-write. A partial failure
mid-loop leaves `[N committed children, M missing]`.

**Severity:** `critical`. This is the workflow-engine's primary side
effect. When a workflow has a `create_child_tasks` node with five
tasks and dispatch #3 fails, the workflow advances anyway (the
error is logged + swallowed at line 433) and the operator sees a
half-fanned-out workflow with no breadcrumb pointing at the missed
two. **Fix structurally:** the workflow engine call site becomes a
single `dispatch_child_work_orders_batch(...)` RPC that processes
all N tasks in one tx, returns per-task outcomes, and the engine
emits per-task `node_event` rows for the audit log.

---

### 1.19 `ApprovalService.respond()` (ticket branch)

`approval.service.ts:486-561`

The booking branch already shipped in B.0.D.3 via
`grant_booking_approval` RPC. The `target_entity_type='ticket'` branch
still does:

**Writes:**
1. `approvals.UPDATE` (CAS, status='approved'/'rejected').
2. `domain_events.INSERT` (`approval_approved` / `approval_rejected`).
3. `advanceChain(...)` — `approvals.SELECT` (chain steps lookup).
4. *(if ticket)* `ticketService.onApprovalDecision(...)` — see §1.3
   above (multi-step writes itself).

**Failure modes:**
- ✅ approvals CAS commits, domain_events fails → approval is decided
  but downstream notifications miss. Recoverable via cron.
- ✅ approvals + domain_events commit, ticketService.onApprovalDecision
  fails → approval row is `approved` but ticket is still
  `pending_approval`. **Critical:** same stuck-state class as §1.3.
  The catch+log on line 514-517 is honest about this.

**Severity:** `critical`. The fix is a `grant_ticket_approval(...)` RPC
mirroring `grant_booking_approval` — atomic CAS on approvals row +
ticket transition + activity rows + domain events.

---

### 1.20 Bundle-cascade WO closure (out of scope but listed)

`bundle-cascade.service.ts:142-153` — when a booking line is cancelled,
linked work orders are bulk-closed via
`work_orders.UPDATE ... WHERE linked_order_line_item_id = ?`. This
is one statement; what makes it multi-step is the surrounding
cancellation cascade (asset reservations, OLI, approvals, bundle
event). **Spec §10X.1 explicitly defers booking cancellation to
Phase 6.** B.2 leaves it.

---

## 2. Survey summary

| # | Surface | Severity |
|---|---|---|
| 1.1 | `TicketService.update` (case orchestrator) | critical |
| 1.2 | `TicketService.create` + automation | critical |
| 1.3 | `TicketService.onApprovalDecision` | critical |
| 1.4 | `TicketService.reassign` | critical |
| 1.5 | `TicketService.bulkUpdate` | nit |
| 1.6 | `TicketService.createBookingOriginWorkOrder` | important |
| 1.7 | `WorkOrderService.update` (orchestrator) | critical |
| 1.8 | `WorkOrderService.updateSla` | critical |
| 1.9 | `WorkOrderService.setPlan` | important |
| 1.10 | `WorkOrderService.updateStatus` | critical |
| 1.11 | `WorkOrderService.updatePriority` | important |
| 1.12 | `WorkOrderService.updateAssignment` | critical |
| 1.13 | `WorkOrderService.updateMetadata` | important |
| 1.14 | `WorkOrderService.reassign` | critical |
| 1.15 | `DispatchService.dispatch` | critical |
| 1.16 | `SlaService.fireThreshold` (escalation cron) | important |
| 1.17 | `SlaService` waiting-state / restart helpers | important |
| 1.18 | `WorkflowEngineService.create_child_tasks` (loop) | critical |
| 1.19 | `ApprovalService.respond` (ticket branch) | critical |
| 1.20 | Bundle-cascade WO closure | (out of scope) |

**Critical count: 10. Important count: 6. Nits + out-of-scope: 4.**

The critical 10 collapse into **6 logical command surfaces** because
several are aspects of the same abstraction:

1. **Status transition** (cases + WOs) — §1.1 status branch + §1.10.
2. **Assignment / reassignment** — §1.1 assignment branch + §1.4 +
   §1.12 + §1.14.
3. **SLA reassignment** — §1.1 sla branch (currently disabled) + §1.8.
4. **Dispatch** (case → child WO) — §1.15 + §1.18 (the workflow loop).
5. **Approval grant on ticket target** — §1.3 + §1.19.
6. **Ticket create with approval gate / automation** — §1.2 (the two
   sub-paths).

Plus the 6 "important" surfaces (plan, priority, metadata, booking-
origin WO create, threshold-fire, SLA helpers) which fold into the
above as additional jsonb-payload variants OR get their own thin
RPCs.

---

## 3. Design — combined-RPC architecture per surface

For each surface: signature, body sketch, idempotency model, what stays
in TS, compensation. Numbering aligns with the §2 collapse.

### 3.1 RPC `transition_entity_status(p_entity_id, p_entity_kind, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.1 status branch (ticket) + §1.10 (WO). One RPC, two
entity_kind values: `'case'` writes `tickets`; `'work_order'` writes
`work_orders`.

**Signature:**
```sql
create or replace function public.transition_entity_status(
  p_entity_id        uuid,
  p_entity_kind      text,        -- 'case' | 'work_order'
  p_tenant_id        uuid,
  p_actor_user_id    uuid,        -- nullable for SYSTEM_ACTOR
  p_idempotency_key  text,
  p_payload          jsonb        -- { status?, status_category?, waiting_reason? }
) returns jsonb
language plpgsql
security invoker
```

**Body sketch:**
1. Advisory xact lock keyed on `(p_tenant_id, p_idempotency_key)`.
2. command_operations idempotency gate (see §3.7 below) — same
   pattern as `attach_operations`; returns cached_result on hit.
3. SELECT current row from the right table (FOR UPDATE) using
   `p_entity_kind`.
4. Compute diff (current vs payload), no-op fast-path if empty.
5. Validate state-machine transition (close-guard for cases — open
   children check; close-guard for WOs is enforced by the parent-
   close trigger 00134; reopen invariants).
6. Synthesize resolved_at / closed_at if entering terminal state.
7. UPDATE the row.
8. Compute SLA pause/resume — inlined here, no RPC-call-to-RPC.
   - Read sla_policies.pause_on_waiting_reasons (tenant-scoped).
   - UPDATE sla_timers (paused / paused_at OR cleared paused-state
     + recomputed due_at — business-hours math has to come back to
     TS via `OutboxService` because PG can't easily do business-
     hours arithmetic; OR encode as an outbox event handled by a
     dedicated SLA worker).
9. INSERT into `ticket_activities` (status_changed event).
10. INSERT into `domain_events` (ticket_status_changed).
11. UPDATE `command_operations` to outcome='success' with
    `cached_result`.

**Open question:** the business-hours arithmetic for SLA resume
currently lives in TS (`BusinessHoursService.addBusinessMinutes`).
Two options:
  - **(a)** Port the calendar math to PL/pgSQL (one helper). One-
    time cost; lets the RPC be fully atomic.
  - **(b)** Emit an outbox event `sla.timer_recompute_required` and
    let the existing TS worker handle it asynchronously. Mirrors the
    setup-WO pattern from B.0.E.

Recommendation: **(b)**. Lower risk, follows the established B.0
precedent. The downside (eventual consistency on resume due-date)
is bounded — a few seconds — and nothing reads the resumed due-date
during the gap (the `paused=false` flag flips first; the due-date
is a derived display value).

**Idempotency:** standard `command_operations` row. Same key + same
payload returns cached_result; same key + different payload raises
`command_operations.payload_mismatch`.

**TS plan-build phase:**
- DTO normalization (waiting_reason `null` vs `undefined`).
- Permission checks (visibility floor + `tickets.change_priority` if
  priority is part of a combined call — but priority isn't in the
  status RPC; see §3.6).
- Mint `idempotency_key = transition.<actor>:<entity_id>:<requestId>`
  per the B.0 X-Client-Request-Id pattern.

**Compensation:** none. The RPC is fully atomic. Notifications are
post-commit best-effort via outbox.

---

### 3.2 RPC `set_entity_assignment(p_entity_id, p_entity_kind, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.1 assignment branch + §1.4 + §1.12 + §1.14. One RPC
covers both "silent PATCH" assignment changes AND the
`reassign-with-reason` variant (the latter passes `reason` + optional
`actor_person_id` in `p_payload`).

**Signature:** identical to §3.1, with `p_payload` shape:
```jsonc
{
  "assigned_team_id":   "uuid|null",   // optional, undefined = no change
  "assigned_user_id":   "uuid|null",
  "assigned_vendor_id": "uuid|null",
  "reason":             "string?",     // present → reassign mode
  "actor_person_id":    "uuid?",       // for reason-attribution
  "rerun_resolver":     true           // optional; case-side only
}
```

**Body sketch:**
1. Advisory lock + command_operations gate.
2. SELECT current row (right table per entity_kind).
3. Validate every non-null assignee FK is tenant-owned (calls
   `validate_assignees_in_tenant` helper — new, sibling to the
   existing TS `validateAssigneesInTenant`).
4. Compute diff. No-op fast path.
5. *(if rerun_resolver)* — defer to TS via outbox event
   `routing.rerun_required` (resolver depends on routing rules,
   asset/space-group expansion, scope overrides — too much to port
   to PG). The RPC itself rejects the dto by raising; TS handles the
   resolver-rerun as a higher-level orchestration that invokes this
   RPC twice (once to clear, once to set with the resolver result).
6. UPDATE the row (assignment columns + status_category if
   `'assigned'` per inheritance, + updated_at).
7. *(if reason present)* INSERT into `routing_decisions` (audit row,
   `chosen_by='manual_reassign'`).
8. INSERT into `ticket_activities` (assignment_changed | reassigned
   event with reason).
9. INSERT into `domain_events` (ticket_assigned).
10. UPDATE command_operations.

**Open question:** assignment changes don't always trigger SLA
churn (the case-side `update` does NOT touch SLA on assignment;
only on status / sla_id). Confirmed in code review: §3.2 stays
SLA-free.

**TS plan-build phase:**
- Permission check: `tickets.assign` or `tickets.write_all`.
- For `rerun_resolver=true`: invoke `RoutingService.evaluate(...)`
  in TS (read-only), pick the target, call this RPC with the
  resolved assignees + a reason snapshot.

---

### 3.3 RPC `update_entity_sla(p_entity_id, p_entity_kind, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.8 (WO sla update). Case-side §1.1 sla branch is
currently locked (line 999) but if a future change re-enables it,
the same RPC handles both via `p_entity_kind`.

**Signature:** same shape; `p_payload = { sla_id: uuid|null }`.

**Body sketch:**
1. Advisory lock + command_operations gate.
2. Visibility / permission validation (TS-side; see plan-build).
3. SELECT current row.
4. Validate `sla_id` is a tenant-owned `sla_policies` row (or null).
5. UPDATE entity row (sla_id + updated_at).
6. **Stop existing timers + start fresh ones** — atomic INSIDE this
   RPC:
   - UPDATE sla_timers SET completed_at=now() WHERE entity matches
     AND completed_at IS NULL.
   - UPDATE entity row clearing SLA-derived columns.
   - *(if new policy)* SELECT sla_policies, INSERT new sla_timers,
     UPDATE entity row with new due dates (business-hours math: see
     §3.1's open question — same "outbox-event → TS worker" pattern).
7. INSERT ticket_activities (`sla_changed`).
8. UPDATE command_operations.

**Compensation:** if the business-hours computation is deferred to
an outbox worker, the entity row temporarily shows null due-dates
until the worker fires. This matches today's behavior on a fresh
SLA assignment (the cron tick computes the due date eventually).

---

### 3.4 RPC `dispatch_child_work_order(p_parent_id, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.15 + §1.18 (workflow-engine loops over this).

**Signature:**
```sql
create or replace function public.dispatch_child_work_order(
  p_parent_id        uuid,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_payload          jsonb     -- DispatchInput (see below)
) returns jsonb
```

**Payload shape:**
```jsonc
{
  "child_id":            "uuid",                // pre-minted by TS, deterministic
  "title":               "string",
  "description":         "string?",
  "priority":            "string?",
  "interaction_mode":    "internal|external",
  "ticket_type_id":      "uuid?",
  "asset_id":            "uuid?",
  "location_id":         "uuid?",
  "assigned_team_id":    "uuid?",
  "assigned_user_id":    "uuid?",
  "assigned_vendor_id":  "uuid?",
  "sla_id":              "uuid|null|undefined",
  "routing_trace":       { ... },                // resolver result snapshot
  "routing_chosen_by":   "string"                // 'manual' | 'auto' | …
}
```

**Body sketch:**
1. Advisory lock + command_operations gate.
2. SELECT parent (FOR SHARE) — must be tenant=p_tenant_id, kind='case',
   not pending_approval, not resolved/closed.
3. Validate every FK in payload is tenant-owned (request_type, location,
   asset, assignees, sla_id) via existing helpers.
4. INSERT into `work_orders` with `id=child_id` (deterministic, lets
   the RPC be retry-safe — same key + same payload returns cached
   result with same child_id).
5. INSERT into `routing_decisions` (with the `routing_trace`
   snapshot supplied by TS — already evaluated read-only above).
6. *(if sla_id resolved)* INSERT sla_timers + UPDATE work_orders
   with due-dates. (Same business-hours / outbox question.)
7. INSERT into `ticket_activities` on the **parent** with
   `event='dispatched'` (audit on the parent's timeline, mirrors
   today's behaviour at line 240).
8. UPDATE command_operations.

**TS plan-build phase:**
- Resolve parent kind / tenant / status (read-only, before
  acquiring advisory lock).
- Mint `child_id` deterministically: `uuidv5(idempotency_key, ns)`.
- If no explicit assignees, run `RoutingService.evaluate(...)`
  read-only, get target + trace; pass into `routing_trace` /
  `routing_chosen_by`.
- Resolve child SLA via `DispatchService.resolveChildSla` (read-
  only) and pass into `sla_id`.

**The workflow-engine batch case (§1.18):** today the engine loops
N tasks. With a single-task RPC, the engine still loops, but each
iteration is atomic in itself. **Better:** add a sibling RPC
`dispatch_child_work_orders_batch(p_parent_id, p_tasks jsonb)` that
takes an array and creates them all in one tx. The workflow engine
then sees pure all-or-nothing semantics. Worth the extra mile —
saves the partial-fanout failure mode entirely.

---

### 3.5 RPC `grant_ticket_approval(p_approval_id, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.3 + §1.19. Mirror of `grant_booking_approval`
(00310) for ticket-target approvals.

**Signature:**
```sql
returns jsonb     -- { kind: 'resolved' | 'partial_approved' | 'already_responded',
                  --    approval_id, ticket_id, ticket_status, ticket_status_category,
                  --    routing_target?, sla_started?, workflow_started? }
```

**Body sketch:**
1. Advisory lock keyed on `(p_tenant_id, p_idempotency_key)`.
2. command_operations gate.
3. SELECT approval FOR UPDATE; validate target_entity_type='ticket'
   and status='pending'.
4. CAS update approvals (status, responded_at, comments).
5. *(if rejected)* UPDATE tickets (status='rejected',
   status_category='closed', closed_at=now()).
6. *(if approved)* UPDATE tickets (status='new', status_category='new').
7. *(if part of chain or parallel group)* check if all-resolved; if
   not, return `kind: 'partial_approved'`.
8. *(if approved AND fully resolved)* run inline post-create automation:
   - SELECT request_types config.
   - *(if has SLA)* INSERT sla_timers, UPDATE tickets.
   - Routing evaluation: this is non-trivial. **Defer routing to
     post-commit outbox event** `ticket.routing_required` so the
     RPC itself stays small. The outbox handler runs the resolver
     in TS and either calls `set_entity_assignment` RPC or emits a
     `routing_failed` breadcrumb activity.
9. INSERT ticket_activities (approval_approved | approval_rejected).
10. INSERT domain_events.
11. UPDATE command_operations.

**Why outbox for routing.** The routing engine touches: routing_rules
(reads), space_groups (reads), domain_parents (reads), scope_overrides
(reads), asset.assigned_space_id chain. Porting all of that to PL/pgSQL
is a project unto itself. The outbox handler approach matches how
`SetupWorkOrderHandler` works in B.0.E.

**TS plan-build phase:**
- Authorization (callerCanRespond) — already exists in TS.
- Mint idempotency key (same pattern as B.0).

---

### 3.6 RPC `update_work_order_combined(p_work_order_id, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.7 (WorkOrderService.update orchestrator).

The orchestrator today dispatches to up to 6 per-field methods
sequentially. The right replacement is **one RPC that takes the
union DTO and applies every field-group atomically** — not 6 RPCs.

**Signature:**
```sql
returns jsonb    -- the final WO row
```

`p_payload` shape mirrors `UpdateWorkOrderDto`. The RPC body folds
the equivalents of §3.1 (status), §3.2 (assignment), §3.3 (SLA)
into one tx, plus standalone branches for plan / priority / metadata
that today have no per-field RPCs (just `work_orders.UPDATE` +
activity).

**Why one big RPC vs. composing the per-field RPCs:**
- Composing inside the same connection = same tx if we open one in
  TS with `BEGIN/COMMIT`. But supabase-js doesn't expose that primitive;
  we'd need to switch to the `pg` driver for the orchestrator path,
  which is a bigger architectural shift.
- Postgres has no per-call tx primitive that ties multiple RPC calls
  into one tx without explicit BEGIN.
- One RPC = one tx. Matches the B.0 precedent
  (`create_booking_with_attach_plan` does the same — booking +
  slots + orders + OLIs + asset_reservations + approvals all in one
  RPC body, not 6 stitched together).

**Per-field RPCs §3.1-3.5 still ship** for the controller endpoints
that hit them directly (cron, workflow engine, single-purpose
controller calls). The orchestrator RPC is sibling, not parent.

---

### 3.7 New table: `command_operations` (idempotency)

Mirror of `attach_operations` (00302). Key by
`(tenant_id, idempotency_key)`, outcome enum
`('in_progress', 'success')`, payload_hash, cached_result jsonb. Same
v6 contract — `failed` doesn't materialize, the row INSERT lives
inside the RPC tx so a fail rolls it back.

**Open question:** can we reuse `attach_operations`? Reasoning either
way:
- **Reuse:** schema is identical. One namespace, fewer tables.
- **Separate:** semantically different — `attach_operations` is
  scoped to booking/services attach (the table comment names the
  RPC). Mixing in WO command writes breaks the comment + makes
  diagnostic queries noisier ("what does this idempotency key
  mean?"). Also: payload hashes for completely different operation
  classes shouldn't collide on the same key namespace, and tenant-
  level admin tooling that purges stale rows needs to know which
  class a row belongs to.

**Recommendation:** new table `command_operations`. Same schema,
clear naming, separate cleanup runbook. The only cost is one more
migration and one more RLS policy — trivial.

---

### 3.8 Helpers — what to reuse, what to add

**Reuse from B.0.A:**
- `validate_attach_plan_tenant_fks` (00303) — pattern only; B.2's
  command surface needs different input-shape validators, not the
  same one.
- `validate_rule_ids_in_tenant` (00306) — could be useful for
  service-rule references inside a future combined dispatch.

**New helpers needed:**
- `validate_assignees_in_tenant(p_tenant_id, p_team_id?, p_user_id?, p_vendor_id?)`
  — drop-in PL/pgSQL port of TS `validateAssigneesInTenant`. Single
  function, three args, returns void or raises.
- `validate_entity_in_tenant(p_tenant_id, p_entity_id, p_kind)` —
  ensures `(tickets|work_orders).id = p_entity_id` and `tenant_id`
  matches. Used by every RPC in §3.1-3.6.
- `compute_entity_state_diff(p_kind, p_payload, p_current jsonb)` —
  pure helper, returns the `(diff, previous, next)` jsonb shape
  every audit-emit site uses. Cuts duplication across §3.1-3.6.

**No DDL changes to existing tables.** All existing FK constraints,
RLS policies, and triggers stay. The RPCs work within the schema
B.0 left.

---

## 4. Migration plan

Numbering starts at 00316 (B.0 ended at 00315).

| # | File | Purpose |
|---|---|---|
| 00316 | `command_operations_table.sql` | New idempotency table (§3.7). |
| 00317 | `validate_assignees_in_tenant_helper.sql` | Drop-in for TS helper. |
| 00318 | `validate_entity_in_tenant_helper.sql` | Tenant-validate (case|wo).id. |
| 00319 | `transition_entity_status_rpc.sql` | §3.1. |
| 00320 | `set_entity_assignment_rpc.sql` | §3.2. |
| 00321 | `update_entity_sla_rpc.sql` | §3.3. |
| 00322 | `dispatch_child_work_order_rpc.sql` | §3.4. |
| 00323 | `dispatch_child_work_orders_batch_rpc.sql` | §3.4 batch variant. |
| 00324 | `grant_ticket_approval_rpc.sql` | §3.5. |
| 00325 | `update_work_order_combined_rpc.sql` | §3.6 — the orchestrator. |
| 00326 | `update_work_order_metadata_rpc.sql` | Plain audit-row write for plan / priority / metadata branches. |
| 00327 | `command_operations_grants.sql` | service_role grants (mirror 00301/00314). |
| 00328 | `outbox_events_routing_rerun_handler.sql` | Outbox event type for §3.5 deferred routing. |

13 migrations. Slightly fewer than B.0's 14 (B.0's was inflated by
hotfix migrations 00313-00315).

**Cutover plan:**
- Direct cutover (no shadow mode) for §3.1, §3.3, §3.6, §3.5. The
  outcome-shape is the same (the RPC returns the row), the audit
  rows look identical, and rollback is "stop calling the RPC".
- **Shadow mode for §3.4 (dispatch).** Reasoning: the workflow
  engine's `create_child_tasks` loop is hit at unpredictable times
  by tenant workflow definitions; flipping it without a shadow run
  is risky. Mirror the B.0 setup-WO-handler pattern: TS still
  dispatches the legacy way, RPC writes a shadow row, smoke probe
  asserts equivalence, then flip.

Same `pnpm db:push` flow; user authorization required (per CLAUDE.md
"Always confirm before pushing"). Memory note
[`feedback_db_push_authorized`](mailto:none) shows we have standing
permission for the booking-modal-redesign workstream — B.2 is a
different workstream, so re-confirm before pushing.

---

## 5. Test plan

**Mocked-jest specs** (mirror B.0.B's pattern):
- One `*.spec.ts` per RPC, exercising every error-mapping branch.
  - tenant_id null → AppError.
  - idempotency_key reuse with same payload → cached_result.
  - idempotency_key reuse with different payload →
    `command_operations.payload_mismatch`.
  - Missing FK refs → AppError(`ref.not_in_tenant`).
  - State-machine violation (close-on-open-children) → AppError.
- Roughly 80-120 specs total (~10-15 per RPC, 8-9 RPCs).

**Live-API smoke probes** (mandatory per CLAUDE.md "Smoke gate"):
- Extend `pnpm smoke:work-orders` to drive every RPC end-to-end:
  - Existing 13 probes already exercise `WorkOrderService.update` /
    `TicketService.update` mutations through the controllers. After
    cutover, every existing probe ALSO exercises a B.2 RPC. No new
    probe code needed for the basic surface.
  - Add new probes for: `dispatch_child_work_order` (parent →
    child round-trip), `grant_ticket_approval` (create requires-
    approval ticket → approve → assert routing fires), `transition_
    entity_status` (waiting-state pause/resume).
- New script `pnpm smoke:wo-commands` — sibling of
  `smoke-outbox-roundtrip.mjs`, scoped to the new RPCs:
  - Mint a fixture parent case + service-desk team + actor user.
  - Drive 5-10 mutations through each RPC; assert the row state, the
    `command_operations` row, and the activity / domain_events rows
    that should land.
  - 1-2 idempotency probes per RPC (replay the same key, assert
    cached_result equality).

**Real-DB advisory-lock concurrency tests** — deferred to the same
harness as B.0 (`b0-real-db-concurrency-harness.md`). When that
harness lands, port over: two concurrent `transition_entity_status`
calls with the same key serialize via the advisory lock; second
returns cached_result.

---

## 6. Estimated scope

Rough commit / migration / test budget per RPC:

| RPC | Commits | Migrations | New mocked specs | Smoke probe additions |
|---|---|---|---|---|
| §3.1 transition_entity_status | 3-4 | 1 | 12 | 2 |
| §3.2 set_entity_assignment | 3-4 | 1 | 14 | 2 |
| §3.3 update_entity_sla | 3 | 1 | 10 | 1 |
| §3.4 dispatch_child_work_order | 4-5 | 2 (single + batch) | 16 | 3 |
| §3.5 grant_ticket_approval | 3-4 | 1 | 10 | 2 |
| §3.6 update_work_order_combined | 4-6 | 1 | 14 | 4 |
| §3.7 command_operations table + helpers | 2 | 3 | 6 | — |
| §3.8 outbox routing-rerun handler | 2 | 1 | 6 | 1 |
| TS call-site cutover | 4-6 | — | (covered above) | — |
| `pnpm smoke:wo-commands` | 1-2 | — | — | (script itself) |
| Closing slice (legacy tag, retro) | 1-2 | 1-3 | — | — |
| **TOTAL** | **30-40** | **12-14** | **~88** | **~15** |

**B.0 was 29 commits + 14 migrations + 97 specs. B.2 is in the same
ballpark — 30-40 commits + 12-14 migrations + ~88 specs.**

**Recommendation: split B.2 into B.2.A and B.2.B.**

- **B.2.A — highest-severity surface (≈18-22 commits).** §3.1
  status, §3.2 assignment, §3.3 SLA. These cover the desk-UI's
  hottest paths and the SLA-divergence corruption hazard.
  Includes: command_operations table + helpers + 3 RPCs +
  TS cutover for `WorkOrderService.update*` + `TicketService.update`
  + smoke probe extension.

- **B.2.B — rest (≈12-18 commits).** §3.4 dispatch (with batch
  variant + workflow-engine cutover) + §3.5 grant_ticket_approval +
  §3.6 update_work_order_combined orchestrator + §3.8 outbox
  routing-rerun handler.

The split aligns with B.0's staged pattern (B.0.A foundation → B.0.B
RPCs → B.0.C TS plan-builder → B.0.D cutover → B.0.E handler →
B.0.F smoke + retro). B.2.A is "foundation + the three highest-
traffic RPCs"; B.2.B is "everything else + cleanup".

---

## 7. Sequencing recommendation

Within B.2.A:

1. **Foundation first** (1-2 days): `command_operations` table,
   `validate_assignees_in_tenant`, `validate_entity_in_tenant`,
   `compute_entity_state_diff`. No call-site change yet.

2. **§3.1 transition_entity_status** (3-4 days): RPC + mocked
   specs + TS plan-builder + cutover for `WorkOrderService.updateStatus`
   first (smaller blast radius than `TicketService.update`),
   then `TicketService.update` status branch.

3. **§3.2 set_entity_assignment** (3-4 days): RPC + cutover for
   `WorkOrderService.updateAssignment` + `WorkOrderService.reassign` +
   `TicketService.update` assignment branch + `TicketService.reassign`.

4. **§3.3 update_entity_sla** (2-3 days): RPC + cutover for
   `WorkOrderService.updateSla`. Smaller scope (one method).

5. **B.2.A smoke probe extension + retro** (1-2 days): port
   `pnpm smoke:work-orders` to assert the RPC path; ship a
   `b2a-shipped.md` retrospective.

Then B.2.B in any order — they're independent. Recommended:

6. **§3.4 dispatch + batch variant** (4-5 days). The hardest one.
   Routing-engine integration + workflow-engine batch cutover.
7. **§3.5 grant_ticket_approval + outbox routing-rerun handler**
   (3-4 days). Mirrors B.0.D.3 structurally.
8. **§3.6 update_work_order_combined orchestrator** (3-4 days).
   Folds in the per-field RPCs (§3.1-3.3) + plan / priority /
   metadata writes. Last because it depends on all the others.

**Why this order works:** §3.1 (status) is foundational because
§3.6 (orchestrator) is the union of all the per-field RPCs. Ship
status first, dispatch and approval can iterate in parallel after
§3.1+§3.2+§3.3 are stable.

---

## 8. Open questions

### 8.1 Reuse `attach_operations` or new `command_operations`?

**Recommendation: new table.** See §3.7. Same schema, clearer naming,
separate cleanup runbook. Marginal cost (one migration, one RLS
policy, one comment).

### 8.2 Smoke-probe pattern: extend `smoke-work-orders.mjs` or new file?

**Recommendation: both.**
- Extend `smoke-work-orders.mjs` for the 13 existing probes that
  go through the controllers — they exercise the new RPCs for free
  after cutover, no new code needed.
- Add `apps/api/scripts/smoke-wo-commands.mjs` (sibling of
  `smoke-outbox-roundtrip.mjs`) for the round-trip / idempotency /
  RPC-direct probes that aren't naturally exercised through the
  controllers. Mirrors B.0's pattern of "the API smoke gate covers
  the wire shape; the round-trip smoke covers the new RPCs that
  don't have direct API endpoints."

### 8.3 Backward-compatibility policy

B.0 deprecated some legacy code (BookingTransactionBoundary,
triggerStrict). B.2 will deprecate the per-field WO methods'
internal call sites (they still exist as service methods but they
become thin wrappers around the RPCs). **Same 30-day-post-cutover
deletion policy** per `b0-legacy-cleanup.md`. Tag at cutover, delete
after stabilisation window.

### 8.4 Patterns that DON'T fit the combined-RPC model

The orchestrator pattern is a hammer; not everything is a nail. Three
surfaces should stay TS-side per the original CLAUDE.md rule (≥2
tables AND partial-write is corrupting):

- **`TicketService.create()` non-approval-gate happy path.** First
  step is `tickets.INSERT`; second is the single
  `ticket_activities.INSERT`. Two tables, but the second one's
  failure is ONLY an audit drift (the row exists; the activity is
  recoverable). Wrapping these in an RPC would still be valuable
  (closes audit-drift), but the upgrade can defer to the orchestrator
  RPC §3.6 if/when ticket create is added there.

- **`runPostCreateAutomation` routing fan-out.** The routing engine
  is too big to port; the existing fail-soft semantics (catch +
  log + continue, leave a breadcrumb activity) are honest about
  the trade-off. **Outbox event** is the right shape: emit
  `ticket.routing_required` from the create RPC, let the existing
  TS routing service handle it. Same approach as §3.5.

- **`SlaService.fireThreshold()` escalation cron.** The class
  comment is honest about the duplication window. **B.2 SHOULD
  fold this into a `fire_sla_threshold(...)` RPC** but the
  prioritization is `important` not `critical`. Defer to B.2.B
  or an even later slice.

### 8.5 Real-time notification fan-out

`BookingNotificationsService.onApprovalDecided` (B.0.D.3) explicitly
keeps notification fan-out in TS post-RPC because the vendor email
call can take seconds and shouldn't extend the booking-level
advisory lock. **B.2 inherits this rule.** Every RPC's "after-
commit notifications" goes through `OutboxService.emit()` and a
TS handler — never inline in the RPC.

---

## 9. Pushback

The combined-RPC pattern is the right shape for §3.1, §3.2, §3.3,
§3.4, §3.5, §3.6. **No pushback on the critical 6.**

Pushback on `nit` and some `important` surfaces:

- **§1.5 `bulkUpdate`** doesn't need an RPC. It's already one
  statement at the row level; the partial-commit hazard doesn't
  exist. The audit drift it has (no per-field activity emission)
  is a separate UX choice, not a B.2 concern.

- **§1.16 `fireThreshold`** is the only honest case where "we
  decided to live with the duplication window". The class comment
  documents the trade-off. **Recommend wrapping it in an RPC
  anyway** because the cost is low (one RPC, ~50 lines of PL/pgSQL)
  and the rule is consistent. Schedule for B.2.B's tail end.

- **§1.17 SLA helpers** standalone don't need RPCs — they're
  callable from inside the RPCs in §3.1, §3.3, §3.6 which already
  wrap them in tx. The cron paths can stay TS-side temporarily and
  cut over later (the cron writes are bounded; partial-commit on
  cron has a "next tick will fix it" recovery semantic).

- **§1.6 `createBookingOriginWorkOrder`** is small enough that
  folding it into the existing `create_setup_work_order_from_event`
  RPC (00312, B.0.B) is a one-line scope addition — pull the
  activity + domain_event INSERT into that RPC instead of TS.
  **Recommend: do this in B.2.A as a free extra**, not its own RPC.

- **§3.6 orchestrator vs. per-field RPCs** — there's a real argument
  for "ship the orchestrator only and never expose the per-field
  RPCs externally". Pro: simpler API surface; clients only see
  `update_work_order_combined`. Con: cron / workflow-engine /
  internal callers want narrow per-field calls. **Decision:**
  ship both. Per-field RPCs as primitives; orchestrator as the
  controller-facing one. Same as B.0's `create_booking_with_attach_plan`
  + `approve_booking_setup_trigger` pattern.

---

## 10. Closing — when this is ready to implement

**Pre-flight before kicking off B.2.A:**

1. B.0 soak burn-in window completes (7 days, ≥50 samples per
   `b0-shipped.md` "What's next" #3). At time of writing
   (2026-05-04), B.0 just shipped — soak window runs ~2026-05-11.
2. B.0 real-DB concurrency harness (`b0-real-db-concurrency-harness.md`)
   ships (~1 day). This is the gate B.2 inherits — same harness
   covers `command_operations` advisory locks.
3. B.0 §16.1 cleanup commit (legacy tagging delete) is ready or
   triaged. B.2 doesn't depend on it but they touch the same
   neighborhood; landing them in opposite order causes merge
   conflicts.
4. User reconfirms standing DB-push permission for the B.2
   workstream (per global "always confirm before push" rule).

**Kickoff:** start with foundation migrations 00316-00318 +
helpers, no behavior change. Smoke probe still passes (no new
write paths exercised). Then §3.1 RPC + cutover.

**Definition of done for B.2.A:**
- `pnpm smoke:work-orders` exits 0 against remote.
- `pnpm smoke:wo-commands` (new) exits 0 against remote.
- All 13 existing probes pass; ≥10 new probes added; mocked spec
  count at +88 over baseline.
- Per-field WO methods + `TicketService.update` status / assignment
  / SLA branches all route through RPCs.
- `b2a-shipped.md` retrospective committed alongside the cutover
  commit.

**Definition of done for B.2 (full):**
- All 6 critical surfaces routed through RPCs.
- Workflow-engine `create_child_tasks` uses the batch dispatch RPC.
- `grant_ticket_approval` mirrors `grant_booking_approval`.
- `update_work_order_combined` is the only thing the WO controller
  PATCH handler calls.
- 30-day post-cutover deletion of legacy per-field write code per
  `b0-legacy-cleanup.md` policy.

After B.2, **the only remaining surfaces in §10X are: booking
cancellation cascade (§10X.1), standalone-order creation (§10X.2),
visitor-pass assignment (§10X.3), recurrence-clone (§10X.3).**
Everything else in the codebase that touches ≥2 tables atomically
is on the v5+ pattern.
