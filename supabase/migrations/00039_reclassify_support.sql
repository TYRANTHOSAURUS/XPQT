-- Reclassification support: columns + RPC for atomic request-type change.
-- See docs/superpowers/specs/2026-04-21-change-request-type-design.md

-- Parent ticket: reclassification metadata, generic close tracking.
alter table public.tickets
  add column if not exists reclassified_at        timestamptz,
  add column if not exists reclassified_from_id   uuid references public.request_types(id),
  add column if not exists reclassified_reason    text,
  add column if not exists reclassified_by        uuid references public.users(id),
  add column if not exists close_reason           text,
  add column if not exists closed_by              uuid references public.users(id);

-- Workflow instance cancellation metadata.
alter table public.workflow_instances
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_reason   text,
  add column if not exists cancelled_by       uuid references public.users(id);

-- Extend workflow_instances.status to include 'cancelled'.
-- The original constraint is inline with the column (auto-named
-- workflow_instances_status_check). Drop it, then add the replacement.
alter table public.workflow_instances
  drop constraint if exists workflow_instances_status_check;

alter table public.workflow_instances
  add constraint workflow_instances_status_check
  check (status in ('active', 'waiting', 'completed', 'failed', 'cancelled'));

-- SLA timer stop metadata (distinct from pause and from breach completion).
alter table public.sla_timers
  add column if not exists stopped_at      timestamptz,
  add column if not exists stopped_reason  text;

create index if not exists sla_timers_ticket_active_idx
  on public.sla_timers (ticket_id)
  where stopped_at is null and completed_at is null;

-- reclassify_ticket: atomic write block for changing a ticket's request type.
-- All arguments are trusted — the NestJS service validates permissions,
-- tenant scope, and preconditions before calling this RPC.
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
  v_current_type_id  uuid;
  v_current_user_id  uuid;
  v_cancelled_wf_id  uuid;
  v_closed_children  uuid[] := '{}';
  v_stopped_timers   uuid[] := '{}';
  v_watchers         uuid[];
  v_prefixed_reason  text := 'Parent ticket reclassified: ' || p_reason;
  v_watcher_added    boolean := false;
begin
  -- Advisory lock to serialise concurrent reclassifies on the same ticket.
  if not pg_try_advisory_xact_lock(hashtext(p_ticket_id::text)) then
    raise exception 'reclassify_in_progress' using errcode = '55P03';
  end if;

  -- Load current state under a row lock.
  select ticket_type_id, assigned_user_id, coalesce(watchers, '{}'::uuid[])
    into v_current_type_id, v_current_user_id, v_watchers
  from public.tickets
  where id = p_ticket_id and tenant_id = p_tenant_id
  for update;

  if v_current_type_id is null and not found then
    raise exception 'ticket_not_found' using errcode = 'P0002';
  end if;

  if v_current_type_id = p_new_request_type_id then
    raise exception 'same_request_type' using errcode = '22023';
  end if;

  -- 4a. Cancel any active workflow_instances for this ticket.
  update public.workflow_instances
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      cancelled_by = p_actor_user_id
  where ticket_id = p_ticket_id
    and tenant_id = p_tenant_id
    and status in ('active', 'waiting')
  returning id into v_cancelled_wf_id;

  -- 4b. Close non-terminal child tickets.
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
      'cancelled_workflow_instance_id', v_cancelled_wf_id,
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

  if v_cancelled_wf_id is not null then
    insert into public.domain_events (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
    values (
      p_tenant_id, 'workflow_cancelled', 'ticket', p_ticket_id,
      jsonb_build_object('workflow_instance_id', v_cancelled_wf_id, 'reason', p_reason),
      p_actor_user_id
    );
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
    'cancelled_workflow_instance_id', v_cancelled_wf_id,
    'closed_child_ticket_ids', to_jsonb(v_closed_children),
    'stopped_sla_timer_ids', to_jsonb(v_stopped_timers),
    'previous_assignee_user_id', v_current_user_id,
    'previous_assignee_watched', v_watcher_added
  );
end;
$$;

grant execute on function public.reclassify_ticket(uuid, uuid, uuid, text, uuid, uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
