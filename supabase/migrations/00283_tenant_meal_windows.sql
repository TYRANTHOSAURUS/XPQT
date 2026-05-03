-- 00283_tenant_meal_windows.sql
--
-- Tenant-configurable meal windows. Drives the create-booking modal's
-- "Suggested" chip on the catering add-in card when the picked time
-- spans a configured window (default lunch + dinner). The redesign
-- spec is at docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md.
--
-- Read-side only: the API exposes GET /tenants/current/meal-windows.
-- Writes (admin UI) come in a follow-up; for v1 the seed defaults are
-- enough.
--
-- Idempotent. Safe to re-apply.

create table if not exists public.tenant_meal_windows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  label text not null check (length(label) between 1 and 64),
  -- Local time (no timezone). The client compares against the booking's
  -- local hours to avoid TZ drift between tenants in different regions.
  start_time time not null,
  end_time time not null check (end_time > start_time),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, label)
);

create index if not exists tenant_meal_windows_tenant_active_idx
  on public.tenant_meal_windows(tenant_id) where active;

alter table public.tenant_meal_windows enable row level security;

-- Read: anyone authenticated in the tenant. Write: service_role only
-- (admin UI proxies via the API). RLS resolves tenant_id from the JWT
-- via public.current_tenant_id() (see 00002_rls_helpers.sql).
drop policy if exists tenant_meal_windows_read on public.tenant_meal_windows;
create policy tenant_meal_windows_read
  on public.tenant_meal_windows
  for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all on public.tenant_meal_windows from anon, authenticated, public;
grant select on public.tenant_meal_windows to authenticated;
grant select, insert, update, delete on public.tenant_meal_windows to service_role;

-- Seed defaults for every existing tenant: lunch 11:30–13:30, dinner
-- 17:00–19:00. New tenants get the same via the trigger below.
insert into public.tenant_meal_windows(tenant_id, label, start_time, end_time)
select t.id, 'Lunch', '11:30'::time, '13:30'::time
from public.tenants t
on conflict (tenant_id, label) do nothing;

insert into public.tenant_meal_windows(tenant_id, label, start_time, end_time)
select t.id, 'Dinner', '17:00'::time, '19:00'::time
from public.tenants t
on conflict (tenant_id, label) do nothing;

create or replace function public.seed_default_meal_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_meal_windows(tenant_id, label, start_time, end_time)
  values
    (new.id, 'Lunch', '11:30'::time, '13:30'::time),
    (new.id, 'Dinner', '17:00'::time, '19:00'::time)
  on conflict (tenant_id, label) do nothing;
  return new;
end
$$;

drop trigger if exists tenants_seed_meal_windows on public.tenants;
create trigger tenants_seed_meal_windows
  after insert on public.tenants
  for each row execute function public.seed_default_meal_windows();

notify pgrst, 'reload schema';
