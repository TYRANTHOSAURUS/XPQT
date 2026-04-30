-- Step 1c.1 follow-up: rename work_orders_new.parent_case_id →
-- parent_ticket_id to match the bridge convention.
--
-- The plan reviewer flagged that 'parent_case_id' is the END-state name
-- (after step 6 renames tickets → cases). During the bridge, every reader
-- that uses public.work_orders (currently a view) sees `parent_ticket_id`.
-- When 1c.3.6 renames work_orders_new → work_orders, those readers would
-- break with `parent_case_id` as the column name.
--
-- Rename now to match the existing public.work_orders view's column name.
-- The column name will be re-renamed (parent_ticket_id → parent_case_id)
-- at step 6 in the same migration that renames the tickets table.

alter table public.work_orders_new rename column parent_case_id to parent_ticket_id;

-- The trigger function references parent_case_id — recreate with the new name.
-- All other body logic identical to 00217.
create or replace function public.shadow_ticket_to_work_orders_new()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('xpqt.dual_write_reverse_active', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.ticket_kind = 'work_order' then
      delete from public.work_orders_new where legacy_ticket_id = old.id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.ticket_kind = 'work_order' and new.ticket_kind != 'work_order' then
    delete from public.work_orders_new where legacy_ticket_id = new.id;
    return new;
  end if;

  if new.ticket_kind != 'work_order' then
    return new;
  end if;

  insert into public.work_orders_new (
    id, tenant_id, ticket_type_id, parent_kind, parent_ticket_id, booking_bundle_id,
    title, description, status, status_category, waiting_reason, interaction_mode,
    priority, impact, urgency, requester_person_id, requested_for_person_id,
    location_id, asset_id, assigned_team_id, assigned_user_id, assigned_vendor_id,
    workflow_id, sla_id, source_channel, tags, watchers, cost,
    satisfaction_rating, satisfaction_comment, form_data,
    sla_response_due_at, sla_resolution_due_at, sla_response_breached_at,
    sla_resolution_breached_at, sla_at_risk, sla_paused, sla_paused_at,
    sla_total_paused_minutes, module_number, external_system, external_id,
    linked_order_line_item_id, planned_start_at, planned_duration_minutes,
    reclassified_at, reclassified_from_id, reclassified_reason, reclassified_by,
    close_reason, closed_by, created_at, updated_at, resolved_at, closed_at,
    legacy_ticket_id
  ) values (
    new.id, new.tenant_id, new.ticket_type_id,
    case
      when new.booking_bundle_id is not null then 'booking_bundle'
      when new.parent_ticket_id is not null  then 'case'
      else null
    end,
    new.parent_ticket_id, new.booking_bundle_id,
    new.title, new.description, new.status, new.status_category, new.waiting_reason,
    new.interaction_mode, new.priority, new.impact, new.urgency,
    new.requester_person_id, new.requested_for_person_id, new.location_id,
    new.asset_id, new.assigned_team_id, new.assigned_user_id, new.assigned_vendor_id,
    new.workflow_id, new.sla_id, new.source_channel,
    coalesce(new.tags, '{}'::text[]), coalesce(new.watchers, '{}'::uuid[]),
    new.cost, new.satisfaction_rating, new.satisfaction_comment, new.form_data,
    new.sla_response_due_at, new.sla_resolution_due_at, new.sla_response_breached_at,
    new.sla_resolution_breached_at, new.sla_at_risk, new.sla_paused, new.sla_paused_at,
    new.sla_total_paused_minutes, new.module_number, new.external_system, new.external_id,
    new.linked_order_line_item_id, new.planned_start_at, new.planned_duration_minutes,
    new.reclassified_at, new.reclassified_from_id, new.reclassified_reason, new.reclassified_by,
    new.close_reason, new.closed_by, new.created_at, new.updated_at, new.resolved_at, new.closed_at,
    new.id
  )
  on conflict (legacy_ticket_id) do update set
    tenant_id = excluded.tenant_id,
    ticket_type_id = excluded.ticket_type_id,
    parent_kind = excluded.parent_kind,
    parent_ticket_id = excluded.parent_ticket_id,
    booking_bundle_id = excluded.booking_bundle_id,
    title = excluded.title,
    description = excluded.description,
    status = excluded.status,
    status_category = excluded.status_category,
    waiting_reason = excluded.waiting_reason,
    interaction_mode = excluded.interaction_mode,
    priority = excluded.priority,
    impact = excluded.impact,
    urgency = excluded.urgency,
    requester_person_id = excluded.requester_person_id,
    requested_for_person_id = excluded.requested_for_person_id,
    location_id = excluded.location_id,
    asset_id = excluded.asset_id,
    assigned_team_id = excluded.assigned_team_id,
    assigned_user_id = excluded.assigned_user_id,
    assigned_vendor_id = excluded.assigned_vendor_id,
    workflow_id = excluded.workflow_id,
    sla_id = excluded.sla_id,
    source_channel = excluded.source_channel,
    tags = excluded.tags,
    watchers = excluded.watchers,
    cost = excluded.cost,
    satisfaction_rating = excluded.satisfaction_rating,
    satisfaction_comment = excluded.satisfaction_comment,
    form_data = excluded.form_data,
    sla_response_due_at = excluded.sla_response_due_at,
    sla_resolution_due_at = excluded.sla_resolution_due_at,
    sla_response_breached_at = excluded.sla_response_breached_at,
    sla_resolution_breached_at = excluded.sla_resolution_breached_at,
    sla_at_risk = excluded.sla_at_risk,
    sla_paused = excluded.sla_paused,
    sla_paused_at = excluded.sla_paused_at,
    sla_total_paused_minutes = excluded.sla_total_paused_minutes,
    module_number = excluded.module_number,
    external_system = excluded.external_system,
    external_id = excluded.external_id,
    linked_order_line_item_id = excluded.linked_order_line_item_id,
    planned_start_at = excluded.planned_start_at,
    planned_duration_minutes = excluded.planned_duration_minutes,
    reclassified_at = excluded.reclassified_at,
    reclassified_from_id = excluded.reclassified_from_id,
    reclassified_reason = excluded.reclassified_reason,
    reclassified_by = excluded.reclassified_by,
    close_reason = excluded.close_reason,
    closed_by = excluded.closed_by,
    updated_at = excluded.updated_at,
    resolved_at = excluded.resolved_at,
    closed_at = excluded.closed_at;

  return new;
end;
$$;

-- The CHECK constraint references the column — recreate with new name.
alter table public.work_orders_new
  drop constraint work_orders_new_kind_matches_fk;
alter table public.work_orders_new
  add constraint work_orders_new_kind_matches_fk
  check (
    (parent_kind is null     and parent_ticket_id is null and booking_bundle_id is null)
    or (parent_kind = 'case'           and parent_ticket_id is not null and booking_bundle_id is null)
    or (parent_kind = 'booking_bundle' and parent_ticket_id is null     and booking_bundle_id is not null)
  );

alter table public.work_orders_new
  drop constraint work_orders_new_single_parent;
alter table public.work_orders_new
  add constraint work_orders_new_single_parent
  check (parent_ticket_id is null or booking_bundle_id is null);

-- Index: rename to match
drop index if exists public.idx_won_parent_case;
create index idx_won_parent_ticket
  on public.work_orders_new (parent_ticket_id) where parent_ticket_id is not null;

notify pgrst, 'reload schema';
