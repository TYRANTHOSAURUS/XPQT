-- 00199_reservations_with_bundle_index.sql
-- Booking-services roadmap §9.1.9: server-side filter for /desk/bookings
-- "bundles" chip. Frontend used to fetch every reservation under scope='all'
-- and client-side-filter on `booking_bundle_id IS NOT NULL`, wasting 95%
-- of the payload on tenants where most bookings are room-only.
--
-- Backend now accepts `has_bundle=true` and adds `.not('booking_bundle_id',
-- 'is', null)` to the query. This partial index makes that filter cheap by
-- only indexing rows that actually have a bundle, and ordering them the
-- same way the operator list does (start_at desc).
--
-- Why partial: most reservations are room-only (no booking_bundle_id).
-- Indexing them all would bloat the index for queries that don't use it.
-- The partial form skips them entirely.

create index if not exists idx_reservations_with_bundle
  on public.reservations (tenant_id, start_at desc)
  where booking_bundle_id is not null;

comment on index public.idx_reservations_with_bundle is
  'Partial index for /desk/bookings has_bundle=true filter. Covers tenant + start_at ordering for the operator list query when scoped to reservations with services attached. See booking-services-roadmap §9.1.9.';
