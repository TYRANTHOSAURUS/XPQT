-- 00129_room_booking_indexes.sql
-- Non-constraint indexes for the room booking module's core read paths.

-- Auto-release scheduler (partial — keeps the working set tiny)
create index if not exists idx_reservations_pending_check_in
  on public.reservations (tenant_id, start_at)
  where check_in_required = true
    and status = 'confirmed'
    and checked_in_at is null;

-- "My bookings" list
create index if not exists idx_reservations_requester_time
  on public.reservations (tenant_id, requester_person_id, start_at desc)
  where status not in ('cancelled','released');

-- Picker availability per-room
create index if not exists idx_reservations_space_time_active
  on public.reservations (tenant_id, space_id, start_at, end_at)
  where status in ('confirmed','checked_in','pending_approval');

-- Multi-attendee find-time
create index if not exists idx_reservations_attendee_persons
  on public.reservations using gin (attendee_person_ids)
  where status in ('confirmed','checked_in','pending_approval');

-- Cancellation grace cleanup
create index if not exists idx_reservations_cancellation_grace
  on public.reservations (tenant_id, cancellation_grace_until)
  where cancellation_grace_until is not null;

notify pgrst, 'reload schema';
