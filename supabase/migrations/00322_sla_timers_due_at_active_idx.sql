-- B.2.A foundation fix — partial index optimised for the breach +
-- threshold cron readers in apps/api/src/modules/sla/sla.service.ts.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.3 (C3 follow-up).
--
-- 00319 shipped (tenant_id, sla_policy_id, ticket_id) which serves the
-- timer-reseat path (queries that filter by sla_policy_id) but is
-- suboptimal for the hot breach/threshold scans, which order/filter on
-- due_at and don't predicate sla_policy_id. Both reviews flagged this.
--
-- The hot readers, verified against current code:
--
--   sla.service.ts:333  checkBreaches() —
--     .from('sla_timers')
--     .eq('breached', false)
--     .eq('paused', false)
--     .is('completed_at', null)
--     .is('stopped_at', null)
--     .lt('due_at', now)
--     .limit(100)
--
--   sla.service.ts:823  processThresholds() —
--     .from('sla_timers')
--     .eq('breached', false)
--     .eq('paused', false)
--     .is('completed_at', null)
--     .is('stopped_at', null)
--     .order('due_at', { ascending: true })
--     .limit(500)
--
-- Both filter on the same boolean+null predicate set and order by
-- due_at. A partial index leading on due_at, predicated on the
-- always-true clauses (stopped_at/completed_at null + breached/paused
-- false + recompute_pending=false per 00319) lets the planner scan
-- the index in due_at order and stop after LIMIT — no sort, no heap
-- scan beyond the limit.
--
-- Why not just rely on idx_sla_timers_active (00043,
-- (tenant_id, due_at) WHERE breached=false AND paused=false AND
-- completed_at IS NULL): it lacks stopped_at IS NULL (added in 00044)
-- and recompute_pending=false (added in 00319). The breach query now
-- carries those clauses, so 00043's index is no longer a perfect
-- predicate match — Postgres can still use it but must recheck the
-- missing clauses against the heap. This new index includes them all,
-- giving an index-only path on the hot readers.
--
-- Why not drop 00319's index: it serves a different access pattern —
-- the timer-reseat / pause-resume path filters by
-- (tenant_id, sla_policy_id) and benefits from sla_policy_id as the
-- second key. Two complementary partials, picked by the planner per
-- query shape.

create index if not exists sla_timers_breach_active_due_idx
  on public.sla_timers (tenant_id, due_at)
  where recompute_pending = false
    and stopped_at is null
    and completed_at is null
    and breached = false
    and paused = false;

comment on index public.sla_timers_breach_active_due_idx is
  'B.2.A C3 (00322) — partial index for breach/threshold cron readers in sla.service.ts:333 and :823. Leading column due_at + predicate matching the hot readers'' WHERE means EXPLAIN picks this for ORDER BY due_at LIMIT N. Complementary to sla_timers_active_recompute_pending_idx (00319) which serves timer-reseat queries filtering by sla_policy_id.';
