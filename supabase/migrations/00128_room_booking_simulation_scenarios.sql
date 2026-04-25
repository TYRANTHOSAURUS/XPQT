-- 00128_room_booking_simulation_scenarios.sql
-- Saved scenarios for the admin rule editor's "Test against scenario" workflow.

create table if not exists public.room_booking_simulation_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  scenario jsonb not null,                          -- requester_id + space_id + time + criteria
  last_run_at timestamptz,
  last_run_result jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id)
);

alter table public.room_booking_simulation_scenarios enable row level security;
drop policy if exists "tenant_isolation" on public.room_booking_simulation_scenarios;
create policy "tenant_isolation" on public.room_booking_simulation_scenarios
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_room_booking_simulation_scenarios_tenant
  on public.room_booking_simulation_scenarios (tenant_id, created_at desc);

notify pgrst, 'reload schema';
