-- Step 1c.3.5/3.6 post-full-review fixes — TWO 1c.4 timebombs.
--
-- C1 (CRITICAL) — IS DISTINCT FROM is incomplete.
--
-- The reverse trigger's UPDATE WHERE clause checked only ~17 of the 55
-- mirrorable columns (00221:128-145). Post-1c.4, a writer that updates
-- ANY unguarded column (tags, watchers, cost, priority, impact, urgency,
-- form_data, requester_person_id, module_number, external_*, sla_paused_at,
-- reclassified_*, etc.) would no-op the reverse mirror — the change
-- silently fails to propagate to tickets. Divergence.
--
-- The fix is NOT to enumerate all 55 columns — the maintenance cost is
-- punishing and the comment "add more fields here if drift is observed"
-- is wishful (drift won't be observed; the divergence view checks
-- existence + counts, not column equality).
--
-- The fix is to switch loop prevention from value-based (IS DISTINCT FROM)
-- to depth-based (pg_trigger_depth()). Both triggers skip when called at
-- depth > 1 — i.e. when invoked nested inside another trigger. The first
-- trigger to fire (depth=1) does the work; the second invocation (depth=2)
-- short-circuits.
--
-- The original codex concern about pg_trigger_depth (would skip legitimate
-- workflow-nested writes) was investigated against this codebase: the only
-- trigger that writes tickets is 00030's rollup_parent_status_trg, and it
-- writes a CASE row (not a work_order), so the forward trigger's existing
-- ticket_kind filter already short-circuits it. Adding the depth guard is
-- safe.
--
-- C2 (CRITICAL) — module_number allocator only on tickets.
--
-- 00139's tickets_assign_module_number_trg is BEFORE INSERT on tickets and
-- assigns module_number per (tenant_id, ticket_kind). Post-1c.4, a writer
-- that INSERTs directly into work_orders has module_number=NULL — there's
-- no equivalent trigger on work_orders. Today, the chain self-heals because
-- the reverse trigger calls INSERT on tickets which triggers the allocator,
-- and the forward trigger upserts the allocated number back. But that's
-- fragile: if 1c.10 ever disables the dual-write triggers before adding a
-- direct allocator, work_orders rows get permanently NULL module_number.
--
-- Add a direct allocator on work_orders. Use the same allocate_module_number
-- function from 00139 with kind='work_order' (the WO discriminator).

-- ── 1. Forward trigger: depth-based loop guard, NO value guard ──
create or replace function public.shadow_ticket_to_work_orders_new()
returns trigger
language plpgsql
as $$
begin
  -- Loop guard: skip if invoked nested inside another trigger.
  -- The first writer (forward direction = app writes tickets) runs at
  -- depth=1; the reverse trigger then fires at depth=2 and skips.
  -- Conversely the reverse direction = app writes work_orders runs reverse
  -- at depth=1, forward at depth=2 (skips here).
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.ticket_kind = 'work_order' then
      delete from public.work_orders where id = old.id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.ticket_kind = 'work_order' and new.ticket_kind != 'work_order' then
    delete from public.work_orders where id = new.id;
    return new;
  end if;

  if new.ticket_kind != 'work_order' then
    return new;
  end if;

  insert into public.work_orders (
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
    legacy_ticket_id = coalesce(public.work_orders.legacy_ticket_id, excluded.legacy_ticket_id);

  return new;
end;
$$;

-- ── 2. Reverse trigger: depth guard, drop column-list IS DISTINCT FROM ──
-- The column-list guard at 00221 was incomplete (~17/55 columns). Replace
-- with depth guard which protects against ping-pong without per-column
-- enumeration. The ticket_kind='work_order' WHERE clause stays as
-- defense-in-depth for the demote-DELETE case.
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
  'Step 1c.3.5 reverse dual-write trigger (00220 + 00221 + 00223). Loop prevention via pg_trigger_depth() > 1 (depth-based). DELETE branch scoped to ticket_kind=work_order. UPDATE branch propagates ALL columns unconditionally (loop prevention is depth-based, no per-column guard needed). Drops at phase 1c.10c.';

comment on function public.shadow_ticket_to_work_orders_new() is
  'Step 1c.3 forward dual-write trigger (00220 + 00222 + 00223). Loop prevention via pg_trigger_depth() > 1. Drops at phase 1c.10c.';

-- ── 3. Module-number allocator on work_orders (C2 fix) ───────
-- Replicate 00139's tickets_assign_module_number_trg pattern on
-- work_orders. The existing function `allocate_module_number(tenant_id,
-- module_prefix)` from 00139 takes a textual prefix. work_order rows
-- pass 'WO'.
create or replace function public.work_orders_assign_module_number()
returns trigger
language plpgsql
as $$
begin
  -- If the writer already provided a module_number (e.g. via the dual-write
  -- forward trigger), keep it. Only allocate when null.
  if new.module_number is null then
    new.module_number := public.allocate_module_number(new.tenant_id, 'WO');
  end if;
  return new;
end;
$$;

comment on function public.work_orders_assign_module_number() is
  'Step 1c.3.5 (00223) — module_number allocator for direct work_orders writes. Mirrors the 00139 tickets allocator. Required for phase 1c.4 when writers cut over to work_orders.';

drop trigger if exists work_orders_assign_module_number_trg on public.work_orders;
create trigger work_orders_assign_module_number_trg
before insert on public.work_orders
for each row execute function public.work_orders_assign_module_number();

-- Also: tickets unique on (tenant_id, ticket_kind, module_number) — the
-- work_orders unique on (tenant_id, module_number) (00217) already enforces
-- single-kind uniqueness. Cross-table uniqueness is implicit because tickets
-- only contains cases post-1c.10c, and work_orders only contains WOs.
-- During the bridge, a WO module_number exists in both tables but for the
-- SAME row (legacy_ticket_id linkage), so cross-table same-number on
-- different-row is impossible.

notify pgrst, 'reload schema';
