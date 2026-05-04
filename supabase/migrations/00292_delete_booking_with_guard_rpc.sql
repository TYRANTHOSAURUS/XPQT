-- 00292_delete_booking_with_guard_rpc.sql
-- Phase 1.3 — Bug #1: Atomic Booking + Service via RPC + Boundary.
--
-- Compensation primitive for `BookingFlowService.create` and
-- `MultiRoomBookingService.createGroup`. When the booking + slots have already
-- landed via `create_booking` (00277:236-334) but the subsequent
-- `BundleService.attachServicesToBooking` fails, this RPC is invoked from the
-- TS side via `BookingTransactionBoundary` to roll back the booking — atomically,
-- inside ONE Postgres transaction — so the user does not end up with a
-- silently-reserved room after an error response.
--
-- Investigation digest: docs/follow-ups/phase-1-3-blocker-map.md
--   - The blocker table at lines 14-26 enumerates every row that may exist at
--     compensation time, with FK ON DELETE clauses (00278) and the per-table
--     compensation decision (delete | unhook | block | leave).
--   - Only ONE table is a true blocker: `recurrence_series.parent_booking_id`
--     has NO ACTION (00278:184); a series is created AFTER attach succeeds
--     (booking-flow.service.ts:440-485, after the failure point) and may
--     have materialised occurrences that depend on it. See blocker-map §
--     "recurrence series" lines 70-82 for rationale.
--   - All other potentially-referenced tables either cascade automatically
--     (visitors CASCADE per 00278:45; booking_slots CASCADE per 00277:119),
--     are SET NULL safely (tickets/work_orders/orders/asset_reservations per
--     00278:65/91/116/140), or are deliberately LEFT (approvals + audit_events
--     per blocker-map §"approvals against the booking" lines 42-55, §"audit
--     trail" lines 57-67).
--   - Nothing else in the blocker table is `block` or `delete`/`unhook`. The
--     only conditional return is `partial_failure` on `recurrence_series`.
--
-- Contract:
--   p_booking_id uuid    — the booking to attempt to delete
--   p_tenant_id  uuid    — caller-supplied tenant scope (matches the
--                          create_booking convention at 00277:236; service-
--                          role callers always pass it explicitly because
--                          they bypass RLS via supabase.admin)
--
-- Returns: jsonb
--   { kind: 'rolled_back' }                                        (success)
--   { kind: 'partial_failure', blocked_by: ['recurrence_series'] } (blocker found)
--
-- Raises:
--   - sqlstate 'P0002' with message 'booking.not_found' if the booking does
--     not exist (or belongs to a different tenant). Caller maps to a no-op
--     or surfaces; today the boundary expects the booking to exist (we just
--     created it on the same request).
--
-- Security model: SECURITY INVOKER. RLS still applies for any caller that
-- isn't the service role; matches the pattern of create_booking
-- (00277:262) and edit_booking_slot (00291:53). The service-role admin
-- client (the only production caller per BookingCompensationService)
-- bypasses RLS but is constrained by p_tenant_id matching on every read/write
-- below.

create or replace function public.delete_booking_with_guard(
  p_booking_id uuid,
  p_tenant_id  uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant_id    uuid;
  v_exists       boolean;
  v_has_series   boolean;
begin
  -- Tenant resolution mirrors create_booking (00277:271-275) and
  -- edit_booking_slot (00291:70-73). Service-role callers pass it explicitly;
  -- user-token callers fall back to JWT claim.
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then
    raise exception 'delete_booking_with_guard: tenant_id required (none in JWT, none passed)';
  end if;

  -- Lock the booking row FOR UPDATE (per blocker-map RPC pseudocode line 91)
  -- so any concurrent inserts referencing this booking_id (e.g. a parallel
  -- attachServicesToBooking) serialize against this transaction.
  select true
    into v_exists
    from public.bookings
   where id = p_booking_id
     and tenant_id = v_tenant_id
   for update;

  if not found then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;

  -- Check the only true blocker: recurrence_series with NO ACTION FK
  -- (00278:184). Per blocker-map §"recurrence series" (lines 70-82): if a
  -- child series exists, deleting the parent would orphan materialised
  -- occurrences; we must surface this so the caller can handle the series
  -- (cancel it, or call us only when no series exists).
  select exists (
    select 1
      from public.recurrence_series
     where parent_booking_id = p_booking_id
       and tenant_id = v_tenant_id
  )
  into v_has_series;

  if v_has_series then
    return jsonb_build_object(
      'kind', 'partial_failure',
      'blocked_by', jsonb_build_array('recurrence_series')
    );
  end if;

  -- No explicit unhook/delete needed for the remaining tables (all decisions
  -- per blocker-map lines 14-26):
  --   - asset_reservations: status='cancelled' tombstones from Cleanup
  --     (bundle.service.ts:1920-1925); FK SET NULL (00278:140) is safe; do
  --     not delete (audit + GiST history).
  --   - approvals (booking target): not cancelled by Cleanup
  --     (bundle.service.ts:1940-1945); leave as historical record.
  --   - approvals (order/oli targets): already cancelled by Cleanup
  --     (bundle.service.ts:1952-1964); no FK to bookings.
  --   - audit_events / audit_outbox: append-only, no FK.
  --   - work_orders: created only after cleanup.commit() succeeds
  --     (bundle.service.ts:375-456); never present at compensation time.
  --   - visitors: CASCADE handles them (00278:45) — see blocker-map line 26.
  --   - booking_slots: CASCADE handles them (00277:119).
  --   - orders / order_line_items: Cleanup deletes them on attach failure
  --     (bundle.service.ts:1907-1938); compensation only runs after
  --     attach failed, so Cleanup has already run.

  -- Delete the booking. Cascades to:
  --   - booking_slots         (00277:119, CASCADE)
  --   - visitors              (00278:45,  CASCADE)
  -- Sets NULL on:
  --   - tickets.booking_id    (00278:65)
  --   - work_orders.booking_id(00278:91)   — none should exist
  --   - orders.booking_id     (00278:116)  — Cleanup already deleted these
  --   - asset_reservations.booking_id (00278:140)
  delete from public.bookings
   where id = p_booking_id
     and tenant_id = v_tenant_id;

  return jsonb_build_object('kind', 'rolled_back');
end;
$$;

notify pgrst, 'reload schema';
