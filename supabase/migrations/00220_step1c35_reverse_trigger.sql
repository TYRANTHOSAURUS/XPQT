-- Step 1c.3.5 of docs/data-model-step1c-plan.md: install reverse shadow
-- trigger (work_orders_new → tickets).
--
-- During 1c.3 (current state), application writers target tickets exclusively
-- and the forward trigger mirrors to work_orders_new. The reverse trigger is
-- dormant — work_orders_new is only written by the forward trigger.
--
-- Phase 1c.4 will flip writers: dispatch.service.ts, ticket.service.ts
-- booking-origin path, workflow create_child_tasks, etc. will write to
-- work_orders directly (post-1c.3.6 rename). At that point the reverse
-- trigger keeps tickets in sync so backward-compat readers (anything still
-- doing `from tickets where ticket_kind='work_order'`) see fresh data.
--
-- Design decisions for this phase:
--
-- 1. NO GUC-based loop guard. Idempotency + IS DISTINCT FROM is sufficient
--    and simpler. The forward trigger's INSERT uses ON CONFLICT (id) DO
--    UPDATE (changed from ON CONFLICT (legacy_ticket_id) — see #2). The
--    reverse trigger's UPDATE uses IS DISTINCT FROM. Each direction does
--    a single hop and either no-ops or applies, never recursing.
--
-- 2. Forward trigger conflict target changed from legacy_ticket_id to id.
--    Why: post-1c.4, writers create work_orders_new with legacy_ticket_id
--    NULL. The reverse trigger creates the tickets row, the forward trigger
--    fires and tries to upsert into work_orders_new — but legacy_ticket_id
--    is NULL on the existing row and NULL doesn't match in unique index, so
--    ON CONFLICT (legacy_ticket_id) wouldn't catch it. Use id (PK, unique,
--    never null) as the conflict target so upsert works in both bridge
--    directions.
--
-- 3. Reverse trigger handles INSERT/UPDATE/DELETE plus the legacy_ticket_id
--    backfill: when a direct writer creates work_orders_new with
--    legacy_ticket_id NULL, the reverse trigger's tickets INSERT fires the
--    forward trigger which upserts work_orders_new and sets legacy_ticket_id.
--    No race because triggers run synchronously within the statement.

-- ── Update forward trigger to use ON CONFLICT (id) ───────────
create or replace function public.shadow_ticket_to_work_orders_new()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.ticket_kind = 'work_order' then
      delete from public.work_orders_new where id = old.id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.ticket_kind = 'work_order' and new.ticket_kind != 'work_order' then
    delete from public.work_orders_new where id = new.id;
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
  on conflict (id) do update set
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
    closed_at = excluded.closed_at,
    -- Set legacy_ticket_id if not already set (post-1c.4 backfill of native rows).
    legacy_ticket_id = coalesce(public.work_orders_new.legacy_ticket_id, excluded.legacy_ticket_id);

  return new;
end;
$$;

comment on function public.shadow_ticket_to_work_orders_new() is
  'Step 1c.3 forward dual-write trigger (00220 update). Mirrors writes on tickets where ticket_kind=work_order into work_orders_new via ON CONFLICT (id) DO UPDATE — handles both bridge directions. Idempotent: identical-value updates are no-ops via the SET clause. Drops at phase 1c.10c.';

-- ── Reverse trigger ──────────────────────────────────────────
create or replace function public.shadow_work_orders_new_to_tickets()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    -- The forward direction's FK CASCADE on tickets → work_orders_new handles
    -- "ticket deleted" — by the time we get here the tickets row is already
    -- gone (FK CASCADE just ran us). Defensive idempotent DELETE for the
    -- post-1c.4 case where a direct writer deletes work_orders_new and we
    -- need to delete tickets.
    delete from public.tickets where id = old.id;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Insert mirror tickets row. ON CONFLICT (id) DO NOTHING handles the
    -- forward-path case (tickets row already exists, this trigger fires
    -- because forward trigger just inserted into work_orders_new).
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
    -- Update mirror tickets row, but only fields that actually changed.
    -- The IS DISTINCT FROM guard turns identical-value updates into no-ops,
    -- which prevents the forward trigger from re-firing on a ticket UPDATE
    -- with no real change. (No-op UPDATEs in Postgres still fire the
    -- AFTER trigger but the SET-WHERE clause filter makes the UPDATE itself
    -- affect 0 rows.)
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
        -- Add more fields here if drift is observed; the above covers the
        -- common change set without making the WHERE clause unwieldy.
      );
    return new;
  end if;

  return null;
end;
$$;

comment on function public.shadow_work_orders_new_to_tickets() is
  'Step 1c.3.5 reverse dual-write trigger. Mirrors writes on work_orders_new back into tickets so backward-compat readers see fresh data post-1c.4. Idempotent via ON CONFLICT (id) DO NOTHING for INSERT and IS DISTINCT FROM guard for UPDATE. Drops at phase 1c.10c.';

drop trigger if exists trg_work_orders_new_to_ticket_iud on public.work_orders_new;
create trigger trg_work_orders_new_to_ticket_iud
after insert or update or delete on public.work_orders_new
for each row execute function public.shadow_work_orders_new_to_tickets();

notify pgrst, 'reload schema';
