-- 00125_multi_room_groups.sql
-- Multi-room atomic bookings (rooms-only, no booking_bundle yet — that ships in sub-project 2).

create table if not exists public.multi_room_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  requester_person_id uuid not null references public.persons(id),
  primary_reservation_id uuid references public.reservations(id),
  created_at timestamptz not null default now()
);

alter table public.multi_room_groups enable row level security;
drop policy if exists "tenant_isolation" on public.multi_room_groups;
create policy "tenant_isolation" on public.multi_room_groups
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_multi_room_groups_tenant
  on public.multi_room_groups (tenant_id, created_at desc);

-- Add FK from reservations.multi_room_group_id (column exists from 00122)
alter table public.reservations
  drop constraint if exists reservations_multi_room_group_fk;
alter table public.reservations
  add constraint reservations_multi_room_group_fk
  foreign key (multi_room_group_id) references public.multi_room_groups(id);

notify pgrst, 'reload schema';
