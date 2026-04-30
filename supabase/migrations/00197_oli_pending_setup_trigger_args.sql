-- 00197_oli_pending_setup_trigger_args.sql
-- Slice 2 closeout: persist the deferred setup-work-order TriggerArgs on the
-- OLI when bundle/order creation defers auto-creation due to a pending
-- approval. On approval grant, ApprovalService → BundleService.onApprovalDecided
-- reads this back and re-fires SetupWorkOrderTriggerService.
--
-- Why persist instead of re-resolve at grant time:
--   * Deterministic — the args we'd have fired at creation are exactly the
--     ones we fire on grant, even if rules / matrix / catalog change between.
--   * Cheap — no need to reconstruct ServiceEvaluationContext per OLI on the
--     approval-decided path (heavy data assembly).
--   * Auditable — the deferral payload is visible alongside the line.
--
-- Sparse column: only set on lines that deferred. Cleared on approval grant
-- (after successful trigger fire), on rejection, and on cancel. NULL is the
-- common case.

alter table public.order_line_items
  add column if not exists pending_setup_trigger_args jsonb;

comment on column public.order_line_items.pending_setup_trigger_args is
  'Snapshot of SetupWorkOrderTriggerService TriggerArgs persisted at bundle/order creation when auto-creation was deferred pending approval. Cleared on approval grant (after re-fire), rejection, or line cancel. NULL for lines that did not defer.';
