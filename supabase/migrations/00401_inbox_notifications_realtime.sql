-- 00401_inbox_notifications_realtime.sql
-- B.4.A.5 post-ship hardening — CRITICAL #1 from /full-review.
--
-- 00391 created public.inbox_notifications but did NOT add it to the
-- supabase_realtime publication. apps/web/src/lib/realtime/inbox-subscription.ts
-- (B.4.A.5 sub-step F) subscribes to `postgres_changes` on the table — the
-- channel reports 'open' but ZERO events ever fire, because Postgres-changes
-- broadcasts include ONLY tables in the publication. Result: the inbox bell
-- badge never auto-updates, the /me/inbox page never refreshes on INSERT.
--
-- This is the same failure mode that produced 00132 (reservations),
-- 00173 (booking_bundles + orders + order_line_items), 00244
-- (vendor_order_status_events), 00281 (bookings + booking_slots — after
-- the canonicalization CASCADE dropped the old reservations entry).
--
-- Pattern lifted verbatim from 00281 lines 32-52: existence-guarded
-- `alter publication … add table …`, idempotent under replay.
--
-- No `replica identity full` change. Siblings (00132/00173/00244/00281) all
-- skip it — inbox_notifications has a primary key (00391 line 35), which is
-- sufficient for Postgres logical replication to ship a full new-row payload
-- on INSERT (the only event whose row content the client needs). UPDATE
-- payloads carry the new image too; the client only inspects (eventType,
-- new.user_id), which is in the PK + insert payload.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inbox_notifications'
  ) then
    alter publication supabase_realtime add table public.inbox_notifications;
  end if;
end;
$$;

notify pgrst, 'reload schema';
