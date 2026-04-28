-- Add bundle / order / line tables to the supabase_realtime publication so
-- the booking detail surface can stream fulfillment-status changes
-- (ordered → confirmed → preparing → delivered) without manual refreshes.
--
-- Mirrors the pattern in 00132_reservations_realtime.sql — the publication
-- is created by Supabase on project boot, so we conditionally add tables
-- if (and only if) it exists, and skip silently in any environment that
-- doesn't run the platform's realtime worker.
--
-- Tables added:
--   - public.order_line_items   (the per-line fulfillment_status pulse)
--   - public.orders             (kept in sync because line edits cascade
--                                to order.requested_for_* and downstream
--                                dispatching consumes that)
--   - public.booking_bundles    (status_rollup recomputes when lines move)

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = 'order_line_items'
    ) then
      alter publication supabase_realtime add table public.order_line_items;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = 'orders'
    ) then
      alter publication supabase_realtime add table public.orders;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = 'booking_bundles'
    ) then
      alter publication supabase_realtime add table public.booking_bundles;
    end if;

  end if;
end $$;

notify pgrst, 'reload schema';
