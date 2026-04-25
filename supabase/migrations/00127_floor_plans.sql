-- 00127_floor_plans.sql
-- Floor-level plan images for the spatial picker.
-- Per-room polygon defining shape on the floor's plan lives on spaces.floor_plan_polygon (00120).

create table if not exists public.floor_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_id uuid not null references public.spaces(id),    -- the floor space
  image_url text not null,
  width_px int not null,
  height_px int not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id)                                       -- one plan per floor; replace on re-upload
);

alter table public.floor_plans enable row level security;
drop policy if exists "tenant_isolation" on public.floor_plans;
create policy "tenant_isolation" on public.floor_plans
  using (tenant_id = public.current_tenant_id());

create trigger set_floor_plans_updated_at before update on public.floor_plans
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
