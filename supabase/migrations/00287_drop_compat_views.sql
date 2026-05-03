-- 00287_drop_compat_views.sql
--
-- Slice H4 of the booking-canonicalization rewrite (2026-05-02).
-- Drop the three legacy compatibility views that were created during the
-- step-1 / step-2 ticket+orders extractions and the booking-bundle
-- naming transition. Each is a `select * from <real_table>` alias that
-- exists today only as a transitional shim; under the canonical schema
-- the real table names ARE canonical, so the aliases are redundant.
--
-- Three views dropped:
--
--   public.cases           — alias for public.tickets (00233:224 — recreated
--                            after the destructive cutover dropped the
--                            ticket_kind column; tickets is case-only).
--   public.service_orders  — alias for public.orders (00231:24-25).
--   public.service_order_lines — alias for public.order_line_items (00231:30-31).
--
-- Confirmed callers via grep across apps/api/src + apps/web/src + supabase/
-- migrations: ZERO. No `from('cases')`, no `from('service_orders')`, no
-- raw SQL `FROM cases` / `JOIN cases` / etc. The views were prep for a
-- future "step 6 destructive rename" that the canonicalization rewrite
-- (00276–00281) made unnecessary — the rename happened directly at the
-- table level instead.
--
-- Drops are unconditional: views have no data, only definitions.

drop view if exists public.cases;
drop view if exists public.service_orders;
drop view if exists public.service_order_lines;

notify pgrst, 'reload schema';
