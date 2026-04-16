-- Reservations: rooms, desks, spaces — with recurring support

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  reservation_type text not null default 'room' check (reservation_type in ('room', 'desk', 'parking', 'other')),
  space_id uuid not null references public.spaces(id),
  requester_person_id uuid not null references public.persons(id),
  host_person_id uuid references public.persons(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  attendee_count integer,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'cancelled', 'completed')),
  recurrence_rule jsonb, -- {frequency, interval, count, until, days_of_week}
  recurrence_series_id uuid, -- groups recurring instances
  linked_order_id uuid references public.orders(id),
  approval_id uuid references public.approvals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reservations enable row level security;
create policy "tenant_isolation" on public.reservations
  using (tenant_id = public.current_tenant_id());

create index idx_reservations_tenant on public.reservations (tenant_id);
create index idx_reservations_space_time on public.reservations (space_id, start_at, end_at) where status != 'cancelled';
create index idx_reservations_requester on public.reservations (requester_person_id);
create index idx_reservations_series on public.reservations (recurrence_series_id) where recurrence_series_id is not null;

create trigger set_reservations_updated_at before update on public.reservations
  for each row execute function public.set_updated_at();

-- Add FK from orders to reservations
alter table public.orders
  add constraint fk_orders_reservation
  foreign key (linked_reservation_id)
  references public.reservations(id);
