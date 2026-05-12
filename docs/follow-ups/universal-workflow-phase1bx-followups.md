# Universal Workflow — Phase 1.B.x follow-ups

Phase 1.B (commit `d73d31fc`, 2026-05-12) shipped the engine
polymorphization at the **emit-site** layer plus the cancellation cascade
+ spawn-link safety check. It deliberately stopped short of full
polymorphization at the **dispatch** layer; this doc tracks that
deferral.

## Phase 1.C — SHIPPED (2026-05-12)

The Tier 1 cron backstop (`WorkflowWaitSweeperCron`) is shipped:

- `apps/api/src/modules/workflow/workflow-wait-sweeper.cron.ts` — every
  30s sweep of `workflow_instance_links` with expired `wait_timeout_at`;
  per-row atomic claim with the SAME `wait_timeout_at <= now()` predicate
  in the UPDATE WHERE so a Tier-2 wake or wait-extension between SELECT
  and UPDATE no-ops the claim; emits `link_resolved` with
  `resolution_kind='timeout'` and calls `engine.resume(parent,
  on_timeout_branch)`; unclaims on resume failure.
- `apps/api/src/modules/workflow/workflow-engine.service.ts` —
  `emitForCron()` narrow public alias around the private `emit()` so the
  cron can write to `workflow_instance_events` without unprivating the
  engine's audit-emit surface.
- `apps/api/src/modules/workflow/workflow.module.ts` — registers the
  cron in the providers list. `ScheduleModule.forRoot()` is wired at
  `app.module.ts:60` so no app-module change required.
- Tests at `apps/api/src/modules/workflow/workflow-wait-sweeper.cron.spec.ts`
  cover: zero rows, single claim, multi-row independence, concurrent
  resolution race, wait-extension race, resume failure unclaim, unclaim
  failure continuation, null `on_timeout_branch`, cross-tenant defense,
  batch-size cap, enabled flag, tenant cache.

No new migration needed (Phase 1.C is TS-only — the schema, indexes,
and event_type CHECK constraint were all delivered in Phase 1.A/1.B).

## 1. `executeNode` kind-polymorphization at the dispatch layer

**Status:** deferred. Inline TODOs at:

- `apps/api/src/modules/workflow/workflow-engine.service.ts:959` —
  notification node hardcodes `entityKind: 'case'` and projects via
  `projectLegacyEntityType` to `'ticket'`. The literal works for case-
  kind workflows; booking / work_order workflows that reach this branch
  would mis-emit `related_entity_type='ticket'` against a non-ticket
  entity.
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1149` —
  approval node has the same shape: hardcodes `entityKind: 'case'` and
  projects to `'ticket'` so `ApprovalService.respond` keeps routing to
  the §3.5 `grant_ticket_approval` RPC.

**Why the deferral was intentional:** the dispatch-layer rewrite is
wider than Phase 1.B's scope. The full change shape is:

1. `executeNode(node, instanceId, graph, ticketId, ctx)` becomes
   `executeNode(node, instanceId, graph, entityKind, entityId, ctx)`.
2. Each call site that today passes `ticketId` (workflow controller
   surfaces, `startForTicket`, `resume`, advance/dispatch helpers) gets
   updated to thread the polymorphic kind alongside the id.
3. Per-domain `startForX` methods (`startForCase`, `startForBooking`,
   `startForWorkOrder`) replace the case-only `startForTicket` once they
   exist.
4. Each branch in `executeNode` that today hardcodes `'case'` or
   `ticketId` updates to use the resolved (entityKind, entityId) pair.

That's a multi-file refactor with audit-feed implications (every emit
shape changes shape on booking/work_order workflows). Phase 1.B shipped
the helpers (`projectLegacyEntityType`, `WorkflowEntityKind`, the
polymorphic id-column resolver, the cascade infrastructure) so the
dispatch rewrite has a clean foundation; the rewrite itself is the
Phase 1.B.x slice.

**Pre-conditions before opening 1.B.x:**

- Booking-only and work_order-only workflows have a real consumer (a
  feature actually triggers them). Today only case-kind workflows run
  in production tenants, so the `'case'` hardcode is functionally
  correct — the dispatch rewrite is paying down design debt for a
  future demand, not closing a live bug.
- A `startForX` method exists for at least one non-case kind, so the
  refactor has a concrete second caller (otherwise the polymorphism is
  speculative).

When both pre-conditions hold, the rewrite is mechanical: split
`executeNode`'s case-only references, thread `entityKind` through, and
delete the hardcoded `'case'` literals at :966 and :1156.

## Phase 1.C.x — Tier 1 cron resume-failure retry loop

The wait-sweeper cron (`apps/api/src/modules/workflow/workflow-wait-sweeper.cron.ts`)
has no retry counter for transient resume() failures. If a parent
workflow_instance's resume keeps throwing (e.g. malformed
workflow_definition.graph_definition, missing edge target, supabase
wobble), the sweep loops every 30s indefinitely:

1. Sweep N: SELECT expired link → atomic claim → resume() throws → unclaim
2. Sweep N+1: SELECT same expired link → claim → throws again → unclaim
3. … forever, until either an admin fixes the definition or the
   parent's wait_timeout_at is somehow extended

**Why accepted for v1:** the common cause of a persistent resume failure
is admin-side misconfiguration. The right surface is an alert / ops
query, not an automatic dead-letter that hides the symptom. Phase 1.B
already added the `link_pending_entity_cancel` audit event for
misconfigured-branch cases; a future Phase 1.C.x can fold a
`link_resume_failed` event into the cron's catch block once we have
real production data on how often this fires.

**Ops probe (runs against any tenant):**

```sql
-- Links that the cron has been re-attempting for >5 minutes.
select wil.id, wil.parent_instance_id, wil.wait_timeout_at,
       extract(epoch from (now() - wil.wait_timeout_at))::int as stuck_seconds
  from public.workflow_instance_links wil
 where wil.spawn_mode = 'wait'
   and wil.resolved_at is null
   and wil.wait_timeout_at is not null
   and wil.wait_timeout_at < now() - interval '5 minutes'
 order by wil.wait_timeout_at asc
 limit 50;
```

A non-empty result + recent `workflow-wait-sweeper.resume_failed` log
lines indicates a stuck parent. Manual remediation: either fix the
workflow definition, or `UPDATE workflow_instances SET status='failed'`
on the parent to take it out of the active/waiting set so the cron
stops retrying.

**Trigger to fix:** the ops probe above returning >10 rows in any
24h window. At that point ship a `wait_timeout_retry_count` column
on `workflow_instance_links` + cap at N retries before emitting
`link_resume_failed` and leaving the row claimed for operator triage.
