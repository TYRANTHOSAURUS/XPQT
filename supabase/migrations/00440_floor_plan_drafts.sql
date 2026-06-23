-- 00440_floor_plan_drafts.sql
-- Per-floor in-progress edits. One draft per floor. Polygons stored as jsonb
-- so the booking surface keeps reading the published spaces.floor_plan_polygon
-- without ever seeing half-edited state. Spec §3.3.
--
-- Renumbered from 00416 (2026-06-23) to resolve a duplicate-prefix
-- collision with 00416_set_entity_assignment_v3.sql that broke the CI
-- db:reset migration smoke. Already applied on the remote prod DB
-- under the old prefix; idempotency guards below make this file safe
-- on a fresh local stack.

create table if not exists public.floor_plan_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  floor_space_id uuid not null references public.spaces(id),
  image_url text,
  width_px int,
  height_px int,
  polygons jsonb not null default '[]'::jsonb,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (floor_space_id),
  check (jsonb_typeof(polygons) = 'array')
);

alter table public.floor_plan_drafts enable row level security;

drop policy if exists "tenant_isolation" on public.floor_plan_drafts;
create policy "tenant_isolation" on public.floor_plan_drafts
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create index if not exists idx_floor_plan_drafts_tenant
  on public.floor_plan_drafts (tenant_id);

drop trigger if exists set_floor_plan_drafts_updated_at on public.floor_plan_drafts;
create trigger set_floor_plan_drafts_updated_at
  before update on public.floor_plan_drafts
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
