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

- **v4 (2026-05-06 evening).** Folds codex-v3 review findings.
  Headline changes:
  - **C1.** Routing contract on `POST /tickets` create reconciled.
    v3 §3.9.2 said sync; v3 §3.11 silently went async (emitted
    `routing.evaluation_required` always, set `routing_status='pending'`).
    v4 makes create **sync-routing**, matching the existing TS code:
    TS plan-build runs `RoutingService.evaluate(...)` BEFORE the RPC
    and passes `routing_decision` + `routing_trace` into `p_input`.
    The RPC writes `routing_decisions` + `tickets.assigned_*`
    atomically. `routing_status` stays `'idle'` after create. The
    RPC also **skips routing if `p_input` already includes
    `assigned_team_id`/`assigned_user_id`/`assigned_vendor_id`**
    (current code's behavior). Async `routing.evaluation_required`
    only fires from §3.5 (post-grant) and §3.10 (reclassify).
  - **C2.** `WorkflowStartHandler` idempotency was relying on a
    nonexistent `workflow_instances UNIQUE (tenant_id, ticket_id)`
    constraint. The DB only has the non-unique
    `idx_wi_ticket` (`supabase/migrations/00009_workflows.sql:47`),
    and `WorkflowEngineService.startForTicket`
    (`workflow-engine.service.ts:172`) blindly inserts. Handler
    replay would create duplicate workflow instances. v4 adds a
    real dedup primitive via migration 00333 — partial unique index
    on `workflow_instances (tenant_id, ticket_id)` WHERE
    `status IN ('active', 'waiting')`. The handler does
    `INSERT ... ON CONFLICT DO NOTHING`; if a row already exists,
    treats it as already-started and returns no-op. Implementation
    note added to §3.5 step 8 + new "Handler contract" subsection.
  - **C3.** `execution_token` persistence is fixed via a new
    table `workflow_node_executions` (migration 00334) — written by
    the workflow engine BEFORE each node body fires, with
    `UNIQUE (workflow_instance_id, node_id, attempt)`. v3's claim
    that the token would be persisted on `workflow_instance_events`
    (the audit-only table whose `emit()` swallows insert failure
    at `workflow-engine.service.ts:687`) was wrong — that table has
    no unique key per node fire and `emit()` is best-effort. v4's
    `workflow_node_executions` is the durable record. The engine
    writes the row BEFORE invoking the node body; on retry-after-
    engine-restart, the same `(instance_id, node_id, attempt)` row
    is found and its `execution_token` is reused → same idempotency
    key → command RPC returns cached result. §1.21 + §3.0 + §3.2
    idempotency-key wording rewritten to reference this table.
  - **I1.** Frontend hook citation table at §3.9.1 corrected.
    v3 had `mutations.ts:257` as `useDispatchTicket` — that line is
    actually `useUpdateWorkOrder`. Dispatch is at
    `apps/web/src/hooks/use-work-orders.ts:73` as
    `useDispatchWorkOrder`. `useRespondApproval` already exists at
    `api/approvals/index.ts:57` and **already threads `requestId`
    via `X-Client-Request-Id`** — so no hook update is needed; the
    guard can attach immediately. `useReclassifyTicket` is at
    `hooks/use-reclassify.ts:121`. `useReassignTicket`
    (`mutations.ts:104`) and `useReassignWorkOrder`
    (`mutations.ts:316`) are real, listed.
  - **I2.** Portal create path added to §3.11 cutover. Per
    `apps/api/src/modules/portal/portal-submit.service.ts:35`,
    `PortalSubmitService.submit` ALSO calls `TicketService.create`,
    so cutting over to `create_ticket_with_automation` requires
    updating both `TicketController` and `PortalSubmitService`.
    Frontend posts via `apps/web/src/pages/portal/submit-request.tsx:230`.
    `RequireClientRequestIdGuard` endpoint list (§3.9.1) gains
    `POST /portal/submit`.
  - **I3.** Handler contract consolidated. v3 had §3.5 doing inline
    SLA insert, §3.11 using `SlaTimerHandler`, §3.10 using
    `SlaTimerRepointHandler` — three behaviors for the same
    operation family. v4 defines four canonical handlers (new
    "Handler contract" subsection §3.9.3) and rewrites §3.5 step 8
    to emit `sla.timer_recompute_required` outbox event (matching
    §3.11's pattern) instead of the inline insert. All three RPCs
    that drive post-grant / post-create / post-reclassify SLA work
    now use the same handler.
  - **Nit.** §3.11 input enumeration: drop `attendee_person_ids`
    (no such column / table on the ticket surface; per
    `ticket.service.ts:76`, the watcher field is `watchers: string[]`,
    not `watcher_person_ids`). Both fields corrected.
  - Migration count: 17 → 19. Adds 00333
    (`workflow_instances_active_unique_index.sql`, C2) and 00334
    (`workflow_node_executions_table.sql`, C3).
    Commit count 35-50.

- **v5 (2026-05-07).** Folds codex-v4 review findings.
  Headline changes:
  - **C1.** §3.11 silently dropped scope-override resolution. The
    current TS code at `apps/api/src/modules/ticket/ticket.service.ts:743`
    derives `effectiveLocation` via `ScopeOverrideResolverService`,
    then at `:747` resolves the per-location scope override, then
    at `:754` / `:758` picks `effectiveWorkflowDefinitionId` and
    `effectiveCaseSlaPolicyId` (override wins, else request_type
    config). v4 §3.11 only SELECTed raw `request_types.*` config —
    so any tenant with `request_type_scope_overrides` rows would
    get the wrong SLA / workflow on create. v5 fix: TS plan-build
    computes the **automation plan** (effective_location_id,
    effective_workflow_definition_id, effective_sla_policy_id,
    scope_override_id, routing_decision, routing_trace) BEFORE
    calling the RPC; RPC accepts it as `p_automation_plan` and
    validates each FK is tenant-owned via existing helpers. Same
    "TS plans, Postgres commits the plan atomically" rule from B.0.
  - **C2.** §3.9.3 SLA handler contract was structurally invalid.
    `sla_timers` has no `state` column
    (`supabase/migrations/00011_tickets.sql:90`); `due_at` is
    `NOT NULL` (`:98`); the only "active" index is non-unique on
    `(stopped_at IS NULL AND completed_at IS NULL)`
    (`supabase/migrations/00044_reclassify_support.sql:34`). v4's
    "INSERT with due_at=NULL and recompute_pending=true" violates
    today's schema. v5 rewrites:
    1. `SlaTimerHandler` computes `due_at` in TS (mirroring the
       existing `apps/api/src/modules/sla/sla.service.ts:73`
       `startTimers` pattern: policy minutes + business calendar
       + ticket created_at) and INSERTs with due_at filled,
       `recompute_pending=false`. The `recompute_pending=true`
       semantics from §3.3 apply only to the **existing-timer
       update path** (waiting-state resume) where due_at needs
       recomputation, never to fresh inserts.
    2. New migration 00335 adds a partial unique index on
       `sla_timers (tenant_id, ticket_id, sla_policy_id, timer_type)`
       WHERE `stopped_at IS NULL AND completed_at IS NULL` to
       enforce "one active timer per (ticket, policy, timer_type)"
       so `INSERT ... ON CONFLICT DO NOTHING` works.
    3. §3.3 / §3.11 / §3.5 wording updated to reference existing
       schema columns; bogus `state='active'` references removed.
  - **I1.** Migration 00333 (workflow_instances unique index)
    needs preflight. v4 said "create the index" without checking
    whether existing rows violate it. v5 adds explicit preflight
    SQL + cleanup decision tree to migration 00333: (a) duplicate
    detection query; (b) abort with a clear error if duplicates
    exist; (c) operator runs cleanup separately (cancel duplicates
    keeping most-recent `created_at`); (d) re-run migration. No
    silent cleanup inside the migration — the consequence of
    cancelling a real active workflow is too high to automate.
  - **I2.** §1.21 / §3.0 / migration 00334 wording: drop the
    "engine commits row outcome inside the same transaction"
    claim. The workflow engine uses Supabase HTTP calls (separate
    txs per call), so a shared tx with the workflow_instances
    UPDATE is impossible without a new RPC. v5 simplifies: drop
    the `status` column from `workflow_node_executions`. The table
    holds only `(id, tenant_id, instance_id, node_id, attempt,
    execution_token, fired_at)`. The token is the only durable
    artifact needed for command idempotency; node-fire outcome
    stays best-effort in `workflow_instance_events`. If a future
    iteration needs atomic outcome tracking, it adds a small
    `commit_node_execution_outcome` RPC.
  - **I3.** Portal route corrected throughout. v4 said
    `POST /portal/submit`; the actual controller route at
    `apps/api/src/modules/portal/portal.controller.ts:111` is
    `POST /portal/tickets`, and the frontend posts there at
    `apps/web/src/pages/portal/submit-request.tsx:230`. §3.9.1
    guard list, §3.11 cutover scope, and the §3.9.1 hook table
    all updated.
  - **I4.** Async routing handler must distinguish "no target
    matched" (valid unassigned outcome per
    `docs/assignments-routing-fulfillment.md:149`) from "handler
    or validation error." v4 §3.9.2 + §3.9.3 wrote both as
    `routing_status='failed'`. v5 fix: unassigned (resolver
    matched zero rules → `chosen_by='unassigned'`) sets
    `routing_status='idle'` with an `unassigned` decision row in
    `routing_decisions`. `'failed'` is reserved for genuine
    errors (resolver throws, FK validation rejects, RPC errors).
    Same in §3.11 (sync path is symmetric).
  - Migration count: 19 → 20. Adds 00335
    (`sla_timers_active_unique_index.sql`, C2). Commit count
    37-52.

- **v6 (2026-05-07).** Folds codex-v5 review findings.
  Headline changes:
  - **C1.** Column name corrected. v5 §3.11 wrote
    `workflow_definition_id` onto the `tickets` row, but the
    actual column is `tickets.workflow_id` per
    `supabase/migrations/00011_tickets.sql:22`. Note the asymmetry:
    config tables (`request_types`, `request_type_scope_overrides`)
    carry `workflow_definition_id`; the runtime ticket carries
    `workflow_id` (which references the same target). v6 fixes
    every spec mention to write the right column.
  - **C2.** `SlaTimerHandler` cannot do the TS-side
    INSERT-then-UPDATE pattern v5 described — that's the same
    split write the existing `sla.service.ts:87/100/122`
    `startTimers` has, and it's exactly what B.2 is supposed to
    eliminate. v6 introduces two atomic RPCs:
    1. New migration 00336 `start_sla_timers_rpc.sql` —
       `start_sla_timers(p_tenant_id, p_ticket_id, p_sla_policy_id,
       p_timers jsonb)` does INSERT timer rows + UPDATE
       `tickets.sla_response_due_at` / `sla_resolution_due_at`
       atomically. `ON CONFLICT DO NOTHING` against migration
       00335's partial unique index for replay safety.
    2. New migration 00337 `repoint_sla_timer_rpc.sql` —
       `repoint_sla_timer(p_tenant_id, p_ticket_id, p_sla_policy_id,
       p_timers jsonb, p_reason text)` UPDATEs old active timers
       to `stopped_at=now(), stopped_reason=$reason` + INSERTs
       fresh ones + UPDATEs ticket due-dates atomically.
    The handlers do `policy.SELECT → calendar.SELECT → compute due_at
    in TS → call atomic RPC`. TS still owns the business-hours math
    (the existing `BusinessHoursService.addBusinessMinutes` path),
    but the writes happen in one PG transaction.
  - **I1.** `validate_entity_in_tenant` (migration 00318) was
    defined as a `(tickets|work_orders)` validator. v5 §3.11 used
    it to validate `spaces`, `request_type_scope_overrides`,
    `workflow_definitions`, and `sla_policies` — types it doesn't
    handle. v6 expands 00318 to add four dedicated validators (one
    per table), each a small SECURITY DEFINER function that
    accepts `(p_tenant_id uuid, p_id uuid)` and returns void or
    raises if not found. Pattern matches the existing
    `validate_assignees_in_tenant` (migration 00317). The §3.11
    body sketch enumerates which validator to use for which
    automation-plan field.
  - **I2.** Automation-plan tenant validation alone is not
    sufficient. A buggy/stale TS plan could pass tenant validation
    but still select the wrong workflow/SLA. v6 adds **semantic
    re-derivation** inside `create_ticket_with_automation`: the
    RPC re-runs the resolution chain
    (`request_type_effective_scope_override` PG function from
    migration 00096 → effective config) and asserts equality with
    `p_automation_plan.effective_workflow_definition_id` and
    `p_automation_plan.effective_sla_policy_id`. Mismatch → reject
    with `automation_plan.semantic_mismatch` AppError carrying both
    the TS-supplied and PG-derived values for debugging. For
    routing, the RPC asserts `p_automation_plan.routing_trace.input`
    matches `(request_type_id, effective_location_id, asset_id)`
    from `p_input` — proves the resolver ran on the right tuple
    even though the resolver itself stays in TS. Caught-mismatch
    rate is the early warning for cache staleness or TS bugs.
  - **I3.** Migration 00333 cleanup runbook corrected and made
    explicit. v5 said "operator runs cleanup separately keeping
    most-recent `created_at`" but `workflow_instances` has
    `started_at` (`supabase/migrations/00009_workflows.sql:38`),
    not `created_at`. v6 fixes the column name and includes the
    full cleanup SQL inline as a runbook (not just hand-wave).
  - **I4.** Migration 00335 cleanup is now explicit. v5 said
    "same preflight pattern" without specifying the cleanup query
    for active SLA timers (which can affect breach history and
    due-date display). v6 adds: detection query that groups by
    `(tenant_id, ticket_id, sla_policy_id, timer_type)` with
    count > 1 among active rows; cleanup SQL preserves the
    `id`-MIN row per group (canonical timer) and STOPs the rest
    with `stopped_at=now(), stopped_reason='deduplicated_pre_index'`
    — preserves audit trail, no breach history loss.
  - **Nit.** `SlaTimerHandler` `started_at` corrected. v5 said
    "started_at=now()" by default but the handler runs async after
    the ticket is created — the SLA clock conceptually runs from
    when the customer asked (ticket.created_at), not from when the
    handler ran. Existing `startTimers` at `sla.service.ts:84`
    uses `new Date()` because it's invoked synchronously from
    create — that timing happens to match. The async handler must
    pass `started_at = ticket.created_at` explicitly to preserve
    the same semantics.
  - Migration count: 20 → 22. Adds 00336 (`start_sla_timers_rpc.sql`,
    v6 / C2) and 00337 (`repoint_sla_timer_rpc.sql`, v6 / C2).
    Commit count 39-55.

  Codex v5 also confirmed: workflow_node_executions being
  token-only is acceptable for the command-idempotency goal — a
  crash before or after the command should reuse the same token
  while the workflow is still on that node. No further change to
  that table's design.

- **v7 (2026-05-07).** Folds codex-v6 review findings.
  Headline changes:
  - **C1.** PG function signature corrected. v6 §3.11 step 2a
    called `request_type_effective_scope_override(p_input.request_type_id,
    effective_location_id)` but the actual signature per
    `supabase/migrations/00096_effective_scope_override.sql:10` is
    `(p_tenant_id uuid, p_request_type_id uuid, p_selected_space_id uuid)
    returns jsonb`. The proposed call would not compile. v7 fixes
    the call shape and the result-handling: the function returns a
    jsonb object (or NULL); the RPC reads `(result->>'workflow_definition_id')::uuid`
    and `(result->>'case_sla_policy_id')::uuid` for the equality
    assertions.
  - **C2.** Workflow restart contradiction. §3.10 reclassify
    emits `workflow.start_required` when workflow changes; the
    canonical handler does `INSERT ... ON CONFLICT DO NOTHING` per
    the migration 00333 partial unique index, which means a
    pre-existing active workflow instance silently no-ops the new
    workflow start — reclassify can't actually change the
    workflow. v7 fix: **fold cancellation into the
    `reclassify_ticket` RPC body** (mirroring the existing
    pattern at `supabase/migrations/00046_reclassify_preserve_parent_status.sql:65-77`).
    Inside the RPC's tx, before emitting `workflow.start_required`:
    UPDATE active workflow_instances rows for this ticket SET
    `status='cancelled'`, `cancelled_at=now()`,
    `cancelled_reason=p_reason`, `cancelled_by=p_actor_user_id`.
    With the active rows now `cancelled`, the partial unique
    index no longer matches and the handler's INSERT can succeed.
    `WorkflowRestartHandler` is **dropped** — there is no separate
    handler. `WorkflowStartHandler` is the only workflow-start
    handler; the RPC owns the cancellation.
  - **I1.** Effective-location re-derivation. v6 §3.11 step 2a
    only validated TS-supplied `effective_location_id` was
    tenant-owned, then trusted it to the override function. A
    same-tenant stale plan could pick the wrong location. v7 has
    PG independently re-derive: per
    `apps/api/src/modules/routing/scope-override-resolver.service.ts:111`,
    TS computes `effective_location = explicit_location ?? asset.assigned_space`.
    PG mirrors with: `coalesce(p_input.location_id, (select assigned_space_id from public.assets where id = p_input.asset_id and tenant_id = p_tenant_id))`.
    Assert equality with `p_automation_plan.effective_location_id`;
    mismatch → reject `automation_plan.effective_location_mismatch`.
  - **I2.** Ticket SLA column corrected. v6 wrote
    `sla_policy_id = p_automation_plan.effective_sla_policy_id`
    on tickets, but the runtime column is `sla_id` per
    `supabase/migrations/00011_tickets.sql:23`. Same class as
    v6 / C1 (workflow_definition_id → workflow_id). Every spec
    mention fixed.
  - **I3.** `repoint_sla_timer` idempotency restored. v6's body
    UNCONDITIONALLY stopped active timers in step 1, then
    inserted new ones — on replay, the second invocation would
    stop the *new* timer (now active) and create a third row.
    v7 fix: RPC starts with an idempotency short-circuit —
    `if exists(select 1 from sla_timers where tenant_id=$, ticket_id=$,
    sla_policy_id=p_sla_policy_id and stopped_at is null and
    completed_at is null)` then return `{ kind: 'already_repointed' }`.
    Else proceed: stop OLD timers (`sla_policy_id != p_sla_policy_id`,
    not all active timers), insert new, update ticket due-dates.
    Replay finds the new active timer, returns. No double-stop.
  - **I4.** 00335 cleanup heuristic corrected. v6 used `min(id)`
    on UUID, which has no meaning for v4 randoms. v7 makes the
    cleanup operator-driven: the runbook provides the audit query
    plus a template that the operator parameterizes by hand-picked
    `keep_id` per `(tenant_id, ticket_id, sla_policy_id, timer_type)`
    group, after reviewing breach state, due_at, started_at, and
    ticket SLA due-date columns.
  - **I5.** 00333 cleanup heuristic likewise made operator-driven.
    "Keep most-recent `started_at`" was unsafe — older instance
    may hold real progress/context. v7 also corrects the cleanup
    to write the established cancellation metadata
    (`cancelled_at`, `cancelled_reason`, `cancelled_by`) per
    `supabase/migrations/00046_reclassify_preserve_parent_status.sql:65-71`,
    not the v6 `completed_at` shortcut.
  - Migration count: 22 (unchanged — these are wording / body-
    sketch fixes). Commit estimate 39-55.


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
`workflow:${instance_id}:${node_id}:${execution_token}` — where
`execution_token` is read from the durable
`workflow_node_executions` row (migration 00334; see "execution_token
definition" below). Deterministic, retry-safe, replays cleanly
across engine restarts because the token row is the source of
truth. The `update_ticket` node calls `update_entity_combined`
(§3.0) with the same key shape. Both pass
`actor_user_id = SYSTEM_ACTOR_USER_ID` and a `source: 'workflow'`
breadcrumb in the activity payload so the audit feed labels the
row "by Workflow" not "by System".

**`execution_token` definition (v3 / I3 attempted fix; v4 / C3
real fix).** v3 said the engine would store the token on the
existing `workflow_instance_events` (a.k.a. "node_event") row.
Codex v3 review correctly flagged that as broken: that table is
append-only audit, has no UNIQUE key per node fire, and
`WorkflowEngineService.emit()`
(`apps/api/src/modules/workflow/workflow-engine.service.ts:687`)
**catches and swallows** insert failure — so writing the token there
is best-effort, not durable. Replay after engine restart cannot
reliably find "the same node fire" by reading
`workflow_instance_events`.

v4 introduces a new durable table via migration 00334. **v5 / I2
fix:** drops the `status` column. The workflow engine uses Supabase
HTTP calls (separate transactions per call), so the v4 claim of
"engine commits row outcome inside the same transaction that mutates
the workflow instance state" is impossible without a new RPC. v5
scopes the table to its essential job: persisting the execution
token. Outcome tracking stays in `workflow_instance_events`
(best-effort audit, as today). If a future iteration needs atomic
outcome tracking, it adds a small `commit_node_execution_outcome`
RPC. The token alone is sufficient for command idempotency, which
is the goal.

```sql
create table public.workflow_node_executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  workflow_instance_id uuid not null
    references public.workflow_instances(id) on delete cascade,
  node_id text not null,
  attempt int not null default 1,
  execution_token uuid not null default gen_random_uuid(),
  fired_at timestamptz not null default now(),
  unique (workflow_instance_id, node_id, attempt)
);

create index idx_wne_tenant on public.workflow_node_executions (tenant_id);
create index idx_wne_instance_node on public.workflow_node_executions
  (workflow_instance_id, node_id);

alter table public.workflow_node_executions enable row level security;
create policy "tenant_isolation" on public.workflow_node_executions
  using (tenant_id = public.current_tenant_id());
```

The workflow engine writes a `workflow_node_executions` row
**before** invoking the node body. The token in that row is the
seed for any command idempotency keys the node fires. On retry
(engine restart, queue redrive), the engine looks up
`(instance_id, node_id, attempt)`; if the row exists, reuses
its `execution_token` → same command idempotency key → command
RPC returns cached result. Fresh node fires (workflow-loop
iterations beyond the first attempt) bump `attempt` to get a
fresh token by construction.

`workflow_instance_events` keeps its current best-effort audit
semantics. It is **not** the source of truth for idempotency
(v5 / C3 from v4 still holds — that table's `emit()` swallows
failures); the `workflow_node_executions` row IS. Decoupling the
two is the v5 / I2 simplification: no shared transaction needed,
no new RPC needed for the v4 / C3 fix to work.

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
     stops old active timers (`stopped_at=now()`); inserts fresh
     ones with `due_at` computed by TS plan-build (passed in
     `p_patches.sla.timers[]`) per v5 / C2; no outbox event needed
     for the fresh-insert case (the `recompute_pending` flag is
     scoped to existing-timer pause/resume only).
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
6. **Stop existing timers + start fresh ones (v5 / C2 — schema-
   compliant).** Atomic INSIDE this RPC:
   - `UPDATE sla_timers SET stopped_at = now(), stopped_reason =
     'sla_changed' WHERE entity matches AND stopped_at IS NULL AND
     completed_at IS NULL`. (`stopped_at`, not `completed_at` —
     mirrors the existing reclassify_ticket pattern at
     `supabase/migrations/00044_reclassify_support.sql:115-125`.)
   - UPDATE entity row clearing SLA-derived columns.
   - *(if new policy)* the caller's TS plan-build phase has already
     computed the new `due_at` (per `sla.service.ts:73 startTimers`
     pattern: now() + policy minutes via business calendar). The RPC
     receives `p_payload.timers` as an array of `{ timer_type,
     target_minutes, due_at, business_hours_calendar_id }` rows and
     `INSERT INTO sla_timers (..., due_at)` with `due_at` filled,
     `recompute_pending=false`, `paused=false` and
     `ON CONFLICT DO NOTHING` against the migration 00335 partial
     unique index. **Initial `due_at` is NEVER null — the schema's
     `NOT NULL` constraint is honored.**
7. INSERT ticket_activities (`sla_changed`).
8. UPDATE command_operations.

**Why no outbox event for fresh timers.** v4 said "emit
`sla.timer_recompute_required` after the INSERT and let the worker
fill in due_at." That was incompatible with the schema's `NOT NULL`
on `due_at` (see v5 / C2). v5 inverts: TS computes due_at, RPC
inserts with the value, no follow-up outbox event needed for the
common case. The `recompute_pending` flag remains for the
**existing-timer pause/resume** scenario below — where the row
already has a `due_at` and we need to recompute it without a
window of false breach.

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

**Compensation:** if the worker permanently fails to recompute a
paused-then-resumed timer, the row stays `recompute_pending=true`
and the alert pipeline (existing deadletter) surfaces it. The
entity row's due-dates continue to display the old `due_at`
(stale, not null) until the worker recovers. Readers skip the row
via the `recompute_pending = false` filter so the false-breach
hazard is avoided.

**Scope of `recompute_pending` (v5 / C2 clarification).** The
flag exists for the **existing-timer** pause/resume case where
`due_at` is stale and being recomputed without write window. It
is NEVER set on a fresh INSERT — fresh inserts always have
`due_at` filled by TS plan-build (see SlaTimerHandler in §3.9.3).
The schema's `due_at NOT NULL` is honored at all times.

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
8. *(if approved AND fully resolved)* run post-grant automation
   atomically (v4 / I3 — no inline SLA insert; everything is an
   outbox event for handler-contract uniformity):
   - SELECT request_types config.
   - *(if has SLA)* emit `sla.timer_recompute_required` outbox event
     in the same tx (carries tenant_id, ticket_id, sla_policy_id).
     Handler `SlaTimerHandler` (§3.9.3) computes `due_at` in TS
     (mirrors `sla.service.ts:73 startTimers`), INSERTs `sla_timers`
     with `due_at` filled and `recompute_pending=false`, and updates
     ticket due-dates. **Replaces the v3 inline INSERT.** Reasoning:
     same handler pattern as §3.10 reclassify and §3.11 create — one
     SLA emit primitive, one handler. Schema-compliant per v5 / C2.
   - Routing evaluation: this is non-trivial. **Defer routing to
     post-commit outbox event** `routing.evaluation_required` so the
     RPC itself stays small. The outbox handler
     (`RoutingEvaluationHandler`, §3.9.3) runs the resolver in TS and
     either calls `set_entity_assignment` RPC or emits a
     `routing_failed` breadcrumb activity.
   - **Workflow start (v3 / C2 fix; v4 / C2 idempotency primitive).**
     If the request_type config has a `workflow_definition_id` AND
     no active workflow instance exists yet for this ticket,
     atomically emit `workflow.start_required` outbox event in the
     same tx. The outbox handler (`WorkflowStartHandler`, §3.9.3)
     starts the workflow instance via the existing
     `workflowService.startInstance(...)` TS path. This closes the
     v2 gap where v2's RPC covered SLA + routing but dropped
     workflow start; today `runPostCreateAutomation`
     (`ticket.service.ts:716`) calls `startInstance` at line 865,
     and v2 silently lost that branch when migrating to the RPC.

     **Idempotency primitive (v4 / C2).** `workflow_instances` does
     NOT have `UNIQUE (tenant_id, ticket_id)` today — only the
     non-unique `idx_wi_ticket` (`supabase/migrations/00009_workflows.sql:47`).
     `WorkflowEngineService.startForTicket` blindly inserts at line
     172 (`apps/api/src/modules/workflow/workflow-engine.service.ts:172`).
     v4 adds a partial unique index via migration 00333 on
     `workflow_instances (tenant_id, ticket_id)` WHERE
     `status IN ('active', 'waiting')` — i.e. at most one
     non-terminal workflow per ticket. The handler does
     `INSERT ... ON CONFLICT DO NOTHING`; on conflict it loads the
     existing row and returns `{ kind: 'already_started',
     instance_id: <existing> }`. `startForTicket` is updated in the
     same change to surface conflict cleanly rather than throwing.
     Replays after engine restart are safe.
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

**Endpoints in scope (v2 mandate, v4 amends):**
- `PATCH /tickets/:id` (calls §3.0 with entity_kind='case').
- `PATCH /work-orders/:id` (calls §3.0 with entity_kind='work_order').
- `POST /tickets` (calls §3.11 `create_ticket_with_automation`).
- `POST /portal/tickets` (calls §3.11 via `PortalSubmitService.submit`,
  v4 / I2; route corrected v5 / I3).
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

**Affected hooks (v4 / I1 — all citations verified):**

| File:line | Hook | Endpoint | Status |
|---|---|---|---|
| `apps/web/src/api/tickets/mutations.ts:59` | `useUpdateTicket` | `PATCH /tickets/:id` | needs Pattern A retrofit |
| `apps/web/src/api/tickets/mutations.ts:248` | `useUpdateWorkOrder` | `PATCH /work-orders/:id` | needs Pattern A retrofit |
| `apps/web/src/hooks/use-work-orders.ts:73` | `useDispatchWorkOrder` | `POST /tickets/:id/dispatch` | needs Pattern A retrofit |
| `apps/web/src/api/tickets/mutations.ts:104` | `useReassignTicket` | `POST /tickets/:id/reassign` | needs Pattern A retrofit |
| `apps/web/src/api/tickets/mutations.ts:316` | `useReassignWorkOrder` | `POST /work-orders/:id/reassign` | needs Pattern A retrofit |
| `apps/web/src/hooks/use-reclassify.ts:121` | `useReclassifyTicket` | `POST /tickets/:id/reclassify` | needs Pattern A retrofit |
| `apps/web/src/api/approvals/index.ts:57` | `useRespondApproval` | `POST /approvals/:id/respond` | **already threads `requestId`** (line 64); guard can attach immediately |
| (new: portal submit) | `apps/web/src/pages/portal/submit-request.tsx:230` POST callsite | `POST /portal/tickets` | needs Pattern A retrofit (v4 / I2; route corrected v5 / I3) |

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
trigger event; the outbox handler clears it to `'idle'` on success
OR on a valid `unassigned` outcome (v5 / I4 — unassigned is a
terminal valid result per `docs/assignments-routing-fulfillment.md:149`,
not a failure), or sets `'failed'` with a reason in
`routing_failure_reason` only for genuine errors (resolver throws,
FK validation rejects, downstream RPC errors). The desk UI reads
`routing_status` and shows a small "Routing..." chip when
`'pending'`; "Unassigned" pill is driven separately by the
absence of `assigned_team_id`/`user_id`/`vendor_id`.

**Sync-routing implementation.** In TS, before calling the create
or dispatch RPC, run `RoutingService.evaluate(...)` (read-only)
and pass the resolver result + trace into the RPC's payload as
`routing_decision` (resolved target) + `routing_trace` (jsonb).
The RPC stores the trace in `routing_decisions` atomically with the
INSERT. Same pattern v1 already proposed for §3.4 dispatch — v2
affirms it for the create path and v4 makes it the single contract
for create (no async fallback in the create path).

**Caller-provided assignee wins (v4 / C1 reconciliation).** If
the create or dispatch payload already carries
`assigned_team_id`/`assigned_user_id`/`assigned_vendor_id`, the RPC
**skips** the routing branch entirely (no `routing_decisions` row,
no resolver trace) and writes the caller's assignment as-is. This
matches existing TS code in `TicketService.create` /
`runPostCreateAutomation` which only routes when no assignee is
present. Without this gate, every API call that supplies an
assignee would also generate a misleading "routing decided" trace.

**Async-routing implementation.** The triggering RPC emits an
outbox event `routing.evaluation_required` (carries entity_id,
trigger_reason, payload context). The handler runs the resolver in
TS, calls `set_entity_assignment` RPC if the result differs,
clears `routing_status`. **Used only by §3.5 (post-grant) and
§3.10 (reclassify).** NOT used by §3.11 create path — see C1
reconciliation in v4 revision history.

#### 3.9.3 Handler contract (v4 / I3)

v3 had three different SLA-side behaviors across §3.5 / §3.10 / §3.11
(inline insert vs. `SlaTimerHandler` vs. `SlaTimerRepointHandler`).
v4 consolidates the canonical handler set; every B.2 outbox event
maps to exactly one handler with one well-defined idempotency
contract. All handlers are siblings of `SetupWorkOrderHandler` from
B.0.E and registered in the same `OutboxModule`.

| Event type | Handler | Emitting RPCs | Idempotency primitive |
|---|---|---|---|
| `sla.timer_recompute_required` | `SlaTimerHandler` | §3.5 grant_ticket_approval (post-grant), §3.11 create_ticket_with_automation (post-create no-approval) | **TS handler computes `due_at` then calls `start_sla_timers` RPC (v6 / C2 — single atomic write).** Steps: (a) SELECT the SLA policy + business hours calendar; (b) compute `due_at` for each `timer_type` (`response`, `resolution`) using `BusinessHoursService.addBusinessMinutes(calendar, ticket.created_at, policy.<minutes>)` — `started_at = ticket.created_at` per v6 nit, NOT `now()`, so the SLA clock matches when the customer asked; (c) call migration 00336's `start_sla_timers(p_tenant_id, p_ticket_id, p_sla_policy_id, p_timers)` RPC which does **INSERT timer rows + UPDATE `tickets.sla_response_due_at` / `sla_resolution_due_at` in one PG transaction**. The RPC uses `ON CONFLICT DO NOTHING` against migration 00335's partial unique index for replay safety. **No TS-side multi-write** — that was the v5 split-write that codex C2 flagged. |
| `sla.timer_repointed_required` | `SlaTimerRepointHandler` | §3.10 reclassify_ticket | TS handler computes new `due_at` (same path as above) then calls migration 00337's `repoint_sla_timer(p_tenant_id, p_ticket_id, p_sla_policy_id, p_timers, p_reason)` RPC. **Idempotency short-circuit (v7 / I3):** RPC opens with `if exists (select 1 from sla_timers where tenant_id=$, ticket_id=$, sla_policy_id=p_sla_policy_id and stopped_at is null and completed_at is null) then return jsonb_build_object('kind','already_repointed'); end if;` so a replay returns no-op without touching state. Else proceeds atomically: (1) UPDATEs existing active timers `SET stopped_at=now(), stopped_reason=$reason` WHERE `sla_policy_id IS DISTINCT FROM p_sla_policy_id AND stopped_at IS NULL AND completed_at IS NULL` — **scoped to the OLD policy** so a re-execution wouldn't stop the new policy's timers; (2) INSERTs fresh active timers with `due_at` filled and `recompute_pending=false`, with `ON CONFLICT DO NOTHING` against the 00335 partial unique index; (3) UPDATEs ticket SLA due-date columns to the new values. All in one PG tx. |
| `routing.evaluation_required` | `RoutingEvaluationHandler` | §3.5 grant_ticket_approval, §3.10 reclassify_ticket. **Not** §3.11 create (sync-routing per §3.9.2). | Reads `tickets.routing_status`; if `'idle'` already, returns no-op. Else runs `RoutingService.evaluate(...)`. **Unassigned outcome (v5 / I4):** if resolver returns `chosen_by='unassigned'` (no rule matched, valid per `docs/assignments-routing-fulfillment.md:149`), INSERT a `routing_decisions` row with `target=null`, `chosen_by='unassigned'` and set `routing_status='idle'`. **Failure outcome:** if the resolver throws, FK validation fails, or `set_entity_assignment` RPC errors, set `routing_status='failed'` and write `routing_failure_reason`. Successful resolve calls `set_entity_assignment` RPC (idempotent via `command_operations` keyed on `${event_id}:routing`) and sets `routing_status='idle'`. |
| `workflow.start_required` | `WorkflowStartHandler` | §3.5 grant_ticket_approval, §3.10 reclassify_ticket, §3.11 create_ticket_with_automation | `WorkflowEngineService.startForTicket` updated to do `INSERT INTO workflow_instances ... ON CONFLICT (tenant_id, ticket_id) WHERE status IN ('active', 'waiting') DO NOTHING` per the migration 00333 partial unique index (C2 fix). On conflict the handler returns `{ kind: 'already_started' }` referencing the existing instance. |

**Why no inline branches.** The historical pattern of "RPC writes
SLA inline, RPC writes routing inline, RPC starts workflow inline"
is what produced the v3 contradictions. v4's rule: a B.2 RPC may
**only** write the entity row + activity + domain_event + routing
trace (when sync). Anything else is an outbox event, picked up by
exactly one of the four handlers above. The handlers all carry
their own idempotency primitive so replay is safe end-to-end.

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
8. **Cancel pre-existing active workflow_instances if the
   workflow definition is changing (v7 / C2 fix).** The
   `WorkflowStartHandler` does `INSERT ... ON CONFLICT DO NOTHING`
   keyed on the migration 00333 partial unique index, so a still-
   active row would silently no-op the new workflow start. The
   RPC must cancel the old row in the same tx, mirroring the
   existing pattern at `supabase/migrations/00046_reclassify_preserve_parent_status.sql:65-77`:
   ```sql
   if old.workflow_definition_id is distinct from new.workflow_definition_id then
     update public.workflow_instances
        set status = 'cancelled',
            cancelled_at = now(),
            cancelled_reason = p_reason,
            cancelled_by = p_actor_user_id
      where ticket_id = p_ticket_id
        and tenant_id = p_tenant_id
        and status in ('active', 'waiting');
   end if;
   ```
   With the active rows now `cancelled`, the partial unique index
   no longer matches and the handler's INSERT can succeed.

9. **Emit outbox events atomically (in the same tx):**
   - `sla.timer_repointed_required` if old.sla_policy_id !=
     new.sla_policy_id.
   - `workflow.start_required` if old.workflow_definition_id !=
     new.workflow_definition_id (cancellation done in step 8).
   - `routing.evaluation_required` (always — even if the new type
     might resolve to the same target, the resolver should re-run
     to record the breadcrumb).
10. Set `tickets.routing_status='pending'` (per §3.9.2) so the UI
    shows the routing-in-flight chip.
11. UPDATE command_operations.

**TS handlers** (sibling to existing `SetupWorkOrderHandler` from
B.0.E; full contract in §3.9.3):
- `SlaTimerRepointHandler` — calls `repoint_sla_timer` RPC which
  stops old active timers (`stopped_at=now()`) and inserts fresh
  ones with `due_at` computed in TS from the new policy
  (mirrors `sla.service.ts:73 startTimers`). `recompute_pending`
  stays `false` — fresh inserts always carry a real `due_at`
  (v5 / C2). v7 / I3: handler short-circuits on replay if the
  new policy already has active timers.
- `WorkflowStartHandler` — same handler as the create + grant
  paths (no separate `WorkflowRestartHandler`). The RPC's step 8
  cancels the old workflow_instances row in the same tx, so by
  the time the handler runs, INSERT succeeds against the partial
  unique index (v7 / C2 fold-in).
- `RoutingEvaluationHandler` — runs `RoutingService.evaluate(...)`,
  calls `set_entity_assignment` RPC if the target differs, sets
  `routing_status='idle'` on success OR on a valid `unassigned`
  outcome (v5 / I4); `'failed'` only for genuine errors.

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

**Two parameters: `p_input` (raw user payload) + `p_automation_plan`
(TS-resolved effective config — v5 / C1).** The split makes the
RPC's contract explicit: the user-facing fields drive validation +
column writes; the automation plan drives the cascading side-
effects. TS owns the resolution work (which is HTTP/index-heavy
and benefits from caching); PG owns the atomic commit.

`p_input` carries the create payload: `request_type_id, requester_person_id,
title, description, priority?, location_id?, asset_id?, assigned_team_id?,
assigned_user_id?, assigned_vendor_id?, watchers?, parent_ticket_id?,
booking_id?, source, metadata?`. TS pre-mints `ticket_id`
deterministically from the idempotency key. `watchers` is `string[]`
to match `tickets.watchers` (`ticket.service.ts:76`).

`p_automation_plan` carries the TS-resolved effective config (v5 /
C1):
```
{
  effective_location_id: uuid | null,         -- ScopeOverrideResolverService.deriveEffectiveLocation
  scope_override_id:    uuid | null,          -- ScopeOverrideResolverService.resolveForLocation (audit breadcrumb)
  effective_workflow_definition_id: uuid | null,  -- override wins, else request_types.workflow_definition_id
  effective_sla_policy_id:          uuid | null,  -- override wins, else request_types.sla_policy_id
  routing_decision: { team_id?: uuid, user_id?: uuid, vendor_id?: uuid, chosen_by: text } | null,
  routing_trace:    jsonb | null,             -- present iff routing_decision is non-null
}
```

The TS plan-build phase mirrors the existing
`runPostCreateAutomation` order at `apps/api/src/modules/ticket/ticket.service.ts:743`:
1. `ScopeOverrideResolverService.deriveEffectiveLocation(tenant, intake)`
   → `effective_location_id`.
2. `ScopeOverrideResolverService.resolveForLocation(tenant, request_type_id, effective_location_id)`
   → `scopeOverride` row.
3. `effective_workflow_definition_id = scopeOverride?.workflow_definition_id ?? requestTypeCfg?.workflow_definition_id ?? null`.
4. `effective_sla_policy_id = scopeOverride?.case_sla_policy_id ?? requestTypeCfg?.sla_policy_id ?? null`.
5. *(if no caller assignee)* `RoutingService.evaluate(...)` →
   `routing_decision` + `routing_trace`. Per §3.9.2 v4 sync contract.
6. Build `p_automation_plan` and call the RPC.

**Body sketch:**
1. Advisory lock + `command_operations` gate (same pattern as §3.0).
2. Validate every FK ref in `p_input` AND `p_automation_plan` is
   tenant-owned via the dedicated helpers from migration 00318
   (v6 / I1 — one validator per table-family):
   - `p_input.requester_person_id` →
     `validate_assignees_in_tenant` (existing).
   - `p_input.parent_ticket_id` →
     `validate_entity_in_tenant(...,'ticket')` (existing).
   - `p_input.asset_id` → `validate_entity_in_tenant(...,'asset')`
     (or dedicated helper if asset isn't in the existing
     enum).
   - `p_input.assigned_team_id`/`assigned_user_id`/`assigned_vendor_id`
     → `validate_assignees_in_tenant`.
   - `p_input.location_id` AND
     `p_automation_plan.effective_location_id` →
     `validate_space_in_tenant` (new in 00318 per v6 / I1).
   - `p_automation_plan.scope_override_id` →
     `validate_scope_override_in_tenant` (new).
   - `p_automation_plan.effective_workflow_definition_id` →
     `validate_workflow_definition_in_tenant` (new).
   - `p_automation_plan.effective_sla_policy_id` →
     `validate_sla_policy_in_tenant` (new).
   - `p_input.request_type_id` →
     `validate_entity_in_tenant(...,'request_type')` or
     dedicated helper.
   **No automation-plan field is trusted blindly; tenant
   ownership is verified for every FK.**

2a. **Semantic re-derivation (v6 / I2; v7 / I1+C1 fixes).**
    Tenant validation proves "the row belongs to this tenant"
    but does not prove "the row is the correct one for this
    request." A buggy or stale TS plan-build could pass tenant
    validation but still select the wrong workflow/SLA/location.
    PG independently re-derives:

    1. **Effective location (v7 / I1).** Mirror the TS chain at
       `apps/api/src/modules/routing/scope-override-resolver.service.ts:111`
       — `coalesce(p_input.location_id, (select assigned_space_id
       from public.assets where id = p_input.asset_id and tenant_id
       = p_tenant_id))`. Assert this equals
       `p_automation_plan.effective_location_id`; mismatch →
       reject `automation_plan.effective_location_mismatch`.
       Trusting TS-supplied location is unsafe; this catches
       stale-plan bugs at the gate.

    2. **Effective workflow + SLA (v6 / I2; v7 / C1 signature).**
       Use the existing PG function. Per
       `supabase/migrations/00096_effective_scope_override.sql:10`:
       ```sql
       v_override jsonb := public.request_type_effective_scope_override(
         p_tenant_id,            -- (NOT p_input.request_type_id first)
         p_input.request_type_id,
         v_derived_location_id   -- the value verified in step 1
       );
       v_request_type record :=  -- already SELECTed in step 3 below
       v_derived_workflow_definition_id uuid := coalesce(
         (v_override->>'workflow_definition_id')::uuid,
         v_request_type.workflow_definition_id
       );
       v_derived_sla_policy_id uuid := coalesce(
         (v_override->>'case_sla_policy_id')::uuid,
         v_request_type.sla_policy_id
       );
       ```
       Assert `v_derived_workflow_definition_id IS NOT DISTINCT
       FROM p_automation_plan.effective_workflow_definition_id`
       AND `v_derived_sla_policy_id IS NOT DISTINCT FROM
       p_automation_plan.effective_sla_policy_id`. Mismatch →
       reject `automation_plan.semantic_mismatch` AppError with
       both values in the payload.

    3. **Override id (v7).** If `p_automation_plan.scope_override_id`
       is non-null, assert it equals `(v_override->>'id')::uuid`.
       Else assert `v_override IS NULL` (no override resolved on
       either side). Mismatch →
       `automation_plan.scope_override_mismatch`.

    4. **Routing trace input (v6 / I2).** *(if
       `p_automation_plan.routing_decision` is non-null)* assert
       `routing_trace.input` matches `(p_input.request_type_id,
       v_derived_location_id, p_input.asset_id)` — proves the
       resolver ran on the correct tuple even though we don't
       re-run the resolver itself in PG. Mismatch →
       `automation_plan.routing_input_mismatch`.
3. SELECT `request_types(id, tenant_id) FOR SHARE` purely to read
   `requires_approval`. Workflow/SLA/location IDs come from
   `p_automation_plan`, not from this row — TS already resolved
   them.
4. INSERT into `tickets` with the pre-minted id. Columns:
   - `location_id = p_automation_plan.effective_location_id` (TS
     already resolved through scope-override chain).
   - `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id`
     from `p_input` if caller provided, else from
     `p_automation_plan.routing_decision`, else null.
   - **`sla_id = p_automation_plan.effective_sla_policy_id`**
     (note: the **column on `tickets` is `sla_id`** per
     `supabase/migrations/00011_tickets.sql:23`, not
     `sla_policy_id`. Same name asymmetry as `workflow_id` —
     v7 / I2.)
   - **`workflow_id = p_automation_plan.effective_workflow_definition_id`**
     (note: the **column on `tickets` is `workflow_id`** per
     `supabase/migrations/00011_tickets.sql:22`, even though the
     config tables use `workflow_definition_id`. v6 / C1.)
   - Status:
     - if `requires_approval` → `'pending_approval'`
     - else → `'new'`
   - `routing_status` stays `'idle'` (sync routing path; no async chip).
5. **Routing record (sync, v4 / C1; v5 / I4 unassigned).** If
   `p_input.assigned_team_id`/`assigned_user_id`/`assigned_vendor_id`
   is non-null, **skip** routing entirely (no `routing_decisions`
   row). Else, if `p_automation_plan.routing_decision` is non-null,
   INSERT a `routing_decisions` row with the plan's `routing_trace`
   payload. **`chosen_by='unassigned'` is a valid terminal outcome**
   per `docs/assignments-routing-fulfillment.md:149`; the row still
   gets written (with `target=null`, `chosen_by='unassigned'`) so
   the audit trail is complete. `routing_status` stays `'idle'`
   for unassigned (it is NOT a failure — see §3.9.2 v5 / I4).
6. INSERT `ticket_activities (ticket_id, event='ticket_created', ...)`.
7. INSERT `domain_events (event_type='ticket_created', ...)`.
8. Branch on `requires_approval`:
   - **YES** → call `approvalService.createSingleStep` equivalent inline
     as a private helper:
     - INSERT `approvals (target_entity_type='ticket', target_entity_id=ticket_id, status='pending', ...)`.
     - INSERT `domain_events (event_type='approval_requested', ...)`.
     - INSERT `ticket_activities (event='approval_requested', ...)`.
     - **No** SLA timers, **no** workflow start yet. Those land when
       the approval is granted (via §3.5). Routing is already recorded
       in step 5 (sync) or absent.
   - **NO** (no approval gate) → emit post-create automation outbox
     events atomically in the same tx:
     - *(if `p_automation_plan.effective_sla_policy_id` is non-null)*
       `sla.timer_recompute_required` carrying tenant_id, ticket_id,
       sla_policy_id. Handler is the `SlaTimerHandler` (§3.9.3) —
       computes `due_at` in TS (mirrors `sla.service.ts:73 startTimers`),
       INSERTs `sla_timers` with `due_at` filled, `recompute_pending=false`,
       and UPDATEs ticket due-dates. Schema-compliant per v5 / C2.
     - *(if `p_automation_plan.effective_workflow_definition_id`
       is non-null)* `workflow.start_required` carrying tenant_id,
       ticket_id, workflow_definition_id. Handler
       (`WorkflowStartHandler`, §3.9.3) starts the workflow instance
       via the existing `workflowService.startInstance` TS path with
       `INSERT ... ON CONFLICT DO NOTHING` semantics keyed on the
       partial unique index added in migration 00333 (C2 fix).
9. UPDATE `command_operations` to outcome='success'.
10. Return `{ ticket: row, follow_ups: [...event types emitted] }`.

**Why this is one RPC, not three.** The decisive question: can the
ticket exist without ANY of the post-create side-effects firing? On
the no-approval branch, today's code creates the ticket then calls
`runPostCreateAutomation` which fans into routing + SLA + workflow
in TS. If the ticket commits but routing/SLA/workflow fails, the
ticket is in a partial-onboarding state — assignee stale, SLA
queue blind, workflow never started. The RPC closes that gap by
writing routing inline (sync, step 5) and emitting SLA + workflow
outbox events atomically with the ticket INSERT. Either
all-fire-or-none-fire. Same architectural rule the other B.2 RPCs
apply.

**TS plan-build phase:**
- Mint `ticket_id` deterministically: `uuidv5(idempotency_key, ns)`.
- Authorization (callerCanCreate per request_type permissions) —
  TS-side, before the RPC.
- **Routing resolver runs sync (v4 / C1).** Per §3.9.2, the create
  path is sync-routing. If no caller-provided assignee is present in
  the dto, TS calls `RoutingService.evaluate(...)` and adds the
  result to `p_input` as `routing_decision` + `routing_trace`. The
  RPC writes the `routing_decisions` row atomically. Caller-provided
  assignee bypasses routing entirely (see step 5). No `routing.
  evaluation_required` outbox event from this path.

**Cutover scope (v4 / I2; v5 / I3 route correction).** Both call
sites of `TicketService.create` must move to
`create_ticket_with_automation`:
1. `TicketController` (`POST /tickets`).
2. `PortalSubmitService.submit` (`apps/api/src/modules/portal/portal-
   submit.service.ts:35`) — invoked by `POST /portal/tickets`
   per `apps/api/src/modules/portal/portal.controller.ts:111`. The
   portal flow currently builds an `intake` + `portal_trace` payload
   and then calls `TicketService.create`; v5 routes that call through
   the new RPC with the resolver + automation-plan preflight identical
   to the controller path. Frontend cooperation: `apps/web/src/pages/portal/submit-
   request.tsx:230` (POSTs to `/portal/tickets`) adds the
   `X-Client-Request-Id` header (Pattern A).
   `RequireClientRequestIdGuard` is attached to `POST /portal/tickets`
   in §3.9.1's endpoint list.

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
| 00318 | `validate_entity_in_tenant_helper.sql` | Tenant-validate (case\|wo).id. **v6 / I1 — also adds four dedicated validators** for the automation-plan FKs: `validate_space_in_tenant(p_tenant_id, p_id)`, `validate_scope_override_in_tenant(p_tenant_id, p_id)`, `validate_workflow_definition_in_tenant(p_tenant_id, p_id)`, `validate_sla_policy_in_tenant(p_tenant_id, p_id)`. Each is a SECURITY DEFINER function that raises if the row isn't found in the named table for the given tenant. Pattern matches `validate_assignees_in_tenant`. |
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
| 00333 | `workflow_instances_active_unique_index.sql` | v4 / C2 — partial unique index on `workflow_instances (tenant_id, ticket_id)` WHERE `status IN ('active', 'waiting')`. **REQUIRES PREFLIGHT + CLEANUP RUNBOOK** (v5 / I1; v6 / I3 column correction). See "Migration 00333 runbook" below — the migration aborts if duplicates exist; operator runs the documented cleanup (keying on `started_at`, the actual column per `00009_workflows.sql:38` — NOT `created_at`), then re-runs. Required before §3.5 / §3.10 / §3.11 ship workflow-start outbox emits. |
| 00334 | `workflow_node_executions_table.sql` | v4 / C3 — durable per-node-fire record carrying the `execution_token`. UNIQUE on `(workflow_instance_id, node_id, attempt)`. v5 / I2 — table holds only the token (no `status` column; workflow engine uses Supabase HTTP, no shared tx for outcome tracking). Required before §1.21 cutover. |
| 00335 | `sla_timers_active_unique_index.sql` | v5 / C2 — partial unique index on `sla_timers (tenant_id, ticket_id, sla_policy_id, timer_type)` WHERE `stopped_at IS NULL AND completed_at IS NULL`. Enforces "one active timer per (ticket, policy, timer_type)" so handler `INSERT ... ON CONFLICT DO NOTHING` works. Existing schema columns (`stopped_at`, `completed_at` from migrations 00011/00044) are reused; no schema change to `sla_timers`. **REQUIRES PREFLIGHT + CLEANUP RUNBOOK** (v6 / I4). See "Migration 00335 runbook" below. Required before SlaTimerHandler ships in §3.5 / §3.11. |
| 00336 | `start_sla_timers_rpc.sql` | v6 / C2 — `start_sla_timers(p_tenant_id, p_ticket_id, p_sla_policy_id, p_timers jsonb)`: INSERT timer rows + UPDATE `tickets.sla_response_due_at` / `sla_resolution_due_at` in one tx. Used by `SlaTimerHandler` for the post-create + post-grant flows. |
| 00337 | `repoint_sla_timer_rpc.sql` | v6 / C2 — `repoint_sla_timer(p_tenant_id, p_ticket_id, p_sla_policy_id, p_timers, p_reason text)`: STOP old active timers + INSERT new + UPDATE ticket due-dates atomically. Used by `SlaTimerRepointHandler` for the reclassify flow. |

22 migrations. Up from v5's 20 — adds 00336 + 00337 (atomic SLA
timer RPCs, v6 / C2). `routing_failure_reason` remains folded
into 00320 (no extra migration).

#### Migration 00333 runbook (v6 / I3)

The migration body opens with a preflight that aborts if any
tenant has duplicate active workflow instances per ticket:

```sql
do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes from (
    select tenant_id, ticket_id
    from public.workflow_instances
    where status in ('active', 'waiting')
    group by 1, 2 having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'workflow_instances duplicate detection: % (tenant_id, ticket_id) groups have multiple active rows. Run the cleanup runbook before re-running this migration.',
      v_dupes;
  end if;
end $$;
```

If the migration aborts, the operator works through the audit
+ decision + cleanup steps below. **The cleanup is fully
operator-driven (v7 / I5) — there is no automated heuristic.**
v6 said "keep most-recent `started_at`," but that's unsafe:
older instances may hold real progress / context (decision
history, parallel-branch state, in-flight commands). The
operator reviews each duplicate group and picks the canonical
row by hand using the audit output:

```sql
-- 1. Audit. For every duplicate group, list every row's
-- identifying state. Save this output and review row-by-row
-- before running cleanup.
select wi.id, wi.tenant_id, wi.ticket_id, wi.status,
       wi.started_at, wi.completed_at, wi.cancelled_at,
       wi.workflow_definition_id, wi.workflow_version,
       wi.current_node_id, wi.context
from public.workflow_instances wi
join (
  select tenant_id, ticket_id
  from public.workflow_instances
  where status in ('active', 'waiting')
  group by 1, 2 having count(*) > 1
) dupes
  on wi.tenant_id = dupes.tenant_id
 and wi.ticket_id = dupes.ticket_id
where wi.status in ('active', 'waiting')
order by wi.tenant_id, wi.ticket_id, wi.started_at;
```

Decision criteria (operator applies per group):
- Prefer the row whose `current_node_id` shows the most
  meaningful progress (not the trigger node).
- If multiple are mid-flight, prefer the one whose `context`
  jsonb has the most accumulated state.
- `started_at` recency is a weak tie-breaker, never a
  primary criterion.

```sql
-- 2. Cancel the non-canonical rows. Replace the IN-list with
-- the row IDs the operator decided to retire. Use the
-- established cancellation metadata (v7 / I5) — same shape as
-- migration 00046:65-71's existing reclassify cancellation.
update public.workflow_instances
set status = 'cancelled',
    cancelled_at = now(),
    cancelled_reason = 'deduplicated_pre_index',
    cancelled_by = '<operator-user-id>'::uuid
where id in (
  -- Row IDs from step 1 audit that the operator chose to retire.
  '<id-1>'::uuid, '<id-2>'::uuid, /* ... */
);

-- 3. Re-run migration 00333.
```

Cleanup is operator-driven, not embedded in the migration —
silently cancelling someone's real active workflow is not
recoverable. The audit output from step 1 must be retained
for post-cutover analysis.

#### Migration 00335 runbook (v6 / I4)

Same preflight pattern. Detection query:

```sql
do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes from (
    select tenant_id, ticket_id, sla_policy_id, timer_type
    from public.sla_timers
    where stopped_at is null and completed_at is null
    group by 1, 2, 3, 4 having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'sla_timers duplicate detection: % (tenant_id, ticket_id, sla_policy_id, timer_type) groups have multiple active rows. Run the cleanup runbook before re-running this migration.',
      v_dupes;
  end if;
end $$;
```

If aborted, the operator works through audit + decision +
cleanup. **Operator-driven (v7 / I4) — no automated heuristic.**
v6 used `min(id)` as canonical, but UUIDv4 IDs have no temporal
meaning. The operator picks per group based on breach state,
due_at, started_at, and the ticket's current SLA due-date
columns:

```sql
-- 1. Full audit per duplicate group. Also pull the ticket's
-- sla_response_due_at / sla_resolution_due_at so the operator
-- can see which timer's due_at the ticket is actually
-- displaying. Save this output.
select t.id, t.tenant_id, t.ticket_id, t.sla_policy_id,
       t.timer_type, t.started_at, t.due_at,
       t.breached, t.breached_at,
       t.paused, t.paused_at, t.total_paused_minutes,
       tk.sla_response_due_at as ticket_response_due_at,
       tk.sla_resolution_due_at as ticket_resolution_due_at
from public.sla_timers t
join public.tickets tk on tk.id = t.ticket_id
join (
  select tenant_id, ticket_id, sla_policy_id, timer_type
  from public.sla_timers
  where stopped_at is null and completed_at is null
  group by 1, 2, 3, 4 having count(*) > 1
) dupes
  on  t.tenant_id     = dupes.tenant_id
 and  t.ticket_id     = dupes.ticket_id
 and  t.sla_policy_id = dupes.sla_policy_id
 and  t.timer_type    = dupes.timer_type
where t.stopped_at is null
  and t.completed_at is null
order by t.tenant_id, t.ticket_id, t.timer_type, t.started_at;
```

Decision criteria (operator applies per group):
- If exactly one row's `due_at` matches the ticket's SLA
  due-date column → **that row is canonical** (the UI was
  showing it; preserve continuity).
- Else prefer the row that has been monitored longest
  (oldest `started_at`).
- If a row is `breached=true` and the others aren't, prefer
  the breached row (preserve breach history).
- Total-paused-minutes ties go to the row that's been
  paused most (more "real" history).

```sql
-- 2. STOP non-canonical duplicates. Replace the IN-list with
-- the row IDs the operator picked to retire. STOP preserves
-- audit + breach history (we do not delete).
update public.sla_timers
set stopped_at = now(),
    stopped_reason = 'deduplicated_pre_index'
where id in (
  -- Row IDs from step 1 audit that the operator chose to retire.
  '<id-1>'::uuid, '<id-2>'::uuid, /* ... */
);

-- 3. Re-run migration 00335.
```

Note: the canonical row keeps its existing `due_at` and breach
state. Operators should not see UI behavior change after dedup
because the kept row is the one whose `due_at` the ticket
already displays.

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
    entity_status` (waiting-state pause/resume),
    `create_ticket_with_automation` (sync routing + caller-assignee
    bypass + post-create SLA outbox emit; 4-5 probes covering the
    branch matrix in §3.11), and `workflow_node_executions`
    idempotency (fire same node twice → reused token → command
    RPC returns cached result).
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
   `workflow:${instance_id}:${node_id}:${execution_token}` where
   `execution_token` is read from the `workflow_node_executions`
   row (migration 00334, v4 / C3). Engine MUST write that row
   before invoking the node body; cutover is gated on migration
   00334 + the engine update.
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
