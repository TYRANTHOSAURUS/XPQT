-- Round 6 codex fixes for post-1c.10c.
--
-- Round 5 dropped kind_matches_fk check constraints because they
-- conflicted with SET NULL FKs (parent delete → SET NULL → check
-- fails → delete blocks). That left a hole: writers can now persist
-- (entity_kind='case', work_order_id=set) — cross-kind rows that
-- corrupt downstream queries.
--
-- The auto-derive trigger from 00232 only fires when entity_kind
-- is null. Writers that explicitly set entity_kind bypass it.
--
-- Fix: BEFORE INSERT/UPDATE validator that:
--   - Permits FK columns being null when entity_kind matches and the
--     parent could plausibly have been deleted (post-SET NULL)
--   - REJECTS cross-kind: (entity_kind='case', work_order_id NOT NULL)
--     or (entity_kind='work_order', case_id NOT NULL)
--
-- Per-table because the columns differ slightly. Shared function via
-- generic table-name parameter.

create or replace function public.assert_polymorphic_entity_kind_consistent()
returns trigger
language plpgsql
as $$
begin
  -- Allow null entity_kind (transitional / pre-derive). Auto-derive
  -- trigger picks up these rows on insert.
  if new.entity_kind is null then
    return new;
  end if;

  -- entity_kind='case' must NOT have work_order_id set. case_id may be
  -- null (post-SET NULL after parent deletion).
  if new.entity_kind = 'case' then
    if new.work_order_id is not null then
      raise exception 'polymorphic integrity (%): entity_kind=case but work_order_id is set',
        tg_table_name;
    end if;
    return new;
  end if;

  -- entity_kind='work_order' must NOT have case_id set.
  if new.entity_kind = 'work_order' then
    if new.case_id is not null then
      raise exception 'polymorphic integrity (%): entity_kind=work_order but case_id is set',
        tg_table_name;
    end if;
    return new;
  end if;

  return new;
end;
$$;

comment on function public.assert_polymorphic_entity_kind_consistent() is
  'Step 1c (00240): defense after 00239 dropped kind_matches_fk. Permits null FKs (post-SET NULL) but rejects cross-kind writes. Used by sla_timers, routing_decisions, workflow_instances.';

drop trigger if exists trg_sla_timers_kind_consistency on public.sla_timers;
create trigger trg_sla_timers_kind_consistency
before insert or update of entity_kind, case_id, work_order_id
on public.sla_timers
for each row execute function public.assert_polymorphic_entity_kind_consistent();

drop trigger if exists trg_routing_decisions_kind_consistency on public.routing_decisions;
create trigger trg_routing_decisions_kind_consistency
before insert or update of entity_kind, case_id, work_order_id
on public.routing_decisions
for each row execute function public.assert_polymorphic_entity_kind_consistent();

drop trigger if exists trg_workflow_instances_kind_consistency on public.workflow_instances;
create trigger trg_workflow_instances_kind_consistency
before insert or update of entity_kind, case_id, work_order_id
on public.workflow_instances
for each row execute function public.assert_polymorphic_entity_kind_consistent();

-- Round 6 #2: domain_events entity_type classification in
-- mark_sla_breached_batch falls back to 'ticket' if work_orders no
-- longer contains the id. Prefer st.entity_kind first (set by the
-- 00230+00232 derive trigger at INSERT time), existence-fallback
-- second.

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

  update public.sla_timers
     set breached    = true,
         breached_at = p_now
   where id = any(p_timer_ids)
     and breached = false;

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

  -- Prefer st.entity_kind (set by derive trigger at insert). Existence
  -- check is the fallback for legacy rows that bypassed the trigger.
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  )
  select
    st.tenant_id,
    'sla_' || st.timer_type || '_breached',
    coalesce(
      st.entity_kind,
      case
        when exists (select 1 from public.work_orders wo where wo.id = st.ticket_id) then 'work_order'
        when exists (select 1 from public.tickets t where t.id = st.ticket_id) then 'ticket'
        else 'ticket'
      end
    ),
    st.ticket_id,
    jsonb_build_object('timer_type', st.timer_type, 'due_at', st.due_at)
  from public.sla_timers st
  where st.id = any(p_timer_ids);
end;
$$;

comment on function public.mark_sla_breached_batch(uuid[], timestamptz) is
  '00135 + 00239 + 00240: Atomically flip a batch of SLA timers + their parent (case or work_order) to breached. Uses st.entity_kind for domain_events classification, falling back to existence check.';

notify pgrst, 'reload schema';
