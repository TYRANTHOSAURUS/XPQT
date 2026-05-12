-- 00369_floor_plans_and_drafts_labels.sql
-- Non-polygon annotations placed on the canvas (e.g. "Lounge", "Reception").
-- Shape: [{ "text": "Lounge", "x": 690, "y": 250, "size": 11 }]. Spec §5.6.

alter table public.floor_plans
  add column if not exists labels jsonb not null default '[]'::jsonb,
  add constraint floor_plans_labels_is_array
    check (jsonb_typeof(labels) = 'array');

alter table public.floor_plan_drafts
  add column if not exists labels jsonb not null default '[]'::jsonb,
  add constraint floor_plan_drafts_labels_is_array
    check (jsonb_typeof(labels) = 'array');

notify pgrst, 'reload schema';
