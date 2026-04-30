-- Step 1a of data-model-redesign-2026-04-30.md: introduce cases + work_orders
-- as filtered views over tickets, and migrate activities entity_kind to the
-- correct value based on tickets.ticket_kind.
--
-- This migration is purely additive. Reads from `cases` or `work_orders` are
-- equivalent to reading `tickets` filtered by ticket_kind. RLS is inherited
-- from the underlying tickets table (tenant_isolation). Writes still go to
-- tickets — the views are read-only in this phase.
--
-- Step 1b/c (future sessions) will:
--   - Switch fulfillment surfaces (daglijst, vendor portal, KDS, dispatch UI)
--     to read from work_orders.
--   - Add work_order_id / case_id columns alongside ticket_id on dependent
--     tables (sla_timers, routing_decisions, ticket_activities).
--   - Move dispatch / SLA / routing writes to use the appropriate surface.
--
-- Step 6 (last) materializes these views into real tables and drops the
-- ticket_kind column.
--
-- Why views, not shadow tables? Zero sync risk. A shadow table needs
-- insert/update/delete triggers and gets out of sync the moment any of those
-- triggers fails or is bypassed. A view is always perfectly consistent.

-- ── 1. cases view (ticket_kind='case' subset) ─────────────────
create view public.cases as
select
  t.id,
  t.tenant_id,
  t.ticket_type_id,
  t.parent_ticket_id, -- cases don't normally have parents but the column survives the bridge
  t.title,
  t.description,
  t.status,
  t.status_category,
  t.waiting_reason,
  t.interaction_mode,
  t.priority,
  t.impact,
  t.urgency,
  t.requester_person_id,
  t.location_id,
  t.asset_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.workflow_id,
  t.sla_id,
  t.source_channel,
  t.tags,
  t.watchers,
  t.cost,
  t.satisfaction_rating,
  t.satisfaction_comment,
  t.form_data,
  t.sla_response_due_at,
  t.sla_resolution_due_at,
  t.sla_response_breached_at,
  t.sla_resolution_breached_at,
  t.sla_at_risk,
  t.sla_paused,
  t.sla_paused_at,
  t.sla_total_paused_minutes,
  t.created_at,
  t.updated_at,
  t.resolved_at,
  t.closed_at
from public.tickets t
where t.ticket_kind = 'case';

comment on view public.cases is
  'Step 1a of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind = ''case''. Materialized into a real table at step 6.';

-- ── 2. work_orders view (ticket_kind='work_order' subset) ────
create view public.work_orders as
select
  t.id,
  t.tenant_id,
  t.ticket_type_id,
  -- Polymorphic parent: a work_order is parented EITHER by a case (via
  -- parent_ticket_id) OR by a booking_bundle. We expose both columns and a
  -- derived parent_kind discriminator. Future: replace with single
  -- (parent_kind, parent_id) when the parent_ticket_id column is dropped at
  -- step 6.
  t.parent_ticket_id as parent_case_id,
  t.booking_bundle_id,
  case
    when t.booking_bundle_id is not null then 'booking_bundle'
    when t.parent_ticket_id is not null then 'case'
    else null
  end as parent_kind,
  t.title,
  t.description,
  t.status,
  t.status_category,
  t.waiting_reason,
  t.interaction_mode,
  t.priority,
  t.impact,
  t.urgency,
  t.requester_person_id,
  t.location_id,
  t.asset_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.workflow_id,
  t.sla_id,
  t.source_channel,
  t.tags,
  t.watchers,
  t.cost,
  t.satisfaction_rating,
  t.satisfaction_comment,
  t.form_data,
  t.sla_response_due_at,
  t.sla_resolution_due_at,
  t.sla_response_breached_at,
  t.sla_resolution_breached_at,
  t.sla_at_risk,
  t.sla_paused,
  t.sla_paused_at,
  t.sla_total_paused_minutes,
  t.created_at,
  t.updated_at,
  t.resolved_at,
  t.closed_at
from public.tickets t
where t.ticket_kind = 'work_order';

comment on view public.work_orders is
  'Step 1a of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind = ''work_order'', with derived parent_kind/parent_case_id for the eventual polymorphic parent shape. Materialized into a real table at step 6.';

-- ── 3. Lock down direct PostgREST access to the views ────────
-- Same posture as activities: API gates by entity visibility; direct table
-- access bypasses that. Service role retains full access via default.
revoke select on public.cases from anon, authenticated;
revoke select on public.work_orders from anon, authenticated;
grant select on public.cases to service_role;
grant select on public.work_orders to service_role;

-- ── 4. Migrate existing activities entity_kind ───────────────
-- Today's activities table has entity_kind='ticket' (transitional umbrella).
-- Now that we have cases + work_orders, refine those rows to the precise kind
-- based on the corresponding ticket.ticket_kind. Rows where the source ticket
-- has been deleted stay 'ticket' (data is stale anyway and will be cleaned
-- up by future audits).
update public.activities a
set entity_kind = case t.ticket_kind
  when 'work_order' then 'work_order'
  else 'case'
end
from public.tickets t
where a.entity_kind = 'ticket'
  and a.source_table = 'ticket_activities'
  and t.id = a.entity_id;

-- ── 5. Update insert shadow trigger to write the right kind ──
-- Replace the function body so new ticket_activities inserts shadow with
-- entity_kind='case' or entity_kind='work_order' instead of 'ticket'.
create or replace function public.shadow_ticket_activity_to_activities()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select case t.ticket_kind
    when 'work_order' then 'work_order'
    else 'case'
  end into v_kind
  from public.tickets t
  where t.id = new.ticket_id;

  -- If the ticket is gone (shouldn't happen with FK + cascade, but guard
  -- defensively), fall back to the transitional umbrella value.
  v_kind := coalesce(v_kind, 'ticket');

  insert into public.activities (
    tenant_id,
    entity_kind,
    entity_id,
    activity_type,
    author_person_id,
    visibility,
    content,
    attachments,
    metadata,
    source_table,
    source_id,
    created_at
  ) values (
    new.tenant_id,
    v_kind,
    new.ticket_id,
    new.activity_type,
    new.author_person_id,
    new.visibility,
    new.content,
    coalesce(new.attachments, '[]'::jsonb),
    new.metadata,
    'ticket_activities',
    new.id,
    new.created_at
  )
  on conflict (source_table, source_id) where source_id is not null do nothing;
  return new;
end;
$$;

comment on function public.shadow_ticket_activity_to_activities() is
  'Step 1a: writes entity_kind=''case'' or ''work_order'' based on tickets.ticket_kind. Drops in step 1c when service-layer code writes to activities directly.';

notify pgrst, 'reload schema';
