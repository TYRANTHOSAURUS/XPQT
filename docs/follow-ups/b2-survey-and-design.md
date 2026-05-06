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

## Revision history

- **v1 (2026-05-04 morning).** Initial survey + design. 19 surfaces
  surveyed (1.1–1.20). 6 RPCs proposed (status / assignment / SLA /
  dispatch / approval / WO orchestrator). 13 migrations. ~30-40
  commits. Split into B.2.A (foundation + 3 hottest RPCs) and B.2.B
  (rest). Live at this doc through commit prior to v2.

- **v2 (2026-05-04 afternoon).** Folds codex-v1 review findings.
  Headline changes:
  - **C1.** Replace per-entity status / assignment / SLA / metadata
    PATCH RPCs at the controller boundary with a single
    `update_entity_combined(entity_kind, …)` orchestrator (§3.0).
    Per-field RPCs survive as **internal helpers** the orchestrator
    composes; controllers (`PATCH /tickets/:id`,
    `PATCH /work-orders/:id`) only call the orchestrator. Eliminates
    the case-side equivalent of the WO orchestrator non-atomicity
    that v1 still had.
  - **C2.** Workflow-engine `assign` + `update_ticket` nodes are now
    in scope. They were silently writing tickets directly. Cutover
    routes them through `set_entity_assignment` /
    `update_entity_combined` with idempotency key
    `workflow:${instance_id}:${node_id}:${execution_token}`. New §1.21 in
    survey, sequenced in B.2.B.
  - **C3.** Async SLA resume is unsafe under v1's outbox-only
    pattern (the breach cron at `sla.service.ts:333` reads
    `paused=false` + stale `due_at` and falsely breaches in the
    gap). Adds `sla_timers.recompute_pending boolean` flag set
    atomically with `paused=false` and cleared by the worker after
    `due_at` recompute. All breach / threshold readers add
    `AND recompute_pending = false`. v1 §9 pushback #3 is RETRACTED.
  - **C4.** `ReclassifyService.execute` was missing from v1 survey.
    Added as §1.22. Reclassification atomically emits three outbox
    follow-ups (`sla.timer_repointed_required`,
    `workflow.start_required`, `routing.evaluation_required`) inside
    the RPC tx. Sequenced in B.2.B.
  - **I1.** `RequireClientRequestIdGuard` is mandated on every
    write endpoint that fronts a B.2 RPC (PATCH /tickets/:id, PATCH
    /work-orders/:id, POST /tickets/:id/dispatch,
    POST /approvals/:id/respond). Threads
    `actor.client_request_id` through service methods into the
    idempotency key. Foundation in B.2.A.
  - **I2.** Routing has a per-surface sync/async split — sync for
    create + dispatch (latency-sensitive UX); async outbox-driven
    with a `tickets.routing_status` column for re-routing /
    transition-driven flows. v1 §9 pushback #2 narrowed
    accordingly.
  - Migration count bumped 13 → 16 (recompute_pending column,
    routing_status column, reclassify follow-up RPC). Commit count
    32-44.

- **v3 (2026-05-06).** Folds codex-v2 review findings.
  Headline changes:
  - **C1.** Add `create_ticket_with_automation` RPC (§3.11). v1
    surveyed §1.2 as critical but v2 left it without a matching RPC,
    partly deferring in §8.4. v3 closes the gap: case create with
    approval-gate / automation routes through one combined RPC that
    INSERTs the ticket row + activity + domain_event + (if approval
    gate) approvals.INSERT, and emits `routing.evaluation_required`
    + `sla.timer_recompute_required` + `workflow.start_required`
    outbox events atomically for the post-create automation
    side-effects. §8.4 deferral note retracted for §1.2.
  - **C2.** `grant_ticket_approval` (§3.5) emits
    `workflow.start_required` outbox event atomically when the
    approval transitions a ticket to `approved + fully resolved`
    AND the request_type config has a workflow definition. v2
    covered SLA + routing emit but missed workflow start.
  - **I1.** §3.9.1 false claim that "apiFetch already mints
    X-Client-Request-Id" RETRACTED. Per `apps/web/src/lib/api.ts:125`
    apiFetch does NOT auto-mint; producer mutation hooks must thread
    `requestId` at mutation-attempt scope (Pattern A from B.0.E.3).
    Affected hooks listed explicitly: `useUpdateTicket` /
    `useDispatchTicket` (`apps/web/src/api/tickets/mutations.ts`),
    `useUpdateWorkOrder` (`apps/web/src/hooks/use-work-orders.ts`).
  - **I2.** `recompute_pending` reader migration enumerates the 6
    concrete call sites: breach cron (`sla.service.ts:333`), at-risk
    cron (`:367`), detail status (`:411`), threshold cron (`:755`),
    reporting (`reporting.service.ts:97`), reclassify impact
    (`reclassify.service.ts:486`). Each site gets the
    `AND recompute_pending = false` clause + a regression test.
  - **I3.** Workflow idempotency key `${attempt}` replaced with
    `${execution_token}` — workflow_instances has no attempt field
    per `supabase/migrations/00009_workflows.sql:28`. Engine mints
    a UUID per node fire and persists on the existing `node_event`
    row; the token serves as the idempotency seed.
  - **I4.** Routing event name unified to
    `routing.evaluation_required`. Drops `routing.decision_recorded`
    + `ticket.routing_required` drift. `routing_failure_reason`
    (text column on tickets) added to migration 00320 alongside
    `routing_status`.
  - **Nit.** Reclassify file path corrected to
    `apps/api/src/modules/ticket/reclassify.service.ts` (was
    `apps/api/src/modules/reclassify/reclassify.service.ts`).
  - Migration count: 16 → 17 (create_ticket_with_automation RPC).
    `routing_failure_reason` rolled into 00320 (no extra migration).
    Commit count 34-46.


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

### 1.21 `WorkflowEngineService.executeNode('assign' | 'update_ticket')`

`workflow-engine.service.ts` — the `assign` node and the
`update_ticket` node both write to `tickets` directly today (UPDATE
through supabase-js, no service-call indirection). The engine is
loud about its own create_child_tasks loop (§1.18) but quiet about
these two. Codex review surfaced them.

**Writes (per node execution):**
- `assign`: one `tickets.UPDATE` (assignment columns) + a
  `node_event` row for the workflow audit. No `routing_decisions`
  row, no `ticket_activities` row, no `domain_events` row. The
  human-visible audit trail is missing entirely.
- `update_ticket`: one `tickets.UPDATE` (status / priority /
  metadata depending on node config) + a `node_event` row.
  Same gap — no `ticket_activities`, no `domain_events`.

**Failure modes:**
- ✅ tickets.UPDATE commits, node_event fails → workflow advances
  but the audit row is missing on the workflow-instance side.
  Hard to tell from the operator UI which node fired.
- The bigger issue is the SHAPE of these writes — they bypass the
  per-field service methods entirely, so even on success there's
  no `assignment_changed` / `status_changed` activity, no
  `ticket_assigned` / `ticket_status_changed` domain event, and no
  notification fan-out. Workflow-driven mutations don't appear in
  the case timeline. **The current code is silently audit-dropping
  every workflow-driven assignment / status change.**

