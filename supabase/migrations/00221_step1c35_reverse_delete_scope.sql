-- Step 1c.3.5 follow-up: scope reverse-trigger DELETE to ticket_kind='work_order'.
--
-- Stress-test S6 (case→wo promote after demote) caught a bug introduced
-- by 00220's reverse trigger:
--
-- Sequence: ticket starts as wo. UPDATE ticket_kind='case'. Then UPDATE
-- ticket_kind='work_order' to re-promote.
--
-- 1. UPDATE tickets SET ticket_kind='case' WHERE id=X
-- 2. Forward trigger fires: deletes work_orders_new row (demote)
-- 3. Reverse trigger fires on work_orders_new DELETE: DELETE FROM tickets
--    WHERE id=X. Ticket still exists as 'case', but the DELETE deletes it.
-- 4. Subsequent UPDATE to re-promote fails because the ticket is gone.
--
-- Fix: scope the reverse-trigger DELETE to only fire when the source ticket
-- still exists AS WORK_ORDER. This handles all three legitimate cases:
--
--   A. Direct app DELETE on work_orders_new (post-1c.4):
--      tickets row exists with ticket_kind='work_order' → DELETE propagates.
--   B. FK CASCADE from tickets DELETE:
--      tickets row already gone → DELETE finds 0 rows → no-op.
--   C. Forward trigger DELETE on demote (case→wo→case):
--      tickets row exists with ticket_kind='case' → ticket_kind filter
--      excludes it → no-op. CORRECT (ticket should keep existing as case).

create or replace function public.shadow_work_orders_new_to_tickets()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- Only delete the source ticket if it still exists as work_order.
    -- See migration header for the three cases this distinguishes.
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
      and ticket_kind = 'work_order'  -- defense: only update if still work_order
      and (
        tenant_id is distinct from new.tenant_id
        or ticket_type_id is distinct from new.ticket_type_id
        or parent_ticket_id is distinct from new.parent_ticket_id
        or booking_bundle_id is distinct from new.booking_bundle_id
        or title is distinct from new.title
        or description is distinct from new.description
        or status is distinct from new.status
        or status_category is distinct from new.status_category
        or assigned_team_id is distinct from new.assigned_team_id
        or assigned_user_id is distinct from new.assigned_user_id
        or assigned_vendor_id is distinct from new.assigned_vendor_id
        or sla_at_risk is distinct from new.sla_at_risk
        or sla_paused is distinct from new.sla_paused
        or close_reason is distinct from new.close_reason
        or closed_at is distinct from new.closed_at
        or resolved_at is distinct from new.resolved_at
        or updated_at is distinct from new.updated_at
      );
    return new;
  end if;

  return null;
end;
$$;

comment on function public.shadow_work_orders_new_to_tickets() is
  'Step 1c.3.5 reverse dual-write trigger (00220 + 00221). DELETE branch scoped to ticket_kind=work_order so demote-driven shadow deletes do not delete the source ticket. Idempotent via ON CONFLICT (id) DO NOTHING for INSERT and IS DISTINCT FROM + ticket_kind=work_order guard for UPDATE. Drops at phase 1c.10c.';

notify pgrst, 'reload schema';
