-- 00153_booking_bundles_primary_reservation_unique.sql
-- Concurrent-attach race protection.
--
-- BundleService.attachServicesToReservation does a check-then-insert:
--   1. SELECT reservations.booking_bundle_id (sees null)
--   2. INSERT booking_bundles (no FK constraint blocks duplicates)
--   3. UPDATE reservations.booking_bundle_id (one wins)
--
-- Two simultaneous attaches against the same reservation can both pass step 1
-- and create separate bundles in step 2. Only one wins step 3, leaving the
-- other bundle orphaned (its primary_reservation_id points at a reservation
-- that points back at a different bundle). The orphan still has rows in the
-- view + status_rollup, and can confuse reporting.
--
-- Partial unique index makes the second insert fail with 23505 (unique
-- violation), which BundleService can catch and retry the SELECT path —
-- merging instead of double-creating.

create unique index if not exists uq_bundles_primary_reservation
  on public.booking_bundles (primary_reservation_id)
  where primary_reservation_id is not null;

notify pgrst, 'reload schema';
