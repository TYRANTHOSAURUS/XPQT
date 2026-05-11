-- B.2.A.Step12 commit 1 — sla_timers active unique index.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.11 line 3165 +
--       §3.9.3 line 2564 (SlaTimerHandler INSERT ... ON CONFLICT contract).
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- The `start_sla_timers` RPC (migration 00347) is called by SlaTimerHandler
-- on the `sla.timer_recompute_required` outbox event. With at-least-once
-- delivery, the handler may fire twice for the same (tenant, ticket,
-- policy, timer_type) — without a partial unique index gating "one active
-- timer per (tenant, ticket, policy, timer_type)", a second INSERT would
-- silently spawn a duplicate row and the breach cron would fire the
-- escalation chain twice.
--
-- This migration creates the partial unique index. The RPC relies on
-- `INSERT ... ON CONFLICT DO NOTHING` against this index — without it,
-- ON CONFLICT has no target. Existing schema columns (`stopped_at`,
-- `completed_at` from 00011 + 00044) are reused; no schema change to
-- `sla_timers`.
--
-- ── Cleanup contract (v6 / I4 runbook) ────────────────────────────────────
--
-- Preflight aborts if any tenant has duplicate active timers. NO
-- automated heuristic — `min(id)` has no temporal meaning under UUIDv4,
-- and a silent dedup could discard breach history or pause state. The
-- operator audits + picks the canonical row per group based on breach
-- state, due_at, started_at, and the ticket's current SLA due-date
-- columns + total_paused_minutes.
--
-- Cleanup runbook (spec line 3261 onwards):
--
-- 1) Full audit per duplicate group. Also pull the ticket's
--    sla_response_due_at / sla_resolution_due_at so the operator can see
--    which timer's due_at the ticket is actually displaying. SAVE the
--    output:
--
--    select t.id, t.tenant_id, t.ticket_id, t.sla_policy_id,
--           t.timer_type, t.started_at, t.due_at,
--           t.breached, t.breached_at,
--           t.paused, t.paused_at, t.total_paused_minutes,
--           tk.sla_response_due_at   as ticket_response_due_at,
--           tk.sla_resolution_due_at as ticket_resolution_due_at
--    from public.sla_timers t
--    join public.tickets tk on tk.id = t.ticket_id
--    join (
--      select tenant_id, ticket_id, sla_policy_id, timer_type
--      from public.sla_timers
--      where stopped_at is null and completed_at is null
--      group by 1, 2, 3, 4 having count(*) > 1
--    ) dupes
--      on  t.tenant_id     = dupes.tenant_id
--     and  t.ticket_id     = dupes.ticket_id
--     and  t.sla_policy_id = dupes.sla_policy_id
--     and  t.timer_type    = dupes.timer_type
--    where t.stopped_at   is null
--      and t.completed_at is null
--    order by t.tenant_id, t.ticket_id, t.timer_type, t.started_at;
--
-- 2) Decision criteria (operator applies per group):
--    - If exactly one row's `due_at` matches the ticket's SLA due-date
--      column → that row is canonical (UI was showing it).
--    - Else prefer oldest `started_at` (monitored longest).
--    - `breached=true` beats `breached=false` (preserve breach history).
--    - Tie on total_paused_minutes goes to most-paused (more real history).
--
-- 3) STOP non-canonical duplicates (preserves audit + breach history;
--    do NOT delete):
--
--    update public.sla_timers
--    set stopped_at = now(),
--        stopped_reason = 'deduplicated_pre_index'
--    where id in (
--      -- Row IDs from step 1 audit that the operator chose to retire.
--      '<id-1>'::uuid, '<id-2>'::uuid /* ... */
--    );
--
-- 4) Re-run migration 00346.
--
-- The canonical row keeps its existing `due_at` + breach state. UI
-- should not change post-dedup because the kept row is the one whose
-- `due_at` the ticket already displays.

-- ── 1. Preflight: detect duplicates that would violate the index ──────────

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
      'sla_timers duplicate detection: % (tenant_id, ticket_id, sla_policy_id, timer_type) groups have multiple active rows. Run the cleanup runbook in 00346 header before re-running this migration.',
      v_dupes;
  end if;
end $$;

-- ── 2. Create the partial unique index ────────────────────────────────────

create unique index if not exists sla_timers_active_unique_idx
  on public.sla_timers (tenant_id, ticket_id, sla_policy_id, timer_type)
  where stopped_at is null and completed_at is null;

comment on index public.sla_timers_active_unique_idx is
  'B.2.A.Step12 (spec §3.11 line 3165) — one active SLA timer per (tenant, ticket, policy, timer_type). Gates `INSERT ... ON CONFLICT DO NOTHING` in start_sla_timers RPC (00347) + repoint_sla_timer RPC (00348). REQUIRES preflight + operator-driven cleanup before applying — see migration header for the runbook.';

notify pgrst, 'reload schema';
