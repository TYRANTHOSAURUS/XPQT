-- Universal Workflow Architecture — Phase 1.B: extend workflow_instance_events
-- event_type CHECK constraint to admit three new audit event types emitted by
-- the cancellation cascade.
--
-- Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.6
--       (Cancellation propagation — full design + cascade order + visited-set).
--
-- ── Slot note ─────────────────────────────────────────────────────────────
--
-- Originally drafted at slot 00374. At execution time
-- `00374_work_orders_visibility.sql` (planning-board chunk 1, commit
-- b691953d) had already shipped, and slot 00375 was reserved by the
-- floor-plan branch in a parallel session. Net result: this migration
-- lands at slot 00376.
--
-- ── Why this migration matters (regression-class lesson) ──────────────────
--
-- 00366_workflow_events_add_node_failed.sql shipped to fix exactly this class
-- of regression: the engine's `emit()` (workflow-engine.service.ts:978-996)
-- wraps every insert in a try/catch and console.warn's on failure. A missing
-- CHECK literal therefore causes Postgres to reject the row with code 23514
-- (check_violation), the bare catch swallows it, and the audit trail loses
-- the event entirely. The user-visible symptom is a workflow row whose
-- timeline says "active" then "cancelled" with NO node-level evidence of
-- what cascaded — exactly the failure mode that drove 00366 (see that
-- migration's header for the original Step 8 'node_failed' silent-drop).
--
-- Phase 1.B emits three NEW event_types via WorkflowEngineService.cancelInstance
-- and its cascade loop:
--
--   * 'instance_cancelled'             — emitted ONCE per cancelInstance() that
--                                         actually flips a workflow_instance to
--                                         status='cancelled'. Carries reason +
--                                         entity_kind + entity_id, plus
--                                         triggered_by_link_id +
--                                         parent_instance_id when the cancel
--                                         was triggered by a parent cascade
--                                         (so the audit trail visualises the
--                                         chain).
--
--   * 'link_resolved'                  — emitted PER workflow_instance_links
--                                         row that the cascade resolves with
--                                         resolution_kind='parent_cancelled'.
--                                         Distinct from 'instance_cancelled'
--                                         so the timeline can render the
--                                         link-row resolution and the child
--                                         instance cancellation as separate
--                                         events (the link is the "spawn
--                                         contract"; the child instance is
--                                         the "spawned workflow").
--
--   * 'link_pending_entity_cancel'     — emitted when entity-level cancel
--                                         fails or is deferred. Three causes:
--                                         (a) booking compensation RPC
--                                         returned partial_failure (recurrence
--                                         series alive), so the link STAYS
--                                         resolved_at NULL for ops to finish.
--                                         (b) booking compensation RPC threw
--                                         a transient exception, ditto.
--                                         (c) child_entity_kind in
--                                         ('case','work_order') — entity-
--                                         level cancel is deferred to a future
--                                         Phase 1.B.x followup; the link IS
--                                         resolved + the child workflow is
--                                         recursively cancelled, but the
--                                         entity row itself stays open and
--                                         this event records the deferred
--                                         contract.
--                                         (d) link UPDATE itself failed mid-
--                                         cascade (transient blip); cascade
--                                         continues to next link, ops sees
--                                         this event for triage.
--
-- Without this CHECK extension, every emit of these three types is silently
-- dropped by the bare-catch in `emit()` — same regression class as the
-- Step 8 / 00366 'node_failed' miss. The runnable guard test shipped
-- alongside this migration (workflow-engine.service.spec.ts) asserts that
-- every event_type literal used by emit() callers in the codebase is
-- present in this CHECK list, so future drift is caught at jest time
-- before it reaches a deploy.
--
-- ── Cleanup runbook ─────────────────────────────────────────────────────
--
-- Purely additive vocabulary widening — no backfill, no destructive alter.
-- Idempotent (drops the constraint by definition lookup, then re-adds with
-- a stable name). Failure modes:
--
--   * `drop constraint` lookup returns multiple matches: the do-block uses
--     LIMIT 1 + matches by `pg_get_constraintdef ilike '%event_type%'`.
--     If there are multiple event_type CHECKs, fix that drift first (run
--     the lookup query manually + pick one to keep).
--   * `add constraint` fails with `check_violation`: there's an existing
--     row with an event_type not in the new list. Audit pre-existing
--     vocabulary with `select distinct event_type from
--     workflow_instance_events;` and either backfill the row or extend
--     this CHECK.

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t on c.conrelid = t.oid
  join pg_namespace n on t.relnamespace = n.oid
  where n.nspname = 'public'
    and t.relname = 'workflow_instance_events'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%event_type%'
  limit 1;

  if v_name is not null then
    execute format('alter table public.workflow_instance_events drop constraint %I', v_name);
  end if;
end$$;

alter table public.workflow_instance_events
  add constraint workflow_instance_events_event_type_check
  check (event_type in (
    -- Pre-existing vocabulary (00026 baseline + 00366 Step 8 add).
    'node_entered', 'node_exited', 'node_failed', 'decision_made',
    'instance_started', 'instance_completed', 'instance_failed',
    'instance_waiting', 'instance_resumed',
    -- Phase 1.B cascade vocabulary (this migration).
    'instance_cancelled', 'link_resolved', 'link_pending_entity_cancel'
  ));

comment on constraint workflow_instance_events_event_type_check
  on public.workflow_instance_events is
  'Spec 2026-05-12 §3.6 (cancellation cascade). event_type vocabulary including Phase 1.B cancel + link-resolution audit events. Drift between this list and WorkflowEngineService.emit() callers is caught by the runnable guard test in workflow-engine.service.spec.ts.';
