-- 00278_retarget_sibling_tables.sql
-- Booking-canonicalization rewrite (2026-05-02), part 3 of 3.
-- File 1 (00276) destroyed the legacy tables. File 2 (00277) created bookings
-- + booking_slots. This file retargets every sibling table that previously
-- pointed at booking_bundles / reservations.
--
-- Rename pattern (uniform):
--   *.booking_bundle_id   -> *.booking_id   (FK to bookings(id))
--   *.reservation_id      -> *.slot_id / dropped (per-table semantics)
--
-- The CASCADE drops in 00276 already removed the FK constraints; columns
-- survive (Postgres CASCADE on DROP TABLE drops constraints on referencing
-- tables but not the referencing columns themselves). We rename the columns
-- and re-add FKs against the new tables here.
--
-- audit_events is intentionally NOT touched — historical entity_type='reservation'
-- / 'booking_bundle' rows stay (immutable, 7-yr retention) per the design.
-- Views (booking_bundle_status_v, fulfillment_units_v) were dropped in 00276
-- and are NOT recreated here — the spec defers view recreation to a
-- follow-up migration when the new app code is in place.

begin;

-- ---------------------------------------------------------------------------
-- 1. visitors  (00252:36-37 dual-link pattern)
--    - drop reservation_id (was a denormalized cache; bookings hold the truth)
--    - rename booking_bundle_id -> booking_id, FK to bookings on delete cascade
--    - drop the dual-link partial indexes; replace with one canonical index
-- ---------------------------------------------------------------------------

-- These FK-derived indexes were defined at 00252:142-147; CASCADE in 00276
-- only dropped the FK constraints, so the indexes still exist. Drop both
-- explicitly so we can recreate one clean index after the rename.
drop index if exists public.idx_visitors_booking_bundle;
drop index if exists public.idx_visitors_reservation;

alter table public.visitors
  drop column if exists reservation_id;

alter table public.visitors
  rename column booking_bundle_id to booking_id;

alter table public.visitors
  add constraint fk_visitors_booking
  foreign key (booking_id) references public.bookings(id) on delete cascade;

create index idx_visitors_booking
  on public.visitors (tenant_id, booking_id)
  where booking_id is not null;

-- ---------------------------------------------------------------------------
-- 2. tickets  (00145:7 booking_bundle_id; 00145:10 idx_tickets_bundle)
--    - rename booking_bundle_id -> booking_id, FK to bookings on delete set null
--    - recreate idx_tickets_bundle under the new column name
--    - idx_tickets_kind_bundle was already dropped in 00233:199 (no-op here)
-- ---------------------------------------------------------------------------

drop index if exists public.idx_tickets_bundle;

alter table public.tickets
  rename column booking_bundle_id to booking_id;

alter table public.tickets
  add constraint fk_tickets_booking
  foreign key (booking_id) references public.bookings(id) on delete set null;

create index idx_tickets_booking
  on public.tickets (booking_id)
  where booking_id is not null;

-- ---------------------------------------------------------------------------
-- 3. work_orders  (00213:35 booking_bundle_id; 00213:167-168 idx_won_bundle)
--    - rename booking_bundle_id -> booking_id, FK to bookings on delete set null
--    - recreate idx_won_bundle under the new column name
--    - work_orders_new_single_parent + work_orders_new_kind_matches_fk CHECK
--      constraints reference booking_bundle_id by name; ALTER TABLE RENAME
--      COLUMN automatically updates the constraint definitions, so they
--      continue to enforce the same invariant on the renamed column. The
--      parent_kind enum still uses the literal string 'booking_bundle' as a
--      discriminator value — that's a label, not a column reference, so it's
--      harmless to leave (cosmetic-only follow-up if it ever feels wrong).
-- ---------------------------------------------------------------------------

drop index if exists public.idx_won_bundle;

alter table public.work_orders
  rename column booking_bundle_id to booking_id;

alter table public.work_orders
  add constraint fk_work_orders_booking
  foreign key (booking_id) references public.bookings(id) on delete set null;

create index idx_won_booking
  on public.work_orders (booking_id)
  where booking_id is not null;

-- ---------------------------------------------------------------------------
-- 4. orders  (00144:5 booking_bundle_id, 00013:48 linked_reservation_id)
--    - rename booking_bundle_id -> booking_id (FK to bookings on delete set null)
--    - rename linked_reservation_id -> linked_slot_id (FK to booking_slots on delete set null)
--    - recreate the two partial indexes (idx_orders_bundle from 00144:12,
--      idx_orders_reservation from 00013:67)
-- ---------------------------------------------------------------------------

drop index if exists public.idx_orders_bundle;
drop index if exists public.idx_orders_reservation;

alter table public.orders
  rename column booking_bundle_id to booking_id;

alter table public.orders
  rename column linked_reservation_id to linked_slot_id;

alter table public.orders
  add constraint fk_orders_booking
  foreign key (booking_id) references public.bookings(id) on delete set null,
  add constraint fk_orders_slot
  foreign key (linked_slot_id) references public.booking_slots(id) on delete set null;

create index idx_orders_booking
  on public.orders (booking_id)
  where booking_id is not null;
create index idx_orders_slot
  on public.orders (linked_slot_id)
  where linked_slot_id is not null;

-- ---------------------------------------------------------------------------
-- 5. asset_reservations  (00142:22 booking_bundle_id; 00142:40 idx_asset_reservations_bundle)
--    - rename booking_bundle_id -> booking_id, FK to bookings on delete set null
--    - recreate the partial index
-- ---------------------------------------------------------------------------

drop index if exists public.idx_asset_reservations_bundle;

alter table public.asset_reservations
  rename column booking_bundle_id to booking_id;

alter table public.asset_reservations
  add constraint fk_asset_reservations_booking
  foreign key (booking_id) references public.bookings(id) on delete set null;

create index idx_asset_reservations_booking
  on public.asset_reservations (booking_id)
  where booking_id is not null;

-- ---------------------------------------------------------------------------
-- 6. approvals  (00012:6 target_entity_type — no CHECK constraint exists today)
--    The original column was `text not null` with only a documentation comment
--    enumerating values. Add a real CHECK constraint that locks the allowed
--    values per the post-rewrite dispatcher (apps/api/src/modules/approval/
--    approval.service.ts:329-347 + handler list). 'reservation' is gone —
--    bookings own approval state.
--
--    Allowed values verified from approval.service.ts:
--      :317 'ticket'
--      :341 'booking_bundle' -> RENAMED to 'booking'
--      :361 'visitor_invite'
--      'order' is also a known caller (approval.service.ts:6 comment).
-- ---------------------------------------------------------------------------

-- Defensive: backfill any legacy rows that used 'reservation' or 'booking_bundle'
-- to the new canonical values, otherwise the CHECK constraint will reject them.
update public.approvals
   set target_entity_type = 'booking'
 where target_entity_type in ('reservation','booking_bundle');

alter table public.approvals
  drop constraint if exists approvals_target_entity_type_check;

alter table public.approvals
  add constraint approvals_target_entity_type_check
  check (target_entity_type in ('booking','order','ticket','visitor_invite'));

-- ---------------------------------------------------------------------------
-- 7. recurrence_series  (00124:14 parent_reservation_id)
--    - rename parent_reservation_id -> parent_booking_id, FK to bookings(id)
-- ---------------------------------------------------------------------------

alter table public.recurrence_series
  rename column parent_reservation_id to parent_booking_id;

alter table public.recurrence_series
  add constraint fk_recurrence_series_parent_booking
  foreign key (parent_booking_id) references public.bookings(id);

commit;

notify pgrst, 'reload schema';
