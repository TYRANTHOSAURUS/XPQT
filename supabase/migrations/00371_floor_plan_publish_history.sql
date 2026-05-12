-- 00371_floor_plan_publish_history.sql
-- One snapshot per publish. Enables "Restore previous publish" admin action.
-- Retention: app-level prunes to last N=5 per floor (UI surfaces all of them).

create table if not exists public.floor_plan_publish_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  floor_space_id uuid not null references public.spaces(id),
  image_url text,
  width_px int,
  height_px int,
  labels jsonb not null default '[]'::jsonb,
  polygons jsonb not null default '[]'::jsonb,
  published_by uuid references public.users(id),
  published_at timestamptz not null default now()
);

alter table public.floor_plan_publish_history enable row level security;

-- READ-ONLY policy for authenticated users. INSERTs come from the security-definer
-- publish RPC, which bypasses RLS. No tenant role should write directly to history.
drop policy if exists "tenant_isolation" on public.floor_plan_publish_history;
create policy "tenant_isolation_read" on public.floor_plan_publish_history
  for select
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_floor_plan_publish_history_floor
  on public.floor_plan_publish_history (floor_space_id, published_at desc);

notify pgrst, 'reload schema';
