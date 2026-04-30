-- Step 1c.3.5 follow-up: move legacy_ticket_id backfill into the reverse
-- trigger AFTER it creates the tickets row.
--
-- 00224 added a BEFORE INSERT trigger that set legacy_ticket_id = id when
-- null. But that runs BEFORE the FK check, and tickets row doesn't exist
-- yet (the reverse trigger creates it later, in AFTER INSERT). Result:
-- FK violation on the INSERT itself.
--
-- Fix: drop the BEFORE INSERT trigger; instead do the backfill UPDATE in
-- the reverse trigger's INSERT branch, AFTER the tickets row is created.
-- The forward trigger fires at depth=2 on this UPDATE and skips
-- (depth-based loop guard from 00223), so no recursion.

drop trigger if exists work_orders_backfill_legacy_ticket_id_trg on public.work_orders;
drop function if exists public.work_orders_backfill_legacy_ticket_id();

-- Update reverse trigger to backfill legacy_ticket_id after tickets INSERT.
create or replace function public.shadow_work_orders_new_to_tickets()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    delete from public.tickets where id = old.id and ticket_kind = 'work_order';
    return old;
  end if;

  if tg_op = 'INSERT' then
    insert into public.tickets (
      id, tenant_id, ticket_type_id, ticket_kind, parent_ticket_id,
      booking_bundle_id, title, description, status, status_category,
      waiting_reason, interaction_mode, priority, impact, urgency,
      requester_person_id, requested_for_person_id, location_id,
      asset_id, assigned_team_id, assigned_user_id, assigned_vendor_id,
      workflow_id, sla_id, source_channel, tags, watchers, cost,
      satisfaction_rating, satisfaction_comment, form_data,
      sla_response_due_at, sla_resolution_due_at, sla_response_breached_at,
      sla_resolution_breached_at, sla_at_risk, sla_paused, sla_paused_at,
      sla_total_paused_minutes, module_number, external_system, external_id,
      linked_order_line_item_id, planned_start_at, planned_duration_minutes,
      reclassified_at, reclassified_from_id, reclassified_reason, reclassified_by,
      close_reason, closed_by, created_at, updated_at, resolved_at, closed_at
    ) values (
      new.id, new.tenant_id, new.ticket_type_id, 'work_order', new.parent_ticket_id,
      new.booking_bundle_id, new.title, new.description, new.status, new.status_category,
      new.waiting_reason, new.interaction_mode, new.priority, new.impact, new.urgency,
      new.requester_person_id, new.requested_for_person_id, new.location_id,
      new.asset_id, new.assigned_team_id, new.assigned_user_id, new.assigned_vendor_id,
      new.workflow_id, new.sla_id, new.source_channel, new.tags, new.watchers, new.cost,
      new.satisfaction_rating, new.satisfaction_comment, new.form_data,
      new.sla_response_due_at, new.sla_resolution_due_at, new.sla_response_breached_at,
      new.sla_resolution_breached_at, new.sla_at_risk, new.sla_paused, new.sla_paused_at,
      new.sla_total_paused_minutes, new.module_number, new.external_system, new.external_id,
      new.linked_order_line_item_id, new.planned_start_at, new.planned_duration_minutes,
      new.reclassified_at, new.reclassified_from_id, new.reclassified_reason, new.reclassified_by,
      new.close_reason, new.closed_by, new.created_at, new.updated_at, new.resolved_at, new.closed_at
    )
    on conflict (id) do nothing;

    -- Backfill legacy_ticket_id when null (post-1c.4 native writes). Now
    -- safe because the tickets row exists. Forward trigger fires at depth=2
    -- on this UPDATE and skips.
    if new.legacy_ticket_id is null then
      update public.work_orders set legacy_ticket_id = new.id
       where id = new.id and legacy_ticket_id is null;
    end if;

    return new;
  end if;

  if tg_op = 'UPDATE' then
    update public.tickets set
      tenant_id = new.tenant_id,
      ticket_type_id = new.ticket_type_id,
      parent_ticket_id = new.parent_ticket_id,
      booking_bundle_id = new.booking_bundle_id,
      title = new.title,
      description = new.description,
      status = new.status,
      status_category = new.status_category,
      waiting_reason = new.waiting_reason,
      interaction_mode = new.interaction_mode,
      priority = new.priority,
      impact = new.impact,
      urgency = new.urgency,
      requester_person_id = new.requester_person_id,
      requested_for_person_id = new.requested_for_person_id,
      location_id = new.location_id,
      asset_id = new.asset_id,
      assigned_team_id = new.assigned_team_id,
      assigned_user_id = new.assigned_user_id,
      assigned_vendor_id = new.assigned_vendor_id,
      workflow_id = new.workflow_id,
      sla_id = new.sla_id,
      source_channel = new.source_channel,
      tags = new.tags,
      watchers = new.watchers,
      cost = new.cost,
      satisfaction_rating = new.satisfaction_rating,
      satisfaction_comment = new.satisfaction_comment,
      form_data = new.form_data,
      sla_response_due_at = new.sla_response_due_at,
      sla_resolution_due_at = new.sla_resolution_due_at,
      sla_response_breached_at = new.sla_response_breached_at,
      sla_resolution_breached_at = new.sla_resolution_breached_at,
      sla_at_risk = new.sla_at_risk,
      sla_paused = new.sla_paused,
      sla_paused_at = new.sla_paused_at,
      sla_total_paused_minutes = new.sla_total_paused_minutes,
      module_number = new.module_number,
      external_system = new.external_system,
      external_id = new.external_id,
      linked_order_line_item_id = new.linked_order_line_item_id,
      planned_start_at = new.planned_start_at,
      planned_duration_minutes = new.planned_duration_minutes,
      reclassified_at = new.reclassified_at,
      reclassified_from_id = new.reclassified_from_id,
      reclassified_reason = new.reclassified_reason,
      reclassified_by = new.reclassified_by,
      close_reason = new.close_reason,
      closed_by = new.closed_by,
      updated_at = new.updated_at,
      resolved_at = new.resolved_at,
      closed_at = new.closed_at
    where id = new.id
      and ticket_kind = 'work_order';
    return new;
  end if;

  return null;
end;
$$;

comment on function public.shadow_work_orders_new_to_tickets() is
  'Step 1c.3.5 reverse dual-write trigger (00220 + 00221 + 00223 + 00225). Loop prevention via pg_trigger_depth(). On native INSERT (legacy_ticket_id=NULL), creates tickets mirror then backfills legacy_ticket_id. Drops at phase 1c.10c.';

notify pgrst, 'reload schema';
