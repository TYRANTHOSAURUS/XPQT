-- Step 1a follow-up: codex review fixes for 00204+00205.
--
-- Findings (in priority order):
--   1. (CRITICAL DATA INTEGRITY) Nothing prevents a work_order ticket from
--      having BOTH parent_ticket_id and booking_bundle_id, which would let
--      it appear under two different parents (a case AND a booking bundle).
--      The work_orders view's derived parent_kind would classify it as
--      'booking_bundle' while the rollup trigger from 00030 would still
--      update the parent case. Real bug latent in the data model.
--      Fix: add a check constraint enforcing at most one parent link, plus
--      a trigger ensuring parent_ticket_id (when set) points to a case.
--   2. (BUG) Views miss planned_start_at + planned_duration_minutes added
--      by 00206. Cases also missed booking_bundle_id (rare but possible).
--   3. (DEFENSE) Postgres simple views are AUTOMATICALLY UPDATABLE if
--      privileges allow. revoke from anon/authenticated handles end-user
--      writes, but service_role still has full access by default. Make the
--      read-only intent explicit with REVOKE INSERT/UPDATE/DELETE on the
--      views from service_role too.
--   4. (DOC) The "RLS inherited from tickets" comment is misleading —
--      Postgres views run with the view owner's privileges by default
--      (not security_invoker), so RLS is not transitively enforced.
--      The revoke posture mitigates this, but the comment overstates it.

-- ── 1. Critical: constrain work_order parentage ───────────────
-- A work_order can have AT MOST ONE of: parent_ticket_id (case-origin),
-- booking_bundle_id (booking-origin). Both NULL is also valid (orphan WO,
-- e.g. ad-hoc dispatch).
alter table public.tickets
  add constraint work_order_single_parent
  check (
    ticket_kind != 'work_order'
    or parent_ticket_id is null
    or booking_bundle_id is null
  );

comment on constraint work_order_single_parent on public.tickets is
  'Step 1a (00208): a work_order ticket can have at most one of parent_ticket_id (case-origin) or booking_bundle_id (booking-origin). Set neither for orphan WOs.';

-- A work_order's parent_ticket_id (when set) must reference a case, not
-- another work_order. Implemented as a trigger because check constraints
-- can't reference other rows.
create or replace function public.assert_work_order_parent_is_case()
returns trigger
language plpgsql
as $$
declare
  v_parent_kind text;
begin
  if new.ticket_kind = 'work_order' and new.parent_ticket_id is not null then
    select t.ticket_kind into v_parent_kind
      from public.tickets t
     where t.id = new.parent_ticket_id;
    if v_parent_kind is null then
      raise exception 'work_order %: parent_ticket_id % does not exist', new.id, new.parent_ticket_id;
    end if;
    if v_parent_kind != 'case' then
      raise exception 'work_order %: parent_ticket_id must reference a case (got ticket_kind=%)', new.id, v_parent_kind;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assert_wo_parent_is_case on public.tickets;
create trigger trg_assert_wo_parent_is_case
before insert or update of parent_ticket_id, ticket_kind on public.tickets
for each row execute function public.assert_work_order_parent_is_case();

comment on function public.assert_work_order_parent_is_case() is
  'Step 1a (00208): work_order.parent_ticket_id must reference a ticket_kind=case ticket. Prevents nested work-orders or work-orders parented to anything else.';

-- ── 2. Add missing columns to views ──────────────────────────
drop view if exists public.cases;
drop view if exists public.work_orders;

create view public.cases as
select
  t.id,
  t.tenant_id,
  t.ticket_type_id,
  t.parent_ticket_id,
  t.booking_bundle_id,                  -- new: rare on cases but exists on the table
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
  t.planned_start_at,                   -- new from 00206
  t.planned_duration_minutes,           -- new from 00206
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
  'Step 1a (00204+00205+00208) of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind=''case''. Direct API access is revoked; reads go through the service-role API which gates by entity visibility. RLS is NOT transitively enforced on views (Postgres uses view owner permissions by default, not security_invoker), so the revoke is the actual mitigation. Materialized into a real table at step 6.';

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
  t.planned_start_at,                   -- new from 00206
  t.planned_duration_minutes,           -- new from 00206
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
  'Step 1a (00204+00205+00208) of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind=''work_order''. Derived parent_kind exposes the eventual polymorphic shape — guarded at the data layer by the work_order_single_parent constraint (00208). Direct API access is revoked; reads go through the service-role API. Materialized into a real table at step 6.';

-- ── 3. Defense in depth: explicit read-only on views ─────────
-- Postgres simple views are auto-updatable; revoke writes from everyone.
-- Service role keeps SELECT only. INSERT/UPDATE/DELETE on the views would
-- cascade to tickets, which is never the intent.
revoke select on public.cases from anon, authenticated;
revoke select on public.work_orders from anon, authenticated;
revoke insert, update, delete on public.cases from anon, authenticated, service_role, public;
revoke insert, update, delete on public.work_orders from anon, authenticated, service_role, public;
grant select on public.cases to service_role;
grant select on public.work_orders to service_role;

notify pgrst, 'reload schema';
