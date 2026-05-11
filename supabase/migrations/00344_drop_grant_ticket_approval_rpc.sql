-- B.2.A Step 10 revert cleanup — drop the dormant grant_ticket_approval RPC.
--
-- Step 10 (commit 3834b702, migration 00343, 2026-05-11) shipped the
-- grant_ticket_approval RPC + ApprovalService cutover. Plan-review +
-- codex independently surfaced a P0 regression: the RPC emits 3 outbox
-- events (sla.timer_recompute_required, routing.evaluation_required,
-- workflow.start_required) but their handlers do NOT exist in the
-- outbox-handler registry (only setup_work_order.create_required is
-- registered today per
-- apps/api/src/modules/outbox/outbox.module.ts:36). The pre-cutover TS
-- pipeline (TicketService.onApprovalDecision → runPostCreateAutomation)
-- ran routing + sla + workflow start INLINE; the cutover deferred all
-- three to outbox handlers that don't exist, leaving approval-gated
-- tickets in `status_category='new'` with no assignee, no SLA timer,
-- no workflow instance.
--
-- Codex recommended option (a) — revert Step 10, reorder remaining
-- steps to Step 12 → Step 11 → Step 10. Step 12 (§3.11
-- create_ticket_with_automation) populates `tickets.workflow_id` /
-- `tickets.sla_id` at create time per spec line 2971. Step 10 will
-- re-land after Step 12 ships the column population pipeline + the
-- 3 outbox handlers.
--
-- This migration drops the dormant function so remote state matches
-- the reverted local migration set (00343 file is deleted by the
-- revert commit). Re-creating Step 10 later will ship a fresh
-- migration (numeric prefix TBD post-Steps 11+12) with the corrected
-- preconditions in place.

drop function if exists public.grant_ticket_approval(uuid, uuid, uuid, text, jsonb);

notify pgrst, 'reload schema';
