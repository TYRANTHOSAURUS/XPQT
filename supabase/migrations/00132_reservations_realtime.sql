-- 00132_reservations_realtime.sql
-- Ensure room-booking tables are members of the supabase_realtime publication
-- so the FE can subscribe to INSERT/UPDATE/DELETE events on:
--   - reservations:tenant_<id>:space_<id>  (per-room channel)
--   - reservations:tenant_<id>:user_<id>   (my-reservations channel)
--   - room_booking_rules:tenant_<id>       (admin rules-changed channel)
--
-- supabase_realtime is created by the Supabase platform on first project boot.
-- We use DO blocks to add tables idempotently — no error if the table is
-- already a member of the publication.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- reservations
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = 'reservations'
    ) then
      alter publication supabase_realtime add table public.reservations;
    end if;

    -- room_booking_rules
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = 'room_booking_rules'
    ) then
      alter publication supabase_realtime add table public.room_booking_rules;
    end if;

    -- recurrence_series (so series state changes are visible to admin views)
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = 'recurrence_series'
    ) then
      alter publication supabase_realtime add table public.recurrence_series;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
