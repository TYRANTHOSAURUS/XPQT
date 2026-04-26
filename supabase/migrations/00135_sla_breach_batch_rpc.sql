-- 00135_sla_breach_batch_rpc.sql
-- Atomic SLA breach materialisation.
--
-- SlaService.checkBreaches() runs every minute and used to issue ~3 round
-- trips per breached timer (timer flag, ticket flag, domain event) plus an
-- additional update per at-risk timer. The sweep was already batched in
-- application code, but the four resulting writes were still independent —
-- a partial failure (e.g. tickets update fails after sla_timers update has
-- already committed) leaves the dataset in an inconsistent state where the
-- timers say "breached" while the parent ticket has no breach timestamp.
--
-- This RPC commits all four writes in a single transaction. Application
-- code calls it with the precomputed timer-id list; Postgres guarantees
-- atomicity, so either all the breach state is visible after the cron tick
-- or none of it is.

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

  -- Stamp the parent ticket's breach timestamp by timer_type. A single
  -- UPDATE...FROM joins back to the timer rows so we don't have to round
  -- trip per timer_type from the API.
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

  -- Audit / notification feed. One row per breached timer, payload mirrors
  -- the previous shape so any consumers (notification handlers, BI) keep
  -- working untouched.
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  )
  select
    st.tenant_id,
    'sla_' || st.timer_type || '_breached',
    'ticket',
    st.ticket_id,
    jsonb_build_object('timer_type', st.timer_type, 'due_at', st.due_at)
  from public.sla_timers st
  where st.id = any(p_timer_ids);
end;
$$;

comment on function public.mark_sla_breached_batch(uuid[], timestamptz) is
  'Atomically flip a batch of SLA timers + their parent tickets to breached. See 00135.';
