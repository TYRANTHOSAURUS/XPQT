-- 00285_calendar_sync_canonicalization.sql
--
-- Slice H1 + H2 of the booking-canonicalization rewrite (2026-05-02).
-- Rename the two reservation-anchored FK columns in the calendar-sync
-- subsystem so they target the canonical bookings/booking_slots tables.
--
-- Tables touched:
--   1. public.calendar_sync_events (00126:39-47)
--      - reservation_id is part of the composite PK (reservation_id, provider).
--      - Drop the PK, rename column → booking_id, re-add the PK on
--        (booking_id, provider). Add new FK to bookings(id) on delete cascade
--        (the original FK to reservations was implicitly dropped by 00276:53
--        — DROP TABLE CASCADE removes referencing constraints but leaves the
--        column itself).
--      - The "tenant_isolation_via_reservation" policy joined against the
--        dropped `public.reservations` table; replace with a join against
--        public.bookings.
--
--   2. public.room_calendar_conflicts (00126:61-76)
--      - reservation_id is a regular nullable column → simple rename to
--        slot_id, with a fresh FK to booking_slots(id) on delete set null.
--        (Conflicts are point-in-time records; if the slot is later deleted,
--        the conflict row should survive without dangling.)
--      - The semantic meaning is "the booking_slot whose external mismatch
--        triggered this conflict" — see reconciler.service.ts:137,153 where
--        matched.id / r.id are booking_slot ids returned by loadReservations
--        (which now reads from booking_slots, post-canonicalization).
--
-- Outlook integration is wired only to Phase A surfaces today (Phase C —
-- BookingFlowService cancel/create wiring — is unshipped per
-- calendar-sync.service.ts:347 comment). No live calendar event payloads
-- are flowing yet, so any rows in either table are orphans referencing
-- ids from the dropped `reservations` table. Per .claude/CLAUDE.md
-- "Booking-canonicalization rewrite" section: destructive defaults
-- authorized, no legacy preservation. TRUNCATE both tables before the
-- rename so the new FKs apply cleanly.

begin;

-- ─── 1. calendar_sync_events ───────────────────────────────────────────────

truncate table public.calendar_sync_events;

drop policy if exists "tenant_isolation_via_reservation" on public.calendar_sync_events;

alter table public.calendar_sync_events
  drop constraint calendar_sync_events_pkey;

alter table public.calendar_sync_events
  rename column reservation_id to booking_id;

alter table public.calendar_sync_events
  add primary key (booking_id, provider);

alter table public.calendar_sync_events
  add constraint fk_calendar_sync_events_booking
  foreign key (booking_id) references public.bookings(id) on delete cascade;

create policy "tenant_isolation_via_booking" on public.calendar_sync_events
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and b.tenant_id = public.current_tenant_id()
  ));

-- ─── 2. room_calendar_conflicts ────────────────────────────────────────────

truncate table public.room_calendar_conflicts;

alter table public.room_calendar_conflicts
  rename column reservation_id to slot_id;

alter table public.room_calendar_conflicts
  add constraint fk_room_calendar_conflicts_slot
  foreign key (slot_id) references public.booking_slots(id) on delete set null;

commit;

notify pgrst, 'reload schema';
