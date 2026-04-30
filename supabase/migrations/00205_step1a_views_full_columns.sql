-- Step 1a follow-up: 00204 created cases + work_orders views but missed
-- several tickets columns added by later migrations. Self-review against the
-- live schema flagged: assigned_vendor_id, reclassified_* (4 cols), close_*
-- (2 cols), requested_for_person_id, external_system, external_id,
-- module_number, linked_order_line_item_id.
--
-- Also reverting the parent_ticket_id → parent_case_id alias on work_orders.
-- A work_order's parent_ticket_id is conventionally a case but we can't
-- assert that from the schema, so don't rename. Renames land at step 1c
-- when columns are split for real.
--
-- Drops and recreates both views. Views are read-only and have no dependents
-- yet (introduced in 00204 minutes ago), so the drop is safe.

drop view if exists public.cases;
drop view if exists public.work_orders;

-- ── cases view (ticket_kind='case' subset) ────────────────────
create view public.cases as
select
  t.id,
  t.tenant_id,
  t.ticket_type_id,
  t.parent_ticket_id,
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
  t.requested_for_person_id,
  t.location_id,
  t.asset_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.assigned_vendor_id,
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
  t.module_number,
  t.external_system,
  t.external_id,
  t.linked_order_line_item_id,
  t.reclassified_at,
  t.reclassified_from_id,
  t.reclassified_reason,
  t.reclassified_by,
  t.close_reason,
  t.closed_by,
  t.created_at,
  t.updated_at,
  t.resolved_at,
  t.closed_at
from public.tickets t
where t.ticket_kind = 'case';

comment on view public.cases is
  'Step 1a (00204+00205) of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind = ''case''. Materialized into a real table at step 6.';

-- ── work_orders view (ticket_kind='work_order' subset) ───────
create view public.work_orders as
select
  t.id,
  t.tenant_id,
  t.ticket_type_id,
  t.parent_ticket_id,
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
  t.requested_for_person_id,
  t.location_id,
  t.asset_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.assigned_vendor_id,
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
  t.module_number,
  t.external_system,
  t.external_id,
  t.linked_order_line_item_id,
  t.reclassified_at,
  t.reclassified_from_id,
  t.reclassified_reason,
  t.reclassified_by,
  t.close_reason,
  t.closed_by,
  t.created_at,
  t.updated_at,
  t.resolved_at,
  t.closed_at
from public.tickets t
where t.ticket_kind = 'work_order';

comment on view public.work_orders is
  'Step 1a (00204+00205) of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind = ''work_order'', with derived parent_kind for the eventual polymorphic parent shape. Materialized into a real table at step 6.';

-- Re-apply revoke/grant (drop view dropped these too).
revoke select on public.cases from anon, authenticated;
revoke select on public.work_orders from anon, authenticated;
grant select on public.cases to service_role;
grant select on public.work_orders to service_role;

notify pgrst, 'reload schema';
