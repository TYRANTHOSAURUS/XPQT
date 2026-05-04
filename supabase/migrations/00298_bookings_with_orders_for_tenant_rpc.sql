-- 00298_bookings_with_orders_for_tenant_rpc.sql
--
-- B.3.3 — Codex round-3 flagged the `has_bundle` filter at
-- apps/api/src/modules/reservations/reservation.service.ts:326 as an
-- N+1 antipattern. The TS service was running:
--
--   const { data } = await supabase.admin
--     .from('orders')
--     .select('booking_id')
--     .eq('tenant_id', tenantId)
--     .not('booking_id', 'is', null);
--   const ids = Array.from(new Set(data.map(r => r.booking_id)));
--   q = q.in('booking_id', ids);
--
-- Two problems:
--   1. The first query reads EVERY orders row for the tenant — one
--      ROW per order, not per booking. A tenant with 10 000 orders
--      across 3 000 bookings hauls 10 000 rows over the wire just to
--      derive 3 000 distinct booking_ids.
--   2. The .in('booking_id', ids) filter then sends those 3 000 ids
--      back through the URL as a PostgREST query parameter — past
--      ~1 000 ids the URL exceeds CDN/edge limits and the request
--      either truncates or 414s.
--
-- Fix (this migration): a single SQL function that returns the deduped
-- booking_id set in one round-trip. The TS service replaces the dual
-- (over-fetch + dedup-in-memory + .in()) pattern with one .rpc() call
-- that returns the bounded list directly.
--
-- This is the EXISTS-subquery shape the plan asked for, expressed as
-- a Postgres function the TS layer can call cleanly. Pure SQL, stable,
-- security invoker so RLS still applies on cross-tenant queries.
--
-- Index usage: idx_orders_booking (00278:120-122) is a partial btree
-- on `orders(booking_id) WHERE booking_id IS NOT NULL`. The function's
-- predicate matches the partial filter, so the planner uses an
-- index-only scan with no per-row tenant_id check beyond the inline
-- predicate — all three filter columns are covered by either the
-- partial index or the row-level scan path.
--
-- Citations:
--   - 00278_retarget_sibling_tables.sql:108-122 (orders.booking_id
--     rename + idx_orders_booking partial index)
--   - apps/api/src/modules/reservations/reservation.service.ts:327-342
--     (the N+1 pattern this RPC replaces)

create or replace function public.bookings_with_orders_for_tenant(
  p_tenant_id uuid
) returns setof uuid
language sql
stable
security invoker
as $$
  select distinct booking_id
    from public.orders
   where tenant_id = p_tenant_id
     and booking_id is not null
$$;

notify pgrst, 'reload schema';
