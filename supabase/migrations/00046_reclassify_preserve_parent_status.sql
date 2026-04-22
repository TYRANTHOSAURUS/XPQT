-- Reclassify: preserve parent ticket's status_category.
--
-- Bug fix. The parent-status rollup trigger (rollup_parent_status_trg,
-- migration 00030) fires on child status_category changes and promotes
-- the parent to `resolved` when ALL children are resolved/closed. Reclassify
-- closes every non-terminal child, which deterministically triggers the
-- rollup and moves the parent to `resolved` — a state the user never asked
-- for and the reclassify guard explicitly tried to avoid entering.
--
-- Fix: capture the parent's status_category at the start of the RPC, then
-- restore it in the same UPDATE that writes the reclassified_* fields (which
-- runs AFTER the child closures + rollup trigger).
--
-- Idempotent: `create or replace function` overwrites the previous body.

create or replace function public.reclassify_ticket(
  p_ticket_id              uuid,
  p_tenant_id              uuid,
  p_new_request_type_id    uuid,
  p_reason                 text,
  p_actor_user_id          uuid,
  p_new_assigned_team_id   uuid,
  p_new_assigned_user_id   uuid,
  p_new_assigned_vendor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_type_id      uuid;
  v_current_user_id      uuid;
  v_current_status_cat   text;
  v_current_status       text;
  v_cancelled_wf_ids     uuid[] := '{}';
  v_closed_children      uuid[] := '{}';
  v_stopped_timers       uuid[] := '{}';
  v_watchers             uuid[];
  v_prefixed_reason      text := 'Parent ticket reclassified: ' || p_reason;
  v_watcher_added        boolean := false;
begin
  -- Advisory lock to serialise concurrent reclassifies on the same ticket.
  if not pg_try_advisory_xact_lock(hashtext(p_ticket_id::text)) then
    raise exception 'reclassify_in_progress' using errcode = '55P03';
  end if;

  -- Load current state under a row lock. Capture status so we can restore it
  -- after the child-closure rollup trigger tries to move it.
  select ticket_type_id, assigned_user_id, coalesce(watchers, '{}'::uuid[]),
         status_category, status
    into v_current_type_id, v_current_user_id, v_watchers,
         v_current_status_cat, v_current_status
  from public.tickets
  where id = p_ticket_id and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'ticket_not_found' using errcode = 'P0002';
  end if;

  if v_current_type_id = p_new_request_type_id then
    raise exception 'same_request_type' using errcode = '22023';
  end if;

  -- 4a. Cancel any active workflow_instances for this ticket.
  with cancelled_wf as (
    update public.workflow_instances
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_reason = p_reason,
        cancelled_by = p_actor_user_id
    where ticket_id = p_ticket_id
      and tenant_id = p_tenant_id
      and status in ('active', 'waiting')
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_cancelled_wf_ids from cancelled_wf;

  -- 4b. Close non-terminal child tickets. This fires rollup_parent_status_trg
  -- which will promote this parent to `resolved`. We counteract that in 4d.
  with closed as (
    update public.tickets
    set status_category = 'closed',
        status = 'closed',
        close_reason = v_prefixed_reason,
        closed_at = now(),
        closed_by = p_actor_user_id
    where parent_ticket_id = p_ticket_id
      and tenant_id = p_tenant_id
      and status_category not in ('closed', 'resolved')
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_closed_children from closed;

  -- 4c. Stop active SLA timers.
  with stopped as (
    update public.sla_timers
    set stopped_at = now(),
        stopped_reason = p_reason
    where ticket_id = p_ticket_id
      and tenant_id = p_tenant_id
      and stopped_at is null
      and completed_at is null
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_stopped_timers from stopped;

  -- 4d. Promote previous user-assignee to watcher if they aren't already and
  -- aren't the new assignee.
  if v_current_user_id is not null
     and v_current_user_id is distinct from coalesce(p_new_assigned_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and not (v_current_user_id = any (v_watchers))
  then
    v_watchers := v_watchers || v_current_user_id;
    v_watcher_added := true;
  end if;

  -- 4d (cont). Single update on the parent row: new type + routing + watchers
  -- + reclassified_* fields + restored status. Clearing resolved_at because
  -- the rollup trigger may have set it when it promoted us.
  update public.tickets
  set ticket_type_id       = p_new_request_type_id,
      assigned_team_id     = p_new_assigned_team_id,
      assigned_user_id     = p_new_assigned_user_id,
      assigned_vendor_id   = p_new_assigned_vendor_id,
      watchers             = v_watchers,
      reclassified_at      = now(),
      reclassified_from_id = v_current_type_id,
      reclassified_reason  = p_reason,
      reclassified_by      = p_actor_user_id,
      status_category      = v_current_status_cat,
      status               = v_current_status,
      resolved_at          = case when v_current_status_cat in ('resolved', 'closed') then resolved_at else null end,
      updated_at           = now()
  where id = p_ticket_id and tenant_id = p_tenant_id;

  -- 4h. Domain events: ticket_type_changed on parent + workflow_cancelled if applicable.
  insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id,
    'ticket_type_changed',
    'ticket',
    p_ticket_id,
    jsonb_build_object(
      'from_request_type_id', v_current_type_id,
      'to_request_type_id', p_new_request_type_id,
      'reason', p_reason,
      'cancelled_workflow_instance_ids', to_jsonb(v_cancelled_wf_ids),
      'closed_child_ticket_ids', to_jsonb(v_closed_children),
      'stopped_sla_timer_ids', to_jsonb(v_stopped_timers),
      'previous_assignment', jsonb_build_object('user_id', v_current_user_id),
      'new_assignment', jsonb_build_object(
        'team_id', p_new_assigned_team_id,
        'user_id', p_new_assigned_user_id,
        'vendor_id', p_new_assigned_vendor_id
      ),
      'previous_assignee_watched', v_watcher_added
    ),
    p_actor_user_id
  );

  if array_length(v_cancelled_wf_ids, 1) > 0 then
    insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    select p_tenant_id, 'workflow_cancelled', 'ticket', p_ticket_id,
           jsonb_build_object('workflow_instance_id', wf_id, 'reason', p_reason),
           p_actor_user_id
    from unnest(v_cancelled_wf_ids) as wf_id;
  end if;

  -- 4i. One ticket_closed event per closed child, flagged as reclassify-driven.
  if array_length(v_closed_children, 1) > 0 then
    insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    select p_tenant_id, 'ticket_closed', 'ticket', child_id,
           jsonb_build_object('reason', v_prefixed_reason, 'closed_by_reclassify', true, 'parent_ticket_id', p_ticket_id),
           p_actor_user_id
    from unnest(v_closed_children) as child_id;
  end if;

  return jsonb_build_object(
    'ticket_id', p_ticket_id,
    'from_request_type_id', v_current_type_id,
    'to_request_type_id', p_new_request_type_id,
    'cancelled_workflow_instance_ids', to_jsonb(v_cancelled_wf_ids),
    'closed_child_ticket_ids', to_jsonb(v_closed_children),
    'stopped_sla_timer_ids', to_jsonb(v_stopped_timers),
    'previous_assignee_user_id', v_current_user_id,
    'previous_assignee_watched', v_watcher_added,
    'preserved_status_category', v_current_status_cat
  );
end;
$$;

notify pgrst, 'reload schema';
