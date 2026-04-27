-- reservation_visitors: m:n junction between reservations and visitors.
--
-- A visitor record can attend multiple reservations on the same day; a
-- reservation can host multiple visitors. The existing `visitors` table
-- already carries (host_person_id, visit_date, site_id) and a status
-- machine — that stays the canonical "visitor" entity. This junction adds
-- the per-reservation link without changing visitor identity.
--
-- Tenant-scoped with RLS; per-row read goes through the reservation's
-- visibility predicate (a non-visible reservation must not leak its
-- visitor list).

create table public.reservation_visitors (
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  visitor_id     uuid not null references public.visitors(id)     on delete cascade,
  tenant_id      uuid not null references public.tenants(id),
  attached_at    timestamptz not null default now(),
  attached_by_user_id uuid references public.users(id),
  primary key (reservation_id, visitor_id)
);

alter table public.reservation_visitors enable row level security;

create policy "tenant_isolation" on public.reservation_visitors
  using (tenant_id = public.current_tenant_id());

create index idx_reservation_visitors_visitor on public.reservation_visitors (visitor_id);
create index idx_reservation_visitors_tenant on public.reservation_visitors (tenant_id);

comment on table public.reservation_visitors is
  'Junction table linking reservations to visitor records. Many-to-many: a visitor can attend multiple meetings on the same day; a reservation can host multiple visitors.';

notify pgrst, 'reload schema';
