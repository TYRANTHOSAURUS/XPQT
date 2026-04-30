-- Step 1c.3.6 of docs/data-model-step1c-plan.md: atomic swap from
-- public.work_orders VIEW (filtered tickets) to public.work_orders TABLE
-- (the materialized work_orders_new).
--
-- After this migration, the name `public.work_orders` resolves to a real
-- table whose columns match the prior view 1:1 plus `legacy_ticket_id`.
-- Readers that referenced the view continue to work because the column
-- names are preserved.
--
-- Sequence (single transaction for atomicity):
--   1. Drop dependent views (fulfillment_units_v, booking_bundle_status_v)
--   2. Drop public.work_orders view
--   3. Rename public.work_orders_new → public.work_orders
--   4. Update trigger functions to reference public.work_orders
--   5. Update divergence view to reference public.work_orders
--   6. Recreate fulfillment_units_v
--   7. Recreate booking_bundle_status_v
--   8. Re-apply revoke/grant posture
--
-- Stress-tested before this migration: 12 forward + 5 reverse scenarios
-- pass with zero divergence.

begin;

-- ── 1. Drop dependents ────────────────────────────────────────
drop view if exists public.fulfillment_units_v;
drop view if exists public.booking_bundle_status_v;

-- ── 2. Drop the existing work_orders view ────────────────────
drop view if exists public.work_orders;

-- ── 3. Rename the materialized table to claim the canonical name ──
alter table public.work_orders_new rename to work_orders;

-- The constraint + index names retain their `work_orders_new_*` prefix
-- for now; renamed at step 6 with the table-rename. Functionally
-- correct; cosmetic for later.

-- ── 4. Update forward trigger function to reference public.work_orders ──
create or replace function public.shadow_ticket_to_work_orders_new()
returns trigger
language plpgsql
as $$
begin
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

-- ── 5. Update divergence view ────────────────────────────────
create or replace view public.work_orders_dual_write_divergence_v as
with
counts as (
  select 'counts_mismatch' as kind,
         abs(
           (select count(*) from public.tickets where ticket_kind = 'work_order')
           - (select count(*) from public.work_orders where legacy_ticket_id is not null)
         ) as divergence_count
),
only_in_tickets as (
  select 'only_in_tickets' as kind,
         count(*) as divergence_count
  from public.tickets t
  where t.ticket_kind = 'work_order'
    and not exists (
      select 1 from public.work_orders won
       where won.legacy_ticket_id = t.id
    )
),
only_in_won as (
  select 'only_in_won' as kind,
         count(*) as divergence_count
  from public.work_orders won
  where won.legacy_ticket_id is not null
    and not exists (
      select 1 from public.tickets t
       where t.id = won.legacy_ticket_id
         and t.ticket_kind = 'work_order'
    )
),
won_missing_legacy as (
  select 'won_missing_legacy' as kind,
         count(*) as divergence_count
  from public.work_orders won
  where won.legacy_ticket_id is null
)
select * from counts
union all
select * from only_in_tickets
union all
select * from only_in_won
union all
select * from won_missing_legacy;

revoke all on public.work_orders_dual_write_divergence_v from anon, authenticated, public;
grant select on public.work_orders_dual_write_divergence_v to service_role;

-- ── 6. Recreate fulfillment_units_v (same shape as 00209) ────
create view public.fulfillment_units_v as
select
  'service_line'::text as source_kind,
  oli.id as source_id,
  oli.tenant_id,
  oli.vendor_id,
  oli.fulfillment_team_id as assigned_team_id,
  null::uuid as assigned_user_id,
  ord.delivery_location_id as location_id,
  ord.booking_bundle_id,
  oli.service_window_end_at as due_at,
  oli.fulfillment_status as status,
  case oli.fulfillment_status
    when 'cancelled' then 'cancelled'
    when 'delivered' then 'done'
    else 'open'
  end as status_bucket,
  coalesce(ci.name, 'Service line') ||
    case when oli.quantity is not null then ' × ' || oli.quantity::text else '' end
    as summary,
  ord.id as parent_order_id,
  null::uuid as parent_ticket_id,
  oli.created_at,
  oli.updated_at,
  case
    when oli.service_window_end_at is null then false
    when oli.fulfillment_status in ('delivered', 'cancelled') then false
    else oli.service_window_end_at < now()
  end as is_late
from public.order_line_items oli
join public.orders ord on ord.id = oli.order_id and ord.tenant_id = oli.tenant_id
left join public.catalog_items ci on ci.id = oli.catalog_item_id and ci.tenant_id = oli.tenant_id

union all

