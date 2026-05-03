-- 00281_realtime_publication_canonicalization.sql
-- Booking-canonicalization rewrite (2026-05-02), follow-up to 00276–00280.
--
-- Two fixes from the post-execution full-review:
--
-- 1. supabase_realtime publication is missing bookings + booking_slots.
--    Migrations 00132 (reservations) and 00173 (booking_bundles) added the old
--    tables; CASCADE in 00276 removed them from the publication automatically
--    but did NOT add the replacements. Frontend hooks at
--    apps/web/src/pages/desk/scheduler/hooks/use-realtime-scheduler.ts:68 and
--    apps/web/src/pages/portal/book-room/hooks/use-realtime-availability.ts:63
--    still subscribe to the dropped 'reservations' table; they report channel
--    'open' but receive zero events. Desk scheduler + portal availability are
--    permanently stale until manual refresh.
--
-- 2. reservation_merge_policy_snapshot() SQL function survived 00279 — its
--    body still references the dropped public.reservations table. No current
--    SQL caller, but a landmine waiting to throw "relation does not exist"
--    if anything ever invokes it. Drop it now.
--
-- Other findings from the full-review (calendar_sync_events.reservation_id PK
-- rename, room_calendar_conflicts.reservation_id rename, scheduler_data RPC
-- shape, cases/service_orders compatibility views, work_orders.parent_kind
-- enum cosmetic) are real but either gated on unwired calendar sync or
-- non-breaking. Deferred to a follow-up slice.

-- ----------------------------------------------------------------------------
-- 1. Add canonical tables to the realtime publication.
-- ----------------------------------------------------------------------------
-- The publication exists since 00132. Add idempotently in case it's already
-- been added (supabase_realtime.publication_tables.add throws if duplicate).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'booking_slots'
  ) then
    alter publication supabase_realtime add table public.booking_slots;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Drop the dead reservation_merge_policy_snapshot function.
-- ----------------------------------------------------------------------------
-- Body references public.reservations (dropped in 00276:53). Verified no
-- TS caller via grep. Safe to drop; not a behavioural change.
drop function if exists public.reservation_merge_policy_snapshot(uuid, jsonb);

notify pgrst, 'reload schema';
