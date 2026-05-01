-- Round 5 codex fixes for post-1c.10c.
--
-- 1. kind_matches_fk check constraints conflict with ON DELETE SET NULL
--    FKs added in 00238. When a parent case is deleted, the SET NULL
--    fires which UPDATEs the dependent row to set case_id=NULL. The
--    check then refuses (entity_kind='case' must have case_id NOT
--    NULL). Net effect: parent delete BLOCKS instead of cleanly
--    nulling. The auto-derive trigger (00230+00232) already enforces
--    correct entity_kind on INSERT, so the check is belt+suspenders.
--    Drop them.
--
-- 2. mark_sla_breached_batch (00135) only updates public.tickets when
--    materializing breach timestamps. Post-1c.10c, work-order timers
--    have ticket_id pointing at a work_orders row, not tickets — the
--    UPDATE matches no rows, so work-order breach timestamps never
--    propagate. Rewrite to update both tables.
--    Resolved by joining on either tickets.id OR work_orders.id and
--    issuing the update against the right table.

-- ── 1. Drop kind_matches_fk check constraints ────────────────
alter table public.sla_timers
  drop constraint if exists sla_timers_kind_matches_fk;
alter table public.routing_decisions
  drop constraint if exists routing_decisions_kind_matches_fk;
alter table public.workflow_instances
  drop constraint if exists workflow_instances_kind_matches_fk;

-- ── 2. Rewrite mark_sla_breached_batch to handle both tables ─
create or replace function public.mark_sla_breached_batch(
  p_timer_ids uuid[],
  p_now timestamptz
)
returns void
language plpgsql
as $$
begin
  if p_timer_ids is null or cardinality(p_timer_ids) = 0 then
    return;
  end if;

  -- Mark the timers themselves.
  update public.sla_timers
     set breached    = true,
         breached_at = p_now
   where id = any(p_timer_ids)
     and breached = false;

  -- Stamp the parent's breach timestamp by timer_type. The parent could
  -- be a case (in tickets) or a work_order (in work_orders) post-1c.10c.
  -- Run both UPDATEs; each only matches the rows in its table.

  update public.tickets t
     set sla_response_breached_at = p_now
    from public.sla_timers st
   where st.id = any(p_timer_ids)
     and st.timer_type = 'response'
     and st.ticket_id = t.id
     and t.sla_response_breached_at is null;

  update public.tickets t
     set sla_resolution_breached_at = p_now
    from public.sla_timers st
   where st.id = any(p_timer_ids)
     and st.timer_type = 'resolution'
     and st.ticket_id = t.id
     and t.sla_resolution_breached_at is null;

  update public.work_orders wo
     set sla_response_breached_at = p_now
    from public.sla_timers st
   where st.id = any(p_timer_ids)
     and st.timer_type = 'response'
     and st.ticket_id = wo.id
     and wo.sla_response_breached_at is null;

  update public.work_orders wo
     set sla_resolution_breached_at = p_now
    from public.sla_timers st
   where st.id = any(p_timer_ids)
     and st.timer_type = 'resolution'
     and st.ticket_id = wo.id
     and wo.sla_resolution_breached_at is null;

  -- Audit / notification feed. entity_type changes per source — best-
  -- effort: classify by which table the timer's ticket_id lives in.
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  )
  select
    st.tenant_id,
    'sla_' || st.timer_type || '_breached',
    case
      when exists (select 1 from public.work_orders wo where wo.id = st.ticket_id) then 'work_order'
      else 'ticket'
    end,
    st.ticket_id,
    jsonb_build_object('timer_type', st.timer_type, 'due_at', st.due_at)
  from public.sla_timers st
  where st.id = any(p_timer_ids);
end;
$$;

comment on function public.mark_sla_breached_batch(uuid[], timestamptz) is
  'Atomically flip a batch of SLA timers + their parent (case or work_order) to breached. Step 1c.10c-aware: post-cutover, the parent may be in tickets OR work_orders depending on legacy_ticket_id mapping. (00135 + 00239)';

notify pgrst, 'reload schema';