select
  'work_order'::text as source_kind,
  t.id as source_id,
  t.tenant_id,
  t.assigned_vendor_id as vendor_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.location_id,
  t.booking_bundle_id,
  t.sla_resolution_due_at as due_at,
  t.status_category as status,
  case t.status_category
    when 'closed' then 'done'
    when 'resolved' then 'done'
    else 'open'
  end as status_bucket,
  t.title as summary,
  null::uuid as parent_order_id,
  t.parent_ticket_id,
  t.created_at,
  t.updated_at,
  case
    when t.sla_resolution_due_at is null then false
    when t.status_category in ('resolved', 'closed') then false
    when coalesce(t.sla_paused, false) then false
    else t.sla_resolution_due_at < now()
  end as is_late
from public.work_orders t;

comment on view public.fulfillment_units_v is
  'Cross-root read model. Step 1c.3.6 (00222): work-order half now sources from the materialized public.work_orders TABLE (no longer the view).';

revoke all on public.fulfillment_units_v from anon, authenticated, public, service_role;
grant select on public.fulfillment_units_v to service_role;

-- ── 7. Recreate booking_bundle_status_v (same shape as 00210) ─
create view public.booking_bundle_status_v as
with bundle_reservations as (
  select b.id as bundle_id,
         array_agg(r.status) filter (where r.id is not null) as reservation_statuses
  from public.booking_bundles b
  left join public.reservations r on r.booking_bundle_id = b.id
  group by b.id
),
bundle_orders as (
  select b.id as bundle_id,
         array_agg(o.status) filter (where o.id is not null) as order_statuses
  from public.booking_bundles b
  left join public.orders o on o.booking_bundle_id = b.id
  group by b.id
),
bundle_tickets as (
  select b.id as bundle_id,
         array_agg(t.status_category) filter (where t.id is not null) as ticket_statuses
  from public.booking_bundles b
  left join public.work_orders t on t.booking_bundle_id = b.id
  group by b.id
)
select b.id as bundle_id,
       b.tenant_id,
       case
         when (
           coalesce(array_length(br.reservation_statuses, 1), 0) +
           coalesce(array_length(bo.order_statuses, 1), 0) +
           coalesce(array_length(bt.ticket_statuses, 1), 0)
         ) = 0 then 'pending'
         when 'pending_approval' = any(coalesce(br.reservation_statuses, '{}')) or
              'submitted' = any(coalesce(bo.order_statuses, '{}'))
           then 'pending_approval'
         when (br.reservation_statuses is null or br.reservation_statuses <@ array['cancelled','released']) and
              (bo.order_statuses is null or bo.order_statuses <@ array['cancelled','fulfilled']) and
              (bt.ticket_statuses is null or bt.ticket_statuses <@ array['closed','resolved'])
           then case
                  when 'fulfilled' = any(coalesce(bo.order_statuses, '{}'))
                    or 'released' = any(coalesce(br.reservation_statuses, '{}'))
                    or (bt.ticket_statuses is not null
                        and array_length(bt.ticket_statuses, 1) > 0)
                  then 'partially_cancelled'
                  else 'cancelled'
                end
         when 'cancelled' = any(coalesce(br.reservation_statuses, '{}')) or
              'cancelled' = any(coalesce(bo.order_statuses, '{}'))
           then 'partially_cancelled'
         when bt.ticket_statuses is not null
              and exists (
                select 1
                from unnest(bt.ticket_statuses) as st(s)
                where st.s not in ('closed', 'resolved')
              )
              and (
                'cancelled' = any(coalesce(br.reservation_statuses, '{}'))
                or 'released' = any(coalesce(br.reservation_statuses, '{}'))
                or 'cancelled' = any(coalesce(bo.order_statuses, '{}'))
                or 'fulfilled' = any(coalesce(bo.order_statuses, '{}'))
              )
           then 'partially_cancelled'
         else 'confirmed'
       end as status_rollup,
       br.reservation_statuses,
       bo.order_statuses,
       bt.ticket_statuses
from public.booking_bundles b
left join bundle_reservations br on br.bundle_id = b.id
left join bundle_orders bo on bo.bundle_id = b.id
left join bundle_tickets bt on bt.bundle_id = b.id;

comment on view public.booking_bundle_status_v is
  'Bundle status rollup. Step 1c.3.6 (00222): work-order half sources from materialized public.work_orders TABLE.';

-- ── 8. Re-apply revoke/grant posture on the renamed table ────
revoke all on public.work_orders from anon, authenticated, public;
grant select on public.work_orders to service_role;
revoke truncate, references, trigger on public.work_orders from service_role;
-- service_role gets SELECT only during 1c.3.6 (still pre-1c.4 writer flip).

-- The reverse trigger on the renamed table: the trigger's name still
-- includes "_new" because the trigger metadata follows the table; rename
-- doesn't break it. Confirm by listing triggers.

commit;

notify pgrst, 'reload schema';
