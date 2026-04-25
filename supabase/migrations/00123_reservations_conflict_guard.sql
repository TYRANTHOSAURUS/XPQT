-- 00123_reservations_conflict_guard.sql
-- The most important constraint in this slice: no two active bookings overlap on the same room.
-- Buffers are baked into time_range (see 00122). Same-requester back-to-back collapse is enforced
-- in BookingFlowService BEFORE INSERT (the constraint can't reference subqueries).

create extension if not exists btree_gist;

-- Guard: drop and recreate so re-runs are idempotent
alter table public.reservations
  drop constraint if exists reservations_no_overlap;

alter table public.reservations
  add constraint reservations_no_overlap
  exclude using gist (
    tenant_id  with =,
    space_id   with =,
    time_range with &&
  ) where (status in ('confirmed','checked_in','pending_approval'));

notify pgrst, 'reload schema';
