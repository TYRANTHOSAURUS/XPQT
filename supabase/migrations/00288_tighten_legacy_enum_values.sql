-- 00288_tighten_legacy_enum_values.sql
--
-- Slice H6 of the booking-canonicalization rewrite (2026-05-02).
-- Tighten two CHECK constraints whose enum vocabularies still admit
-- pre-canonicalization labels.
--
-- 1. work_orders.parent_kind: rename 'booking_bundle' → 'booking'.
--    Two CHECK constraints reference the literal:
--      * work_orders_new_parent_kind_check (00213:33)
--      * work_orders_new_kind_matches_fk   (00218:140-148, then column-renamed
--        in-place by 00278's ALTER TABLE RENAME — the constraint def kept
--        the old `'booking_bundle'` discriminator string)
--    Discriminator strings are not column references, so 00278's column
--    rename did NOT update them. The single writer is
--    apps/api/src/modules/ticket/ticket.service.ts:1811 (createBookingOriginWorkOrder).
--    That writer flips to 'booking' in the same commit.
--
-- 2. activities.entity_kind: drop 'reservation' from the allowed set.
--    No live writer emits 'reservation' (verified via grep on
--    `entity_kind: 'reservation'` across apps/api/src). The label survived
--    in the CHECK from 00202:34 because activities were originally
--    polymorphic across many entity kinds, but per the booking
--    canonicalization the canonical entity is `'booking'`. Per
--    .claude/CLAUDE.md booking section ("destructive defaults authorized,
--    no legacy preservation, data loss is fine"), DELETE existing rows
--    with entity_kind='reservation' rather than rewriting them — the
--    referenced entity_id points at a dropped reservations.id and the
--    activity body would be unreadable in the UI anyway.

begin;

-- ─── work_orders.parent_kind ───────────────────────────────────────────────

-- Backfill existing rows with the legacy label to the canonical value
-- before tightening the CHECK constraints.
update public.work_orders
   set parent_kind = 'booking'
 where parent_kind = 'booking_bundle';

alter table public.work_orders
  drop constraint work_orders_new_parent_kind_check;

alter table public.work_orders
  add constraint work_orders_parent_kind_check
  check (parent_kind = any (array['case'::text, 'booking'::text]));

-- The composite CHECK that ties parent_kind ↔ FK columns embeds the
-- discriminator literal too. Recreate with 'booking'.
alter table public.work_orders
  drop constraint work_orders_new_kind_matches_fk;

alter table public.work_orders
  add constraint work_orders_kind_matches_fk
  check (
    (parent_kind is null     and parent_ticket_id is null and booking_id is null)
    or (parent_kind = 'case'    and parent_ticket_id is not null and booking_id is null)
    or (parent_kind = 'booking' and parent_ticket_id is null     and booking_id is not null)
  );

-- ─── activities.entity_kind ────────────────────────────────────────────────

-- Wipe the orphaned legacy rows (entity_id points at dropped reservations).
delete from public.activities
 where entity_kind = 'reservation';

alter table public.activities
  drop constraint activities_entity_kind_check;

alter table public.activities
  add constraint activities_entity_kind_check
  check (
    entity_kind in (
      'ticket',         -- legacy umbrella; pre-step1 split
      'case',
      'work_order',
      'booking',
      'order',
      'service_order'
    )
  );

commit;

notify pgrst, 'reload schema';
