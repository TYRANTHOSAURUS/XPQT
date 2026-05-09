-- B.2.A.5 — tickets.routing_status + tickets.routing_failure_reason.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.9.2 (I2) +
-- §4 (line 3104).
--
-- v2 decision (per spec table at line 2505): split routing by surface.
--   * sync routing — POST /tickets, POST /tickets/:id/dispatch
--     (latency-critical; requester sees the assigned team / SLA on
--     the success page).
--   * async routing — approval-grant follow-up (§3.5), reclassify
--     follow-up (§3.10), re-routing on transition.
--
-- Async-routing surfaces use routing_status to coexist with sync
-- routing without UI confusion:
--   'idle'    — no async run pending. Steady state for sync-routed
--               or unassigned tickets.
--   'pending' — outbox handler will route. Set in the same tx as the
--               trigger event (post-grant, reclassify). Desk UI shows
--               a small "Routing..." chip.
--   'failed'  — handler retries exhausted. routing_failure_reason
--               carries the plain-text cause for ops triage.
--
-- v5 / I4 — 'unassigned' is a terminal valid result per
-- docs/assignments-routing-fulfillment.md:149, NOT a failure. The
-- handler clears routing_status to 'idle' on success OR on a valid
-- unassigned outcome; only genuine errors (resolver throws, FK
-- validation rejects, downstream RPC errors) flip to 'failed'.
--
-- The "Unassigned" pill on the desk UI is driven separately by the
-- absence of assigned_team_id/user_id/vendor_id — orthogonal to
-- routing_status.

alter table public.tickets
  add column if not exists routing_status text not null default 'idle'
    check (routing_status in ('idle', 'pending', 'failed'));

alter table public.tickets
  add column if not exists routing_failure_reason text;

comment on column public.tickets.routing_status is
  'B.2.A I2 — async-routing surfaces use this to coexist with sync routing on create/dispatch. ''idle'' = no async run pending; ''pending'' = outbox handler will route; ''failed'' = handler retries exhausted. Sync routing (POST /tickets, POST /tickets/:id/dispatch) leaves this at ''idle''. Async surfaces (post-grant §3.5, reclassify §3.10, transition re-route) set ''pending'' in the trigger tx; handler clears to ''idle'' on success or valid ''unassigned'' outcome, sets ''failed'' only on genuine errors. Spec: docs/follow-ups/b2-survey-and-design.md §3.9.2.';

comment on column public.tickets.routing_failure_reason is
  'Plain-text cause set when routing_status=''failed''. Persists for ops triage; cleared when routing_status returns to ''idle''. Sourced from the outbox handler error message (resolver throw, FK validation reject, downstream RPC error). Spec: docs/follow-ups/b2-survey-and-design.md §3.9.2.';
