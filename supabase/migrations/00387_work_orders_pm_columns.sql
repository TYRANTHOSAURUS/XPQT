-- Slice C — PM generator §3: work_orders PM columns.
--
-- Spec: ai/slice-c-plan.md §3 (lines 130-157).
--
-- Adds origin discriminator + provenance back-pointers to the plan and
-- the spawned asset, plus composite tenant FKs and the v2 idempotency
-- index that supports per-asset fan-out (v1 collapsed fan-out into a
-- single row because the key was (plan_id, planned_start_at)).
--
-- Citations:
--   - supabase/migrations/00386_maintenance_plans_schema.sql — provides
--     the (tenant_id, id) unique constraints on assets +
--     maintenance_plans this migration's composite FKs reference.

alter table public.work_orders
  add column origin text not null default 'reactive'
    check (origin in ('reactive','preventive','corrective')),
  add column maintenance_plan_id uuid,
  add column source_asset_id uuid;

comment on column public.work_orders.origin is
  'work order genesis: reactive (manual), preventive (PM generator), corrective (PM follow-up). Visibility: PM-generated rows are spawned with no requester/assignee/watcher; until dispatched, they are reachable to operators via the planning predicate `work_orders_planning_visible_for_actor` (00380/00385) and to admins via `tickets.read_all`. Standard `ticket_visibility_ids` returns nothing for unassigned PM rows by design — surface them on /desk/planning, not on requester portals.';
comment on column public.work_orders.maintenance_plan_id is
  'PM provenance — non-null for origin=preventive; FK to maintenance_plans (tenant-safe via composite)';
comment on column public.work_orders.source_asset_id is
  'PM fan-out provenance — which asset of an asset-type plan this WO covers';

alter table public.work_orders
  add constraint work_orders_pm_plan_tenant_fk
    foreign key (tenant_id, maintenance_plan_id)
    references public.maintenance_plans (tenant_id, id),
  add constraint work_orders_pm_asset_tenant_fk
    foreign key (tenant_id, source_asset_id)
    references public.assets (tenant_id, id);

create index idx_work_orders_pm_plan
  on public.work_orders (maintenance_plan_id)
  where maintenance_plan_id is not null;

create unique index uq_work_orders_pm_occurrence
  on public.work_orders (tenant_id, maintenance_plan_id, source_asset_id, planned_start_at)
  where maintenance_plan_id is not null;

notify pgrst, 'reload schema';