**Severity:** `critical`. Two reasons: (a) audit drift on every
workflow tick — orders of magnitude more frequent than the human
PATCH paths; (b) silent skip of notifications + domain events
(downstream consumers, search index reindex, cross-tenant analytics
don't see workflow-driven changes).

**Fix:** the engine's `assign` node calls `set_entity_assignment`
RPC (§3.2) with idempotency key
`workflow:${instance_id}:${node_id}:${execution_token}` — deterministic,
retry-safe, replays cleanly across engine restarts. The
`update_ticket` node calls `update_entity_combined` (§3.0) with
the same key shape. Both pass `actor_user_id = SYSTEM_ACTOR_USER_ID`
and a `source: 'workflow'` breadcrumb in the activity payload so
the audit feed labels the row "by Workflow" not "by System".

**`execution_token` definition (v3 / I3 fix).** `workflow_instances`
has no `attempt` field per `supabase/migrations/00009_workflows.sql:28`,
so v2's literal `${attempt}` had no persistence. v3 replaces it with
a UUID minted by the workflow engine on each node fire and persisted
on the existing `node_event` row alongside the engine's audit. The
token is the seed — same node firing twice (e.g. retry after engine
restart) reuses the same `node_event` row → same token → same
idempotency key → cached result returned by the RPC. Fresh fires
(workflow-loop iterations) get fresh tokens by construction. No new
table required; the engine just stores `execution_token uuid` in the
`node_event` payload jsonb at fire time.

---

### 1.22 `ReclassifyService.execute()`

`apps/api/src/modules/ticket/reclassify.service.ts` — Codex
review surfaced this; v1 missed it entirely. Reclassification is
when an admin / reception agent moves a ticket from one
`request_type_id` to another (e.g. "this was filed as 'IT support'
but it's actually 'facilities cleanup'"). It triggers a cascade of
follow-ups: SLA repoint (different policy may apply), workflow
restart (different workflow definition may apply), routing
re-evaluation (different rules apply).

**Writes (in order):**
1. `tickets.UPDATE` (request_type_id, possibly category, location
   if the new type forces it).
2. `ticket_activities.INSERT` (`reclassified`, with old/new types
   in payload).
3. `domain_events.INSERT` (`ticket_reclassified`).
4. *(if SLA changes)* `sla_timers.UPDATE` (complete existing) +
   `sla_timers.INSERT` (fresh) + `tickets.UPDATE` (new due dates).
5. *(if workflow changes)* `workflow_instances.UPDATE` (cancel
   current) + `workflow_instances.INSERT` (start new).
6. *(if routing rule changes)* `routing_decisions.INSERT` + new
   assignment write through `tickets.UPDATE`.

**Failure modes:**
- ✅ tickets.UPDATE commits, SLA repoint fails → ticket has a new
  request_type but the SLA queue still tracks the old policy's
  thresholds. **Critical: SLA timer divergence.**
- ✅ tickets + SLA commits, workflow restart fails → old workflow
  instance still ticking with stale state, new one never started.
  **Critical: workflow drift.**
- ✅ tickets + SLA + workflow commits, routing re-eval fails → new
  type assigned, but the assignee is still the old type's resolver
  result. Operator sees "this is a cleaning job assigned to the IT
  team" with no breadcrumb of why.

**Severity:** `critical`. Reclassification is a low-frequency op
(reception agents do a handful per day at busy tenants) but each
one fans into 3-5 dependent writes that are ALL critical to keep
consistent. The current code fails-soft on SLA / workflow / routing
follow-ups via try/catch — exactly the same pattern that produced
the §1.4 audit drift bug.

**Fix:** new RPC `reclassify_ticket(p_ticket_id, p_tenant_id,
p_actor_user_id, p_idempotency_key, p_payload)` that does the
ticket UPDATE + activity + domain event INSIDE the tx, then atomically
emits **three outbox events** in the same tx:
- `sla.timer_repointed_required` — TS handler completes old timers,
  starts new ones if the new policy differs.
- `workflow.start_required` — TS handler cancels the running
  instance and starts a new one matching the new request_type's
  workflow_definition_id.
- `routing.evaluation_required` — TS handler runs the resolver and
  calls `set_entity_assignment` RPC if the result differs.

Atomicity comes from the outbox: all three events are in the same
PG tx as the tickets UPDATE, so either all-or-nothing. Worst case
on handler failure: the outbox-deadletter retry catches it. No
silent drift.

**Sequencing:** B.2.B, after §3.0 + §3.2 land (the reclassify RPC
calls into both via outbox handlers + inline as needed).

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
| 1.21 | `WorkflowEngineService.assign` + `update_ticket` nodes | critical |
| 1.22 | `ReclassifyService.execute` | critical |

**Critical count: 12. Important count: 6. Nits + out-of-scope: 4.**

The critical 12 collapse into **8 logical command surfaces** because
several are aspects of the same abstraction:

1. **Status transition** (cases + WOs) — §1.1 status branch + §1.10.
2. **Assignment / reassignment** — §1.1 assignment branch + §1.4 +
   §1.12 + §1.14 + §1.21 (workflow `assign` node uses the same RPC).
3. **SLA reassignment** — §1.1 sla branch (currently disabled) + §1.8.
4. **Dispatch** (case → child WO) — §1.15 + §1.18 (the workflow loop).
5. **Approval grant on ticket target** — §1.3 + §1.19.
6. **Ticket create with approval gate / automation** — §1.2 (the two
   sub-paths).
7. **Workflow-driven generic update** — §1.21's `update_ticket` node
   (status / priority / metadata via `update_entity_combined`).
8. **Reclassification** — §1.22 (request_type repoint + cascading
   SLA / workflow / routing follow-ups via outbox).

Plus the 6 "important" surfaces (plan, priority, metadata, booking-
origin WO create, threshold-fire, SLA helpers) which fold into the
above as additional jsonb-payload variants OR get their own thin
RPCs.

**Combined-PATCH atomicity (the v2 headline).** The case-side PATCH
endpoint (`PATCH /tickets/:id`) and the WO-side PATCH endpoint
(`PATCH /work-orders/:id`) both accept multi-field payloads (status
+ priority + assignee in one save is the desk-UI norm). v1 designed
per-field RPCs (§3.1-3.3) without a controller-facing combined RPC
on the case side, leaving the same partial-commit hazard the WO
orchestrator (§1.7) already documents. v2 fixes this with a generic
`update_entity_combined` (§3.0) that branches on `entity_kind` —
both controllers call into one orchestrator that composes the
per-field helpers in a single tx.

---

## 3. Design — combined-RPC architecture per surface

For each surface: signature, body sketch, idempotency model, what stays
in TS, compensation. Numbering aligns with the §2 collapse.

### 3.0 RPC `update_entity_combined(p_entity_kind, p_entity_id, p_tenant_id, p_actor_user_id, p_idempotency_key, p_patches)` (controller-facing orchestrator)

**Replaces:** the controller boundary for `PATCH /tickets/:id` and
`PATCH /work-orders/:id`. Both controllers call this one RPC. The
per-field RPCs (§3.1-3.3) become **internal helpers** the
orchestrator composes; controllers do not call them directly. This
is the v2 fix for the C1 finding — v1 left case-side PATCH
atomicity unsolved by exposing only per-field RPCs there.

**Signature:**
```sql
create or replace function public.update_entity_combined(
  p_entity_kind     text,        -- 'case' | 'work_order'
  p_entity_id       uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text,
  p_patches         jsonb        -- { status?, status_category?, waiting_reason?,
                                 --   priority?, assignment?, sla_id?,
                                 --   plan?, metadata?, ... }
) returns jsonb
language plpgsql
security invoker
```

**Body sketch:**
1. Advisory xact lock keyed on `(p_tenant_id, p_idempotency_key)`.
2. `command_operations` idempotency gate (§3.7).
3. Branch on `p_entity_kind`:
   - `'case'` → SELECT from `tickets` FOR UPDATE.
   - `'work_order'` → SELECT from `work_orders` FOR UPDATE.
4. Validate every FK ref in `p_patches` is tenant-owned (calls
   `validate_assignees_in_tenant`, `validate_entity_in_tenant`,
   `validate_sla_id_in_tenant`).
5. Compute per-field diffs against the current row.
6. Apply field groups in this order, each branch is conditional on
   the patch containing that field:
   - **status** → call `_apply_status_transition(...)` private helper
     (the body of §3.1 hoisted into a SECURITY INVOKER inner
     function); state-machine validation; SLA pause/resume math
     (with C3's `recompute_pending` flag — see §3.3); single
     `tickets.UPDATE` for the new status / status_category /
     waiting_reason.
   - **priority** → write priority + updated_at on the row.
   - **assignment** → call `_apply_assignment(...)` (body of §3.2);
     emit `routing_decisions.INSERT` if `reason` is set; UPDATE
     assignment columns.
   - **sla_id** → call `_apply_sla_repoint(...)` (body of §3.3);
     C3's `recompute_pending=true` set atomically with the new
     `sla_id`; emit outbox event for due-date recompute.
   - **plan** → write planned_start_at / planned_duration_minutes;
     emit `plan_changed` activity.
   - **metadata** → write title / description / cost / tags /
     watchers; emit `metadata_changed` activity.
7. Emit a **single** `ticket_activities.INSERT` per field-group
   that mutated (status_changed, assignment_changed, etc.) — same
   row count as today's per-method writes, just inside one tx.
8. Emit `domain_events` rows in the same tx (one per logically
   distinct event: status / assigned).
9. UPDATE `command_operations` to outcome='success'.

**Why "generic with entity_kind branching" vs "two RPCs"
(`update_case_combined` + `update_work_order_combined`):**
- The schema differs only in target table name (`tickets` vs
  `work_orders`) and a handful of column names that already
  match (assigned_team_id / assigned_user_id / assigned_vendor_id;
  status; status_category; planned_start_at; etc.). PL/pgSQL
  `EXECUTE format(...)` lets the body parameterize over the table
  name in two places.
- One RPC = one body to keep in lockstep. Two RPCs = drift risk
  every time the column lists evolve.
- Pattern matches the §3.1-3.5 RPCs that already use
  `p_entity_kind`. v2's generic-with-branching is the consistent
  shape.

**Trade-off acknowledged:** `EXECUTE format(...)` PL/pgSQL is
slightly harder to debug than two static SQL bodies. The fix is
to keep all dynamic SQL inside the private inner helpers
(`_apply_status_transition` etc.) which take `p_table_name` as a
literal — those helpers are tiny and obviously correct.

**Per-field RPCs (§3.1-3.3) still ship.** They're the inner
helpers the orchestrator composes, plus they're called directly
by:
- The escalation cron (§1.16) calling `set_entity_assignment` to
  reassign a ticket on threshold fire.
- The workflow engine's `assign` node (§1.21) calling
  `set_entity_assignment` directly.
- The reclassify RPC's outbox handler (§1.22) calling
  `set_entity_assignment` for the routing follow-up.
- Migration tooling / admin one-shots that need a narrow surface.

The internal-helper / RPC separation is purely about exposure: §3.0
is the **only** RPC the controllers call.

**Idempotency:** standard `command_operations` row.
`p_idempotency_key` keys the orchestrator. Field-group writes
inside the tx don't need their own keys — they're part of the
parent tx and roll back if any branch fails.

**TS plan-build phase:**
- DTO normalization (waiting_reason `null` vs `undefined`,
  trim string fields, etc.).
- Permission checks (visibility floor + per-action gates: the
  payload's fields determine which gate fires —
  `tickets.change_status` for status; `tickets.assign` for
  assignment; `tickets.change_priority` for priority).
- Mint
  `idempotency_key = "patch:${entity_kind}:${entity_id}:${actor.client_request_id}"`
  per the I1 guard mandate.

**Compensation:** none. Fully atomic.

---

### 3.1 RPC `transition_entity_status(p_entity_id, p_entity_kind, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.1 status branch (ticket) + §1.10 (WO). One RPC, two
entity_kind values: `'case'` writes `tickets`; `'work_order'` writes
`work_orders`.

**Exposure (v2 update):** this RPC is **not called by the PATCH
controllers directly**. The combined orchestrator §3.0 composes
its body via the `_apply_status_transition` private helper. §3.1
ships as a public RPC because:
- Cron paths (e.g. auto-resolve on parent-close) call it directly.
- The reclassify outbox handler may call it if the new request_type
  forces a status change.
- The workflow-engine `update_ticket` node is wrapped by §3.0 (so
  it goes through the orchestrator), but the older `transition`
  workflow nodes call it directly.

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

**v2 critical correction (C3): the `recompute_pending` flag.**
v1 of this section, plus §9 pushback #3, claimed async SLA resume
was safe — the outbox-worker would compute the new `due_at`
eventually. Codex review found this is **NOT safe**: the breach
cron at `sla.service.ts:333` reads `paused=false` AND a
not-yet-recomputed `due_at`, sees the timer "should have fired",
and emits a false breach. The window is small (the time between
the RPC tx commit and the worker landing the recomputed `due_at`)
but non-zero, and on a busy tenant the cron tick runs every 30s.

**Schema fix.** Add a `recompute_pending boolean not null default false`
column to `sla_timers`. The migration also adds a partial index
`(tenant_id, entity_id) where recompute_pending = true` so the
worker can find pending rows cheaply.

**Atomicity contract (must hold in EVERY writer):**
- Any RPC that flips `paused=false` OR re-points `sla_id` MUST set
  `recompute_pending=true` in the same UPDATE.
- Any reader that compares `now() >= due_at` for breach / threshold
  decisions MUST add `AND recompute_pending = false` to its WHERE.
- The worker computes the new `due_at` (business-hours math in TS),
  then atomically UPDATEs `(due_at = $new, recompute_pending = false)`
  — single statement, one tx. If the worker fails mid-recompute,
  `recompute_pending` stays `true`, the next tick retries, no false
  breach in the gap.

**Body sketch (v2):**
1. Advisory lock + command_operations gate.
2. Visibility / permission validation (TS-side; see plan-build).
3. SELECT current row.
4. Validate `sla_id` is a tenant-owned `sla_policies` row (or null).
5. UPDATE entity row (sla_id + updated_at).
6. **Stop existing timers + start fresh ones with the recompute
   flag set** — atomic INSIDE this RPC:
   - `UPDATE sla_timers SET completed_at = now() WHERE entity
     matches AND completed_at IS NULL`.
   - UPDATE entity row clearing SLA-derived columns.
   - *(if new policy)* SELECT sla_policies, `INSERT INTO sla_timers
     (..., recompute_pending) VALUES (..., true)`. Initial `due_at`
     is `NULL` — the worker will fill it in. Reader queries already
     skip `recompute_pending = true`, so they never see the null
     either.
7. Emit outbox event `sla.timer_recompute_required` (carries
   tenant_id, entity_id, entity_kind, sla_id) for the worker.
8. INSERT ticket_activities (`sla_changed`).
9. UPDATE command_operations.

**Body sketch for waiting-state pause/resume (called by §3.1's
status branch, but the same flag rule applies):**
- On pause:
  `UPDATE sla_timers SET paused = true, paused_at = now()` — no
  recompute needed (pause math is simple, can stay TS-side or be
  inlined in PG). `recompute_pending` stays `false`.
- On resume:
  `UPDATE sla_timers SET paused = false, recompute_pending = true`
  in one statement. Emit `sla.timer_recompute_required` outbox
  event in the same tx. Worker computes the new `due_at` accounting
  for the paused interval + business hours, then clears the flag.

**Reader-side migration (v3 / I2 fix — enumerated).** Every reader
of `sla_timers` that uses `paused = false` to filter live timers
MUST add `AND recompute_pending = false` in the cutover commit.
v2 said "every existing breach / threshold reader" but didn't
enumerate; codex review correctly flagged that hand-waving "and
similar" leaves drift. The concrete sites:

| File:line | Reader | Risk if missed |
|---|---|---|
| `apps/api/src/modules/sla/sla.service.ts:333` | breach detection cron | False breach during recompute gap |
| `apps/api/src/modules/sla/sla.service.ts:367` | at-risk detection cron | False at-risk warning |
| `apps/api/src/modules/sla/sla.service.ts:411` | per-ticket SLA detail status | UI shows wrong "due in X" countdown |
| `apps/api/src/modules/sla/sla.service.ts:755` | threshold escalation cron | False escalation fire |
| `apps/api/src/modules/reporting/reporting.service.ts:97` | SLA reporting | Aggregates skewed |
| `apps/api/src/modules/ticket/reclassify.service.ts:486` | reclassify impact preview | Wrong "this will move N timers" preview |

Each site gets `AND recompute_pending = false` AND a regression test
asserting the clause is present + that a `recompute_pending=true`
fixture row is correctly skipped. Tests live in
`<module>/<file>.spec.ts` colocated with each reader. CI grep
guard added to flag any new `from('sla_timers')` query that omits
the clause.

**Compensation:** if the worker permanently fails, the row stays
`recompute_pending=true` and the alert pipeline (existing
deadletter) surfaces it. The entity row's due-dates display as
"computing..." until resolved. Worse than fresh-SLA today (which
just shows null), but better than the false-breach hazard v1 had.

**v1 §9 pushback #3 retracted.** See updated §9.

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
     post-commit outbox event** `routing.evaluation_required` so the
     RPC itself stays small. The outbox handler runs the resolver
     in TS and either calls `set_entity_assignment` RPC or emits a
     `routing_failed` breadcrumb activity.
   - **Workflow start (v3 / C2 fix).** If the request_type config
     has a `workflow_definition_id` AND no `workflow_instances` row
     exists yet for this ticket, atomically emit
     `workflow.start_required` outbox event in the same tx. The
     outbox handler (sibling of `SetupWorkOrderHandler` from B.0.E)
     starts the workflow instance via the existing
     `workflowService.startInstance(...)` TS path. This closes the
     v2 gap where v2's RPC covered SLA + routing but dropped
     workflow start; today
     `runPostCreateAutomation` (`ticket.service.ts:716`) calls
     `startInstance` at line 865, and v2 silently lost that branch
     when migrating to the RPC. Idempotency on the outbox handler
     is the same `workflow_instances UNIQUE (tenant_id, ticket_id)`
     constraint that already exists; replay → existing instance →
     handler returns no-op.
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

### 3.6 ~~RPC `update_work_order_combined`~~ → see §3.0

**v2 supersession.** v1 proposed a WO-only orchestrator
`update_work_order_combined`. Codex review noted that the case
side has the identical shape and v1 left it without a combined
RPC, exposing the case PATCH endpoint to the same partial-commit
hazard the WO orchestrator (§1.7) explicitly documented as known
debt.

**v2 fix.** Replaced with the generic `update_entity_combined`
described in §3.0. Both `PATCH /tickets/:id` and
`PATCH /work-orders/:id` route through it. The `entity_kind`
parameter selects the target table; the body composes the same
field-group helpers (status / assignment / SLA / plan / priority /
metadata) for either kind.

The "why one big RPC vs. composing per-field RPCs" rationale from
v1 still applies — same reasoning, same tx-boundary argument —
just hoisted up to §3.0 and made symmetric across the case + WO
sides.

**Per-field RPCs §3.1-3.5 still ship** as internal helpers + as
direct endpoints for the narrow callers listed in each section
(cron, workflow engine, reclassify outbox handlers). The
orchestrator at §3.0 is the **only** RPC the PATCH controllers
call.

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

**No DDL changes to existing tables, except:**
- `sla_timers.recompute_pending boolean not null default false` (C3,
  see §3.3). Required for safe async SLA resume.
- `tickets.routing_status text not null default 'idle'` (I2, see
  §3.9.2). Required for outbox-driven re-routing to coexist with
  sync routing on create/dispatch.

All existing FK constraints, RLS policies, and triggers stay.

---

### 3.9 Cross-cutting controls (v2 additions)

#### 3.9.1 I1 — `RequireClientRequestIdGuard` is mandatory

Every endpoint that fronts a B.2 RPC MUST attach
`RequireClientRequestIdGuard` (existing guard, used today by some
booking endpoints). The guard:
- Reads `X-Client-Request-Id` from the request header.
- Returns 400 (`request.client_request_id_required`) if missing.
- Validates UUID format.
- Stores it on `req.actor.client_request_id` for downstream services.

**Endpoints in scope (v2 mandate):**
- `PATCH /tickets/:id` (calls §3.0 with entity_kind='case').
- `PATCH /work-orders/:id` (calls §3.0 with entity_kind='work_order').
- `POST /tickets/:id/dispatch` (calls §3.4 dispatch).
- `POST /approvals/:id/respond` (calls §3.5 grant_ticket_approval).
- `POST /tickets/:id/reclassify` (calls §3.10 reclassify_ticket).
- `POST /tickets/:id/reassign` (calls §3.2 set_entity_assignment
  with reason).
- `POST /work-orders/:id/reassign` (same).

The guard wave lands in B.2.A foundation (sequenced first). Service
methods accept `actor.client_request_id` as part of the actor
context object and thread it into the idempotency key:
`${operation}:${entity_id}:${client_request_id}`. This is the
mechanism that makes "user double-clicks Save" behave correctly
with the `command_operations` cache.

**Frontend cooperation (v3 / I1 fix).** v2 incorrectly claimed
`apiFetch` auto-mints `X-Client-Request-Id`. Per
`apps/web/src/lib/api.ts:125` (and v8.1 of the outbox spec), apiFetch
does NOT auto-mint — the no-auto-stamp contract was the v8.1 fix
that B.0.E.2 enforced. Producer mutation hooks must thread the id
at mutation-attempt scope (Pattern A from B.0.E.3): `useMemo` (or
equivalent) outside the mutationFn closure so React Query retries
of the same logical attempt reuse the same id.

**Affected hooks** (the producer routes that call B.2 RPCs):

| File:line | Hook | Endpoint |
|---|---|---|
| `apps/web/src/api/tickets/mutations.ts:63` | `useUpdateTicket` | PATCH /tickets/:id |
| `apps/web/src/api/tickets/mutations.ts:257` | `useDispatchTicket` | POST /tickets/:id/dispatch |
| `apps/web/src/hooks/use-work-orders.ts:76` | `useUpdateWorkOrder` | PATCH /work-orders/:id |
| (TBD: useGrantApproval) | approval grant on ticket target | POST /approvals/:id/respond |
| (TBD: useReclassifyTicket) | reclassify | POST /tickets/:id/reclassify |
| (TBD: useReassignTicket / useReassignWorkOrder) | reassign endpoints | POST .../reassign |

**Frontend cutover sequence (B.2.A foundation):** the hook updates
ship BEFORE the `RequireClientRequestIdGuard` activates — otherwise
the guard 400s every existing client request. Order:
1. Update each hook to accept `requestId` in mutation variables
   (Pattern A); update every call site to mint via `useMemo` per
   form-submit attempt and pass it to `mutate(...)`.
2. Ship the hook changes, smoke-test that the header arrives.
3. THEN attach the guard to the producer routes. The guard's
   `req.actor.client_request_id` is now populated on every legit
   request; missing → 400 surfaces a real bug, not an existing
   caller.

This is the same staged pattern B.0.E.3 → B.0.E.4 used.

#### 3.9.2 I2 — Routing per-surface sync/async split

v1 §9 pushback #2 argued the routing engine was too big to port to
PG and should be deferred to outbox-driven async handlers. Codex
review pushed back: the engine size argument is correct, but
async-everywhere has a UX latency cost — on a fresh ticket create,
the requester would see "Submitting..." then "Routing..." then
finally an assigned ticket, with each step a separate spinner.

**v2 decision: split by surface.**

| Surface | Routing mode | Why |
|---|---|---|
| `POST /tickets` (create) | **sync** | Latency-critical. The requester sees the assigned team / SLA on the success page. Routing must be done before the response. |
| `POST /tickets/:id/dispatch` (manual + workflow `create_child_tasks`) | **sync** | Same. Operator/workflow expects the child WO to appear with the assignee shown. |
| Approval-grant follow-up routing (§3.5) | **async** | The user already sees "Approved"; the routing/assignment landing 1-2s later is fine. |
| Reclassify follow-up routing (§3.10) | **async** | Same — admin already sees "Reclassified to <new type>"; the new assignee landing on the next render tick is acceptable. |
| Re-routing on transition (e.g. waiting → open might re-route) | **async** | Background flow; no user blocking on the result. |

**Schema support.** Add `tickets.routing_status text not null
default 'idle'` with values `'idle' | 'pending' | 'failed'`. Async
re-routing flows set it to `'pending'` in the same tx as the
trigger event; the outbox handler clears it to `'idle'` (or sets
`'failed'` with a reason in `routing_failure_reason`) on resolution.
The desk UI reads `routing_status` and shows a small "Routing..."
chip when not idle. This makes the async-ness honest in the UI
rather than hidden.

**Sync-routing implementation.** In TS, before calling the create
or dispatch RPC, run `RoutingService.evaluate(...)` (read-only)
and pass the resolver result + trace into the RPC's payload. The
RPC stores the trace in `routing_decisions` atomically with the
INSERT. Same pattern v1 already proposed for §3.4 dispatch — v2
just affirms it for the create path and lists the surfaces
explicitly.

**Async-routing implementation.** The triggering RPC emits an
outbox event `routing.evaluation_required` (carries entity_id,
trigger_reason, payload context). The handler runs the resolver in
TS, calls `set_entity_assignment` RPC if the result differs,
clears `routing_status`. Mirrors the §3.5 + §3.10 patterns.

---

### 3.10 RPC `reclassify_ticket(p_ticket_id, p_tenant_id, p_actor_user_id, p_idempotency_key, p_payload)`

**Replaces:** §1.22 (ReclassifyService.execute).

**Signature:**
```sql
returns jsonb     -- { ticket: row, follow_ups: [...event types emitted] }
```

`p_payload = { new_request_type_id: uuid, reason?: string,
new_location_id?: uuid }`.

**Body sketch:**
1. Advisory lock + command_operations gate.
2. SELECT current ticket FOR UPDATE.
3. Validate new_request_type_id is tenant-owned + active.
4. Compute the cascade (does SLA change? workflow change? routing
   change?) by reading old + new request_type configs.
5. UPDATE tickets (request_type_id, possibly category / location).
6. INSERT ticket_activities (`reclassified`, payload includes
   old + new types).
7. INSERT domain_events (`ticket_reclassified`).
8. **Emit outbox events atomically (in the same tx):**
   - `sla.timer_repointed_required` if old.sla_policy_id !=
     new.sla_policy_id.
   - `workflow.start_required` if old.workflow_definition_id !=
     new.workflow_definition_id.
   - `routing.evaluation_required` (always — even if the new type
     might resolve to the same target, the resolver should re-run
     to record the breadcrumb).
9. Set `tickets.routing_status='pending'` (per §3.9.2) so the UI
   shows the routing-in-flight chip.
10. UPDATE command_operations.

**TS handlers** (sibling to existing `SetupWorkOrderHandler` from
B.0.E):
- `SlaTimerRepointHandler` — completes old timers, starts fresh
  ones with the new policy. Atomically writes
  `recompute_pending=true` on the new row (per §3.3); worker fills
  in `due_at`.
- `WorkflowRestartHandler` — cancels current `workflow_instances`
  row, starts a new one matching the new `workflow_definition_id`.
- `RoutingEvaluationHandler` — runs `RoutingService.evaluate(...)`,
  calls `set_entity_assignment` RPC if the target differs, clears
  `routing_status`.

**Sequencing:** B.2.B, after §3.0 + §3.2 land. The reclassify
handlers depend on the per-field RPCs being available.

---

### 3.11 RPC `create_ticket_with_automation(p_input, p_tenant_id, p_actor_user_id, p_idempotency_key)` (v3 / C1 fix)

**Replaces:** §1.2 (TicketService.create + runPostCreateAutomation).
v1 surveyed §1.2 as critical; v2 left it without a matching RPC and
partly deferred in §8.4. Codex review noted "Do not claim the
critical create surface is closed while leaving it split." v3 closes
the gap.

**Signature:**
```sql
returns jsonb     -- { ticket: row, follow_ups: ['sla', 'routing', 'workflow', 'approval'] }
```

`p_input` carries the create payload: `request_type_id, requester_person_id,
title, description, priority?, location_id?, asset_id?, assigned_team_id?,
assigned_user_id?, attendee_person_ids?, watcher_person_ids?, parent_ticket_id?,
booking_id?, source, metadata?`. TS pre-mints `ticket_id` deterministically
from the idempotency key.

**Body sketch:**
1. Advisory lock + `command_operations` gate (same pattern as §3.0).
2. Validate every FK ref in `p_input` is tenant-owned via existing
   helpers (`validate_assignees_in_tenant`, `validate_entity_in_tenant`
   for parent_ticket_id, etc.). request_type_id check against
   `request_types(id, tenant_id)` is critical because every cascading
   side-effect derives from its config.
3. SELECT request_types config FOR SHARE (it drives the rest of the
   flow): `requires_approval`, `sla_policy_id`, `workflow_definition_id`.
4. INSERT into `tickets` with the pre-minted id. Status:
   - if `requires_approval` → `'pending_approval'`
   - else → `'new'`
5. INSERT `ticket_activities (ticket_id, event='ticket_created', ...)`.
6. INSERT `domain_events (event_type='ticket_created', ...)`.
7. Branch on `requires_approval`:
   - **YES** → call `approvalService.createSingleStep` equivalent inline
     as a private helper:
     - INSERT `approvals (target_entity_type='ticket', target_entity_id=ticket_id, status='pending', ...)`.
     - INSERT `domain_events (event_type='approval_requested', ...)`.
     - INSERT `ticket_activities (event='approval_requested', ...)`.
     - **No** SLA timers, **no** routing, **no** workflow start yet.
       Those land when the approval is granted (via §3.5).
   - **NO** (no approval gate) → emit post-create automation outbox
     events atomically in the same tx:
     - *(if request_type has SLA)* `sla.timer_recompute_required`
       carrying tenant_id, ticket_id, sla_policy_id. Handler is the
       `SlaTimerHandler` (B.0.E sibling) — INSERTs sla_timers + UPDATEs
       ticket due-dates with the existing `recompute_pending=true`
       semantics from §3.3 (worker fills in `due_at`).
     - `routing.evaluation_required` carrying tenant_id, ticket_id,
       trigger_reason='create'. Handler runs the routing engine in TS,
       calls `set_entity_assignment` RPC if a target was resolved,
       writes a `routing_decisions` row with the trace, and clears
       `tickets.routing_status` (or sets it to `'failed'` with
       `routing_failure_reason` if the resolver couldn't pick).
     - *(if request_type has workflow)* `workflow.start_required`
       carrying tenant_id, ticket_id, workflow_definition_id. Handler
       starts the workflow instance via the existing
       `workflowService.startInstance` TS path.
     - Set `tickets.routing_status='pending'` atomically with the
       INSERT. UI shows the routing-in-flight chip until the handler
       clears it.
8. UPDATE `command_operations` to outcome='success'.
9. Return `{ ticket: row, follow_ups: [...event types emitted] }`.

**Why this is one RPC, not three.** The decisive question: can the
ticket exist without ANY of the post-create side-effects firing? On
the no-approval branch, today's code creates the ticket then calls
`runPostCreateAutomation` which fans into routing + SLA + workflow
in TS. If the ticket commits but routing/SLA/workflow fails, the
ticket is in a partial-onboarding state — assignee stale, SLA
queue blind, workflow never started. The RPC closes that gap by
emitting all three outbox events atomically with the ticket INSERT.
Either all-fire-or-none-fire. Same architectural rule the other
B.2 RPCs apply.

**TS plan-build phase:**
- Mint `ticket_id` deterministically: `uuidv5(idempotency_key, ns)`.
- Authorization (callerCanCreate per request_type permissions) —
  TS-side, before the RPC.
- Read-only resolver pre-flight is **not** done here. Routing fires
  async via outbox — see §3.9.2 for the per-surface decision. The
  trade-off accepted: ticket appears with `routing_status='pending'`
  until the handler resolves. Per §3.9.2 v2, this is the right call
  for create — routing is fire-and-forget UX-wise (the user already
  sees the success page; the assigned-team chip lands on the next
  render tick).

**Idempotency.** Same key reused → cached_result. Different payload
on same key → `command_operations.payload_mismatch` (mirror §3.0).
This makes "user double-clicks Submit" safe: same client_request_id
= same id, same payload = same result.

**Workflow re-entrancy.** When approval is granted on a
requires_approval ticket, §3.5's `grant_ticket_approval` RPC handles
the post-grant automation (SLA + routing + workflow). v3 §3.5's
"Body sketch" step 8 emits `workflow.start_required` for the same
reason — symmetric with this RPC's no-approval branch.

**Sequencing:** B.2.B, alongside §3.5 + §3.10 (the post-grant /
post-reclassify cousins). The handler set is shared
(`SlaTimerHandler` + `RoutingEvaluationHandler` + `WorkflowStartHandler`)
so handler implementation is one effort across all three RPCs.

---

## 4. Migration plan

Numbering starts at 00316 (B.0 ended at 00315).

| # | File | Purpose |
|---|---|---|
| 00316 | `command_operations_table.sql` | New idempotency table (§3.7). |
| 00317 | `validate_assignees_in_tenant_helper.sql` | Drop-in for TS helper. |
| 00318 | `validate_entity_in_tenant_helper.sql` | Tenant-validate (case\|wo).id. |
| 00319 | `sla_timers_recompute_pending_column.sql` | C3 fix — `recompute_pending boolean` + partial index. Required before §3.1 / §3.3. |
| 00320 | `tickets_routing_status_column.sql` | I2 fix — `routing_status text` (default `'idle'`, values `'idle'\|'pending'\|'failed'`) + `routing_failure_reason text` for async-routing surfaces. |
| 00321 | `transition_entity_status_rpc.sql` | §3.1. |
| 00322 | `set_entity_assignment_rpc.sql` | §3.2. |
| 00323 | `update_entity_sla_rpc.sql` | §3.3 (with recompute_pending semantics). |
| 00324 | `update_entity_combined_rpc.sql` | §3.0 — the controller-facing orchestrator (was §3.6 in v1, now generic). |
| 00325 | `dispatch_child_work_order_rpc.sql` | §3.4. |
| 00326 | `dispatch_child_work_orders_batch_rpc.sql` | §3.4 batch variant. |
| 00327 | `grant_ticket_approval_rpc.sql` | §3.5. |
| 00328 | `reclassify_ticket_rpc.sql` | §3.10 (C4). |
| 00329 | `update_entity_metadata_rpc.sql` | Plain audit-row write for plan / priority / metadata branches (called from §3.0 + standalone). |
| 00330 | `command_operations_grants.sql` | service_role grants (mirror 00301/00314). |
| 00331 | `outbox_events_b2_handlers.sql` | Outbox event types for routing rerun + sla timer recompute + workflow restart. |
| 00332 | `create_ticket_with_automation_rpc.sql` | §3.11 (v3 / C1) — atomic ticket create + automation outbox emit. |

17 migrations. Up from v2's 16 — adds the create_ticket_with_automation
RPC (C1). `routing_failure_reason` column folded into 00320 alongside
`routing_status` (no extra migration).

**Cutover plan:**
- Direct cutover (no shadow mode) for §3.0 (the orchestrator), §3.1,
  §3.2, §3.3, §3.5, §3.10. The outcome-shape is the same (the RPC
  returns the row), the audit rows look identical, and rollback is
  "stop calling the RPC".
- **Shadow mode for §3.4 (dispatch) and §1.21 (workflow `assign` +
  `update_ticket` nodes).** Reasoning: the workflow
  engine's `create_child_tasks` loop and the `assign` /
  `update_ticket` nodes are hit at unpredictable times
  by tenant workflow definitions; flipping them without a shadow run
  is risky. Mirror the B.0 setup-WO-handler pattern: TS still
  writes the legacy way, RPC writes a shadow row, smoke probe
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
| §3.0 update_entity_combined (generic orchestrator) | 4-6 | 1 | 18 | 4 |
| §3.1 transition_entity_status (helper) | 2-3 | 1 | 12 | 2 |
| §3.2 set_entity_assignment | 3-4 | 1 | 14 | 2 |
| §3.3 update_entity_sla (with recompute_pending) | 3-4 | 2 (RPC + column) | 12 | 2 |
| §3.4 dispatch_child_work_order | 4-5 | 2 (single + batch) | 16 | 3 |
| §3.5 grant_ticket_approval | 3-4 | 1 | 10 | 2 |
| §3.7 command_operations table + helpers | 2 | 3 | 6 | — |
| §3.9.1 RequireClientRequestIdGuard wave | 2-3 | — | 8 | 1 |
| §3.9.2 routing_status column + async handlers | 2-3 | 2 (column + outbox events) | 10 | 2 |
| §3.10 reclassify_ticket RPC + handlers | 3-4 | 1 | 12 | 2 |
| §3.11 create_ticket_with_automation RPC + 3 handlers | 3-4 | 1 | 14 | 3 |
| Workflow-engine `assign` + `update_ticket` cutover (§1.21) | 2-3 | — | 8 | 2 |
| TS call-site cutover (controller PATCH endpoints) | 3-5 | — | (covered above) | — |
| `pnpm smoke:wo-commands` | 1-2 | — | — | (script itself) |
| Closing slice (legacy tag, retro) | 1-2 | 1-3 | — | — |
| **TOTAL** | **35-48** | **16-19** | **~140** | **~25** |

**B.0 was 29 commits + 14 migrations + 97 specs. v3 B.2 is
bigger: 35-48 commits + 16-19 migrations + ~140 specs.** Growth from v2 (32-44
commits) is +3-4 commits for the new §3.11 create_ticket_with_automation
RPC + handlers (C1 fix). v3's totals reflect ~+45-65% on all dimensions
vs v1 — reasonable for closing every multi-step write codex flagged.

**Recommendation: split B.2 into B.2.A and B.2.B.**

- **B.2.A — foundation + controller-facing orchestrator
  (≈20-26 commits).** Includes:
  - `command_operations` table + helpers (§3.7).
  - `sla_timers.recompute_pending` column (C3).
  - `tickets.routing_status` column (I2).
  - `RequireClientRequestIdGuard` wave on every PATCH /
    dispatch / approval / reclassify endpoint (I1).
  - Per-field internal helper RPCs §3.1 (status), §3.2
    (assignment), §3.3 (SLA with recompute_pending).
  - `update_entity_combined` orchestrator §3.0 — both PATCH
    controllers cut over.
  - Smoke probe extension.

- **B.2.B — dispatch + approval + reclassify + workflow nodes
  (≈12-18 commits).** §3.4 dispatch (with batch variant +
  workflow-engine create_child_tasks cutover) + §3.5
  grant_ticket_approval + §3.10 reclassify_ticket + outbox handlers
  for routing rerun / SLA recompute / workflow restart + §1.21
  workflow-engine `assign` + `update_ticket` node cutover.

The split aligns with B.0's staged pattern (B.0.A foundation → B.0.B
RPCs → B.0.C TS plan-builder → B.0.D cutover → B.0.E handler →
B.0.F smoke + retro). v2 B.2.A is "foundation + I1 guard + the
generic orchestrator"; B.2.B is "dispatch + approval + reclassify
+ workflow nodes + cleanup".

---

## 7. Sequencing recommendation

Within B.2.A:

1. **Foundation first** (1-2 days): `command_operations` table,
   `validate_assignees_in_tenant`, `validate_entity_in_tenant`,
   `compute_entity_state_diff`, `sla_timers.recompute_pending`
   column + reader-side WHERE-clause migration to add
   `AND recompute_pending = false` to every existing breach /
   threshold reader, `tickets.routing_status` column. No call-site
   behavior change yet.

2. **I1 guard wave** (1 day):
   `RequireClientRequestIdGuard` attached to every PATCH /
   dispatch / approval / reclassify / reassign endpoint. Service
   methods accept the threaded `actor.client_request_id`. No RPC
   call yet, just the plumbing.

3. **§3.1 transition_entity_status helper** (3-4 days): RPC + mocked
   specs. Not yet wired to controllers — will be composed by §3.0.

4. **§3.2 set_entity_assignment** (3-4 days): RPC + mocked specs.
   Same — composed by §3.0; also called directly by future
   reclassify / workflow `assign` cutovers.

5. **§3.3 update_entity_sla** (2-3 days): RPC + mocked specs +
   recompute_pending semantics validated against the breach cron
   (the reader-side migration in step 1 is the gate).

6. **§3.0 update_entity_combined orchestrator** (4-5 days): RPC
   that composes §3.1 + §3.2 + §3.3 + plan/priority/metadata.
   PATCH controllers cut over here — first
   `PATCH /work-orders/:id` (smaller blast radius), then
   `PATCH /tickets/:id`.

7. **B.2.A smoke probe extension + retro** (1-2 days): port
   `pnpm smoke:work-orders` to assert the RPC path; ship a
   `b2a-shipped.md` retrospective.

Then B.2.B. Order matters here too — workflow + reclassify both
call into §3.2 and §3.0:

8. **§3.4 dispatch + batch variant** (4-5 days). Routing-engine
   integration (sync per I2) + workflow-engine `create_child_tasks`
   batch cutover.
9. **§1.21 workflow-engine `assign` + `update_ticket` cutover**
   (2-3 days). Replace direct `tickets.UPDATE` calls with §3.2
   and §3.0 invocations. Idempotency key
   `workflow:${instance_id}:${node_id}:${execution_token}`.
10. **§3.5 grant_ticket_approval + outbox routing-evaluation
    handler** (3-4 days). Mirrors B.0.D.3 structurally.
11. **§3.10 reclassify_ticket RPC + 3 outbox handlers**
    (4-5 days). Last in the dependency chain — depends on §3.2
    and §3.0 for handler implementations.
12. **§3.11 create_ticket_with_automation RPC** (3-4 days). Reuses
    the same handler trio as §3.10 (`SlaTimerHandler` /
    `RoutingEvaluationHandler` / `WorkflowStartHandler`); marginal
    cost is the RPC body + an approval-gate sub-branch. Cuts over
    `POST /tickets` controller. Includes cutover for
    `runPostCreateAutomation` direct callers (e.g. workflow state
    transitions that re-fire create automation) — those route
    through the same RPC with a fresh idempotency key per re-fire.
13. **Closing retro** (1 day). `b2-shipped.md`.

**Why this order works (v2):** §3.0 is now the load-bearing piece
— it's the controller-facing orchestrator and depends on §3.1 +
§3.2 + §3.3 as internal helpers. Workflow + reclassify cutovers
follow because they re-use §3.2 / §3.0 as building blocks.

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

The orchestrator pattern is a hammer; not everything is a nail.
v3 narrows the "stay TS-side" list — §1.2 `TicketService.create()`
is no longer in this category (now covered by §3.11
`create_ticket_with_automation`). The remaining patterns:

- **~~`TicketService.create()` non-approval-gate happy path.~~**
  v3 RETRACTED — codex review (C1) correctly flagged that leaving
  this split is "claiming the critical create surface is closed
  while leaving it split". v3 adds `create_ticket_with_automation`
  RPC at §3.11. The non-approval-gate path emits 3 outbox events
  (sla / routing / workflow) atomically with the ticket INSERT.
  The approval-gate path INSERTs the approval row inline + waits
  for grant; §3.5 handles post-grant automation symmetrically.

- **`runPostCreateAutomation` routing fan-out.** The routing engine
  is too big to port; the existing fail-soft semantics (catch +
  log + continue, leave a breadcrumb activity) are honest about
  the trade-off. **Outbox event** is the right shape: emit
  `routing.evaluation_required` from the create RPC (§3.11), let
  the existing TS routing service handle it. Same approach as
  §3.5 + §3.10.

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

### 8.6 [CLOSED] SLA resume safety under async due-date recompute

v1 left this open with a recommendation to defer business-hours
math to an outbox handler. **Codex review (C3) showed this was
unsafe** — see §3.3 v2 update. **Decision: add `recompute_pending`
boolean on `sla_timers`, set atomically with `paused=false`, all
breach readers add `AND recompute_pending=false`, worker clears
the flag when due_at is recomputed.** No further open question.

### 8.7 Routing sync vs. async per surface

v1 §9 pushback #2 leaned async-everywhere. **v2 decision: split
per surface** (see §3.9.2). Sync for create + dispatch
(latency-critical UX); async with `routing_status` column for
re-routing / approval / reclassify follow-ups. The split is in the
spec; the implementation per-surface is settled. Open sub-question:
**should we include a hybrid path** where create runs sync routing
but degrades to async-with-status if the resolver takes >500ms?
Not in scope for B.2 — defer to a v3 polish pass if real numbers
show the resolver is slow enough to hurt P95 create latency.

---

## 9. Pushback

The combined-RPC pattern is the right shape for §3.0, §3.1, §3.2,
§3.3, §3.4, §3.5, §3.10. **No pushback on the critical 8.**

### 9.1 [STILL VALID] §1.5 bulkUpdate

`bulkUpdate` doesn't need an RPC. It's already one statement at the
row level; the partial-commit hazard doesn't exist. The audit drift
it has (no per-field activity emission) is a separate UX choice,
not a B.2 concern.

### 9.2 [v2 NARROWED] Routing engine porting vs. outbox

**v1 position:** routing engine is too big to port to PG, so every
routing-driven write should be deferred to a TS outbox handler.
**v2 position (after I2):** the engine is still too big to port —
that part stands — BUT outbox-everywhere is wrong UX. Sync routing
on create + dispatch (the latency-critical surfaces); async
outbox-driven routing with `tickets.routing_status` for re-routing
/ approval-grant follow-up / reclassify follow-up. See §3.9.2 for
the per-surface table.

### 9.3 [RETRACTED] Async SLA resume safety

**v1 claimed:** SLA pause/resume could safely defer due-date
recompute to a TS outbox handler because nothing reads the new
due-date during the gap. **Codex review (C3) showed this is
WRONG.** The breach cron at `sla.service.ts:333` reads
`paused=false` AND a stale `due_at`, sees the timer "should have
fired" within the gap window, and emits a false breach. The
race is small (RPC commit → worker recompute) but real, and on a
busy tenant the cron tick runs every 30s.

**v2 fix:** add `sla_timers.recompute_pending boolean` set
atomically with `paused=false`; all breach / threshold readers add
`AND recompute_pending=false`; worker recomputes `due_at` and
clears the flag in one tx. See §3.3 v2 for the detail. This
section is left as a marker — the v1 reasoning was wrong, the
v2 schema fix is in.

### 9.4 [STILL VALID] §1.16 fireThreshold escalation cron

The only honest case where "we decided to live with the duplication
window". The class comment documents the trade-off. **Recommend
wrapping it in an RPC anyway** because the cost is low (one RPC,
~50 lines of PL/pgSQL) and the rule is consistent. Schedule for
B.2.B's tail end.

### 9.5 [STILL VALID] §1.17 SLA helpers as standalone

The helpers don't need their own RPCs — they're called from inside
the RPCs in §3.1, §3.3, §3.0 which already wrap them in tx. The
cron paths can stay TS-side temporarily and cut over later (the
cron writes are bounded; partial-commit on cron has a "next tick
will fix it" recovery semantic).

### 9.6 [STILL VALID] §1.6 createBookingOriginWorkOrder

Small enough that folding it into the existing
`create_setup_work_order_from_event` RPC (00312, B.0.B) is a
one-line scope addition — pull the activity + domain_event INSERT
into that RPC instead of TS. **Recommend: do this in B.2.A as a
free extra**, not its own RPC.

### 9.7 [v2 SUPERSEDED] §3.6 orchestrator vs. per-field RPCs

v1 framed this as "ship both: per-field RPCs as primitives,
orchestrator as the controller-facing one". v2 keeps that decision
but restates it with the corrected naming: §3.0
`update_entity_combined` is the controller-facing orchestrator;
§3.1-§3.3 are internal helpers that the orchestrator composes,
also exposed as RPCs for the narrow non-controller callers (cron
escalation, workflow `assign` node, reclassify outbox handlers,
admin one-shots). PATCH controllers call ONLY §3.0.

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
