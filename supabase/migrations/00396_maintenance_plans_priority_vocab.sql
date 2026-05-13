-- Slice C full-review C1 — align maintenance_plans.priority vocabulary
-- with the work_orders + tickets FE ecosystem.
--
-- Background: 00386 shipped priority CHECK in ('low','normal','high',
-- 'critical') with default 'normal'. The FE PriorityIcon component
-- (apps/web/src/components/desk/ticket-row-cells.tsx:32-38, 82-91)
-- registers icons for ('low','medium','high','critical','urgent') ONLY.
-- A PM WO spawned with priority='normal' falls through PRIORITY_ICON_MAP
-- and renders bare-label, breaking visual consistency.
--
-- Fix: drop + recreate CHECK to ('low','medium','high','critical',
-- 'urgent'); flip default to 'medium'; backfill any existing
-- priority='normal' rows to 'medium'. In practice the table only has
-- smoke/dev rows so the backfill is defensive.
--
-- Mirrors the FE convention in:
--   - apps/web/src/components/desk/create-ticket-dialog.tsx:248-251
--   - apps/web/src/components/desk/ticket-row-cells.tsx:82-91
--   - packages/shared/src/types/work-order-planning.ts:39

update public.maintenance_plans
   set priority = 'medium'
 where priority = 'normal';

alter table public.maintenance_plans
  drop constraint if exists maintenance_plans_priority_check;

alter table public.maintenance_plans
  alter column priority set default 'medium';

alter table public.maintenance_plans
  add constraint maintenance_plans_priority_check
    check (priority in ('low','medium','high','critical','urgent'));

comment on column public.maintenance_plans.priority is
  'WO priority for spawned work orders — aligned with FE PriorityIcon set (low/medium/high/critical/urgent)';

notify pgrst, 'reload schema';
