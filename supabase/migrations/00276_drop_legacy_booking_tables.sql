-- 00276_drop_legacy_booking_tables.sql
-- ⚠️ DESTRUCTIVE — point-of-no-return for the booking-canonicalization rewrite
-- (2026-05-02). The user has explicitly stated nobody uses the app yet, data
-- loss is fine, and the goal is a clean foundation. See `.claude/CLAUDE.md`
-- "Booking-canonicalization rewrite" + draft contract at
-- `docs/superpowers/drafts/2026-05-02-canonical-booking-schema.sql`.
--
-- This migration tears down the legacy booking schema:
--   - multi_room_groups            (00125 — collapsed into booking_id grouping)
--   - reservations                 (00014 + 00122..00129 — replaced by booking_slots)
--   - booking_bundles              (00140..00147 — replaced by bookings)
--
-- CASCADE handles:
--   - Indexes (idx_reservations_*, idx_bundles_*, uq_*).
--   - Triggers (set_*_updated_at, set_reservations_effective_window,
--     reservations_no_overlap exclusion constraint via the table drop).
--   - FKs from sibling tables (visitors, tickets, work_orders, orders,
--     asset_reservations, recurrence_series, approvals): the FK constraints
--     are dropped but the columns remain — File 3 (00278) renames + re-FKs them.
--   - Views that read these tables: booking_bundle_status_v (00210/00222),
--     fulfillment_units_v (00222) — both will need to be re-created in a
--     follow-up migration. The spec defers view recreation; we let them break.
--
-- NOT dropped automatically (Postgres doesn't track function bodies):
--   - public.bundle_is_visible_to_user (00245) — references booking_bundles
--     and work_orders.booking_bundle_id. Will fail at runtime; planned to be
--     rewritten when the new app code lands.
--   - public.room_booking_*_report RPCs (00155, 00156) — same story.
--   - public.reservations_compute_effective_window (00122) — explicitly dropped
--     below since it's recreated under a new name on booking_slots in 00277.
--
-- NOT a SQL function: lazyCreateBundle (apps/api/.../bundle.service.ts:845)
-- is a TypeScript private method; nothing to drop in SQL.

begin;

-- ── 1. Drop dependent views first (CASCADE on the tables would do this too,
--      but doing it explicitly here keeps the failure mode clear in psql). ──
drop view if exists public.fulfillment_units_v cascade;
drop view if exists public.booking_bundle_status_v cascade;

-- ── 2. Drop the legacy tables in dependency order. CASCADE because the FK
--      cycle (booking_bundles ↔ reservations from 00147) and the assorted
--      sibling FKs would otherwise block the drops. ──

-- multi_room_groups: only reservations.multi_room_group_id (00122:43) FKs back
-- to it; safe to drop early so reservations doesn't carry a dangling FK source.
drop table if exists public.multi_room_groups cascade;

-- reservations: dropped before booking_bundles because (a) the FK cycle
-- (00147) means either order works with CASCADE, and (b) recurrence_series
-- has parent_reservation_id (00124:14) → reservations.id which is dropped here.
drop table if exists public.reservations cascade;

-- booking_bundles: visitors, tickets, work_orders, orders, asset_reservations
-- all FK to here (00252:36, 00145:7, 00213:35, 00144:5, 00142:22) — CASCADE
-- drops the FK constraints, leaving the columns to be retargeted in 00278.
drop table if exists public.booking_bundles cascade;

-- ── 3. Drop the conflict-guard trigger function. The trigger
--      `set_reservations_effective_window` was attached to the dropped table
--      so it's gone; the function is recreated in 00277 under a new name on
--      booking_slots. Drop the legacy function so it doesn't linger. ──
drop function if exists public.reservations_compute_effective_window() cascade;

-- ── 4. Drop the bundle-cycle FK helper trigger if it was registered
--      separately (00147 only added constraints, no triggers — this is a
--      defensive no-op, kept for clarity). ──
-- (no-op)

commit;

notify pgrst, 'reload schema';
