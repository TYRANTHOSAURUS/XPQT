-- audit-02 Code-I1 — make the routing-evaluation handler's routing_decisions
-- audit inserts idempotent under OUTBOX REDELIVERY.
--
-- Problem: RoutingEvaluationHandler writes an append-only routing_decisions
-- audit row per drained `routing.evaluation_required` event. The outbox is
-- at-least-once; the assignment RPC (set_entity_assignment) is already
-- idempotent via command_operations, so a redelivery does NOT double-assign
-- — but the audit insert was unguarded, so a redelivered event wrote a
-- DUPLICATE routing_decisions row pointing at the same outbox_event_id.
--
-- Fix (codex design-check: Approach A with EXPLICIT conflict target,
-- GO-WITH-CHANGES): a PARTIAL UNIQUE INDEX on
-- (tenant_id, context->>'outbox_event_id', chosen_by) for rows that carry
-- an `outbox_event_id` in their context jsonb. The paired handler change
-- adds an `ON CONFLICT ... DO NOTHING` with a conflict target that matches
-- this index exactly so the inference binds. chosen_by is in the key so the
-- success-path row and the markRoutingFailure sentinel row for the same
-- event do not collide with each other (distinct chosen_by values), while a
-- genuine same-path redelivery still collapses to one row.
--
-- Index-only (no dedup step): remote was verified to have 0 pre-existing
-- duplicate (tenant_id, outbox_event_id, chosen_by) groups and 0 null
-- chosen_by rows among context ? 'outbox_event_id' rows, so CREATE UNIQUE
-- INDEX cannot fail on existing data. Rows WITHOUT an outbox_event_id
-- (manual reassigns, RPC-internal audit rows) are excluded by the partial
-- predicate and remain entirely unconstrained — append-only as before.
--
-- ROLLBACK COUPLING (review IMPORTANT-1): this migration and the paired
-- RoutingEvaluationHandler change are a COUPLED PAIR and are NOT
-- independently rollback-safe. The handler emits an EXPLICIT-target
-- `ON CONFLICT (tenant_id,(context->>'outbox_event_id'),chosen_by)
-- WHERE context ? 'outbox_event_id' DO NOTHING`. If this index is dropped
-- while the handler change is still deployed, Postgres raises "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification" on
-- EVERY routing evaluation → audit_insert_failed → outbox retry →
-- dead-letter (routing evaluation fully broken). Deploy order is
-- index-first (this migration is `if not exists`, additive, safe to apply
-- ahead of the code per repo migration discipline). Forward-only: never
-- drop uq_routing_decisions_outbox_event independently of reverting the
-- handler. Tracked in the Code-I1 closure ledger row.

create unique index if not exists uq_routing_decisions_outbox_event
  on public.routing_decisions (tenant_id, (context->>'outbox_event_id'), chosen_by)
  where context ? 'outbox_event_id';

notify pgrst, 'reload schema';
