-- B.2.A.Step12 commit 1 — workflow_instances active unique index.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.11 (line 2315) +
--       §3.9.3 line 2567 (handler INSERT ... ON CONFLICT contract) +
--       §4 line 3163 (migration plan v10/00333; v13+5 = 00338 in spec
--       numbering; on-disk slot is 00345 after B.2.A.Step9-Step11 land).
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- §3.11 create_ticket_with_automation emits a `workflow.start_required`
-- outbox event on the no-approval branch when `ticket.workflow_id IS NOT
-- NULL`. The WorkflowStartHandler (§3.9.3) re-reads `ticket.workflow_id`
-- at fire time and calls WorkflowEngineService.startForTicket, which
-- INSERTs into workflow_instances. With at-least-once delivery, the
-- handler may fire twice (worker retry, payload replay) for the same
-- ticket — without a partial unique index gating "one active row per
-- (tenant, ticket)", a second INSERT would silently spawn a duplicate
-- runtime row and the workflow engine would fork.
--
-- This migration creates the partial unique index. The handler relies
-- on `INSERT ... ON CONFLICT DO NOTHING` against this index — without it,
-- ON CONFLICT has no target.
--
-- ── Cleanup contract (v6 / I3 runbook) ────────────────────────────────────
--
-- The migration opens with a preflight that aborts if any tenant has
-- duplicate active rows. There is NO automated heuristic — a silent
-- "kept the most recent" rule would discard real in-flight workflow
-- progress (decision history, parallel-branch state). The operator must
-- audit + decide per group + cancel non-canonical rows + re-run.
--
-- Cleanup runbook (spec line 3176 onwards):
--
-- 1) Audit duplicates. For each group, list every row's identifying
--    state. SAVE the output, review row-by-row before any update:
--
--    select wi.id, wi.tenant_id, wi.ticket_id, wi.status,
--           wi.started_at, wi.completed_at, wi.cancelled_at,
--           wi.workflow_definition_id, wi.workflow_version,
--           wi.current_node_id, wi.context
--    from public.workflow_instances wi
--    join (
--      select tenant_id, ticket_id
--      from public.workflow_instances
--      where status in ('active', 'waiting')
--      group by 1, 2 having count(*) > 1
--    ) dupes
--      on wi.tenant_id = dupes.tenant_id
--     and wi.ticket_id = dupes.ticket_id
--    where wi.status in ('active', 'waiting')
--    order by wi.tenant_id, wi.ticket_id, wi.started_at;
--
-- 2) Decision criteria (operator applies per group):
--    - Prefer the row whose `current_node_id` shows the most meaningful
--      progress (not the trigger node).
--    - If multiple are mid-flight, prefer the one whose `context` jsonb
--      has the most accumulated state.
--    - `started_at` recency is a weak tie-breaker, never primary.
--
-- 3) Cancel the non-canonical rows (one row per group survives):
--
--    update public.workflow_instances
--    set status = 'cancelled',
--        cancelled_at = now(),
--        cancelled_reason = 'deduplicated_pre_index',
--        cancelled_by = '<operator-user-id>'::uuid
--    where id in (
--      -- Row IDs from step 1 audit that the operator chose to retire.
--      '<id-1>'::uuid, '<id-2>'::uuid /* ... */
--    );
--
-- 4) Re-run migration 00345.
--
-- The audit output from step 1 must be retained for post-cutover
-- analysis.

-- ── 1. Preflight: detect duplicates that would violate the index ──────────

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
      'workflow_instances duplicate detection: % (tenant_id, ticket_id) groups have multiple active rows. Run the cleanup runbook in 00345 header before re-running this migration.',
      v_dupes;
  end if;
end $$;

-- ── 2. Create the partial unique index ────────────────────────────────────
--
-- IF NOT EXISTS so a partial re-run after a successful first run is a
-- no-op (PG raises 42P07 'relation already exists' otherwise). On-disk
-- index name is stable so other migrations (00046, future cancellation
-- backfills) can reference it.

create unique index if not exists workflow_instances_active_unique_idx
  on public.workflow_instances (tenant_id, ticket_id)
  where status in ('active', 'waiting');

comment on index public.workflow_instances_active_unique_idx is
  'B.2.A.Step12 (spec §3.11 line 2315) — one active runtime workflow per (tenant, ticket). Gates `INSERT ... ON CONFLICT DO NOTHING` in WorkflowStartHandler (handler contract §3.9.3 line 2567). REQUIRES preflight + operator-driven cleanup before applying — see migration header for the runbook.';

notify pgrst, 'reload schema';
