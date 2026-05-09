-- B.2.A.4 — sla_timers.recompute_pending column + partial index.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.3 (C3) +
-- §4 (line 3103).
--
-- Codex review of B.2 v1 found that async SLA resume is NOT safe:
-- the breach cron at apps/api/src/modules/sla/sla.service.ts:333
-- reads paused=false AND a not-yet-recomputed due_at, sees the timer
-- "should have fired", and emits a false breach. Window is small (RPC
-- tx commit → outbox worker landing recomputed due_at) but non-zero;
-- on a busy tenant the cron tick runs every 30s.
--
-- recompute_pending closes the gap:
--   * Any RPC that flips paused=false OR re-points sla_id MUST set
--     recompute_pending=true in the same UPDATE.
--   * Every reader comparing now() >= due_at MUST add
--     AND recompute_pending = false.
--   * Worker computes new due_at, then atomically UPDATEs
--     (due_at = $new, recompute_pending = false) — single statement.
--     If the worker fails mid-recompute, recompute_pending stays
--     true, next tick retries, no false breach in the gap.
--
-- Scope clarification (v5 / C2): the flag is for the existing-timer
-- pause/resume case. Fresh inserts always have due_at filled by TS
-- plan-build (per SlaTimerHandler in §3.9.3); recompute_pending is
-- NEVER set on insert. Schema's due_at NOT NULL is honoured at all
-- times.

alter table public.sla_timers
  add column if not exists recompute_pending boolean not null default false;

-- Partial index for breach/threshold/at-risk readers — keeps the
-- "compute due dates" query fast when most rows have
-- recompute_pending=false. Mirrors the predicate set on the existing
-- sla_timers_ticket_active_idx (stopped_at IS NULL, completed_at IS NULL)
-- so the planner picks this index when the readers add the new clause.
create index if not exists sla_timers_active_recompute_pending_idx
  on public.sla_timers (tenant_id, sla_policy_id, ticket_id)
  where recompute_pending = false
    and stopped_at is null
    and completed_at is null;

comment on column public.sla_timers.recompute_pending is
  'B.2.A C3 — true while an async SLA recompute is in flight. Breach/threshold/at-risk readers MUST add ''AND recompute_pending = false'' to skip rows whose due_at is mid-recompute. Set true on any UPDATE that flips paused=false or re-points sla_id; cleared atomically when worker writes the new due_at. Spec: docs/follow-ups/b2-survey-and-design.md §3.3.';
