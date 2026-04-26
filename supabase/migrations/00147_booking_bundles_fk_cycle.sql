-- 00147_booking_bundles_fk_cycle.sql
-- The two tables FK-reference each other:
--   booking_bundles.primary_reservation_id → reservations.id
--   reservations.booking_bundle_id          → booking_bundles.id
-- Postgres allows the cycle, but the FKs must land in a single migration.
-- The booking_bundles table is created in 00140 without primary_reservation_id FK.
-- The reservations.booking_bundle_id column already exists from sub-project 1
-- (migration 00122) without an FK. We add both FKs here together.

alter table public.booking_bundles
  add constraint fk_bundles_primary_reservation
    foreign key (primary_reservation_id) references public.reservations(id)
    on delete set null;

alter table public.reservations
  add constraint fk_reservations_booking_bundle
    foreign key (booking_bundle_id) references public.booking_bundles(id)
    on delete set null;

notify pgrst, 'reload schema';
