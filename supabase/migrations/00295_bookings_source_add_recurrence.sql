-- 00295_bookings_source_add_recurrence.sql
-- /full-review v3 closure Nit — distinct source label for system-recurrence bookings.
--
-- Pre-fix: recurrence-materialised occurrences passed `source: 'auto'`
-- through booking-flow.service.ts:191-193 (and multi-room-booking
-- :207-211), where 'auto' was coerced to 'calendar_sync' before being
-- written to bookings.source. The result was that every system-recurrence
-- booking landed with source='calendar_sync' — visually
-- indistinguishable from an Outlook/Google poll-imported event.
--
-- This matters for:
--   1. Audit trails — operators triaging "why did this booking appear"
--      need to know if it was an Outlook sync vs the recurrence cron.
--   2. Reporting — calendar_sync utilisation is a different metric than
--      recurrence-driven occupancy.
--   3. Future automation — booking modules may want to gate behaviour
--      on system-recurrence (e.g. skip approval routing differently
--      from external calendar sync).
--
-- Fix: widen the CHECK constraint on bookings.source to include
-- 'recurrence'. The TS BookingSource union (dto/types.ts:28-33) and the
-- coercion path in booking-flow + multi-room are updated in the same
-- commit so 'auto' from system:recurrence actors maps to 'recurrence'
-- (not 'calendar_sync').
--
-- Cited references:
--   - 00277_create_canonical_booking_schema.sql:54-58 — original CHECK
--   - apps/api/src/modules/reservations/booking-flow.service.ts:186-193
--   - apps/api/src/modules/reservations/multi-room-booking.service.ts:202-211
--   - apps/api/src/modules/reservations/recurrence.service.ts:487 (uses 'auto' today)
--
-- Self-contained ALTER — `drop constraint` + `add constraint` keeps the
-- existing column shape intact and makes the change reversible if needed.

alter table public.bookings
  drop constraint if exists bookings_source_check;

alter table public.bookings
  add constraint bookings_source_check
  check (source in (
    'portal','desk','api','calendar_sync','reception','recurrence'
  ));

notify pgrst, 'reload schema';
