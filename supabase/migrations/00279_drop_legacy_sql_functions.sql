-- 00279_drop_legacy_sql_functions.sql
-- Booking-canonicalization rewrite (2026-05-02), follow-up cleanup.
--
-- 00276 dropped the legacy tables (`reservations`, `booking_bundles`,
-- `multi_room_groups`) but left several SQL functions and views that
-- reference those tables in their bodies. Postgres doesn't track
-- function-body dependencies, so they survive the table drops and
-- silently rot — calling them now raises `relation "X" does not exist`
-- at execution time.
--
-- This migration is the destructive cleanup pass for those orphaned
-- objects:
--
--   1. public.bundle_is_visible_to_user(uuid, uuid, uuid)  — 00245
--      Visibility helper that walked booking_bundles + work_orders.
--      booking_bundle_id; both targets are gone. No SQL caller in the
--      app per the slice A investigation; kill it. The TS-side
--      `BundleVisibilityService` is the single source of truth now.
--
--   2. Room-booking-report RPCs (00155, 00156)
--      - room_booking_report_overview(uuid, date, date, uuid, text)
--      - room_booking_utilization_report(uuid, date, date, uuid, text)
--      - room_booking_no_shows_report(uuid, date, date, uuid, text)
--      - room_booking_services_report(uuid, date, date, uuid, text)
--      - room_booking_demand_report(uuid, date, date, uuid, text)
--      All five aggregate over the dropped `reservations` table.
--      Drop here; the reports module needs a rewrite against the new
--      `bookings` + `booking_slots` schema in a follow-up slice (the
--      `/desk/reports/bookings/*` UI is currently disabled and will
--      stay so until that rewrite lands).
--
-- IF NOT EXISTS / IF EXISTS used everywhere so the migration is
-- idempotent against fresh local resets and remote pushes alike.

begin;

drop function if exists public.bundle_is_visible_to_user(uuid, uuid, uuid);

drop function if exists public.room_booking_report_overview(uuid, date, date, uuid, text);
drop function if exists public.room_booking_utilization_report(uuid, date, date, uuid, text);
drop function if exists public.room_booking_no_shows_report(uuid, date, date, uuid, text);
drop function if exists public.room_booking_services_report(uuid, date, date, uuid, text);
drop function if exists public.room_booking_demand_report(uuid, date, date, uuid, text);

commit;

notify pgrst, 'reload schema';
