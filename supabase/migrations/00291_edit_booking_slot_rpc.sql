-- 00291_edit_booking_slot_rpc.sql
-- Phase 1.4 — Bug #2: Slot-First Scheduler.
--
-- The desk scheduler used to PATCH /api/reservations/:id with id=booking.id.
-- Backend editOne (reservation.service.ts:604-714) only edits the booking's
-- PRIMARY slot — so dragging a non-primary slot row of a multi-room booking
-- silently moved the primary slot instead. Fix: a new endpoint targeting
-- one slot by id, atomic with the booking-level mirror recompute.
--
-- This RPC is the atomicity primitive. It updates one booking_slots row
-- with the supplied patch, then recomputes the parent booking's
-- start_at / end_at / location_id mirrors in the SAME transaction. The
-- GiST exclusion constraint booking_slots_no_overlap (00277:211-217)
-- continues to enforce per-space window non-overlap; on conflict the
-- standard SQLSTATE 23P01 propagates so the API layer maps it to
-- ConflictException(booking.slot_conflict).
--
-- Contract:
--   p_slot_id   uuid    — slot to update (must exist in caller's tenant)
--   p_patch     jsonb   — { space_id?, start_at?, end_at? } (only those keys
--                          honored; unrelated keys ignored)
--   p_tenant_id uuid    — caller-supplied tenant scope (matches the
--                          create_booking convention at 00277:236; service-
--                          role callers always pass it explicitly because
--                          they bypass RLS via supabase.admin)
--
-- Returns: jsonb { slot: <updated slot row>, booking: <updated booking row> }.
-- Raises:
--   - sqlstate 'P0002' with message 'booking_slot.not_found' if the slot
--     does not exist (or belongs to a different tenant).
--   - sqlstate '23P01' (GiST exclusion) on overlap with another active slot.
--
-- Mirror invariant (matches Phase 1 plan D3 + reservation.service.ts:635-638):
--   bookings.start_at = MIN(start_at) across the booking's slots
--   bookings.end_at   = MAX(end_at)   across the booking's slots
--   bookings.location_id = (p_patch->>'space_id')::uuid ONLY when the edited
--     slot is the booking's PRIMARY (lowest display_order, ties broken by
--     created_at ascending — NOT just display_order = 0) AND p_patch carries
--     a space_id key.
--
-- Security model: SECURITY INVOKER. RLS still applies for any caller that
-- isn't the service role; matches the pattern of create_booking (00277:262).
-- The service-role admin client (the ONLY production caller per the slot-
-- edit endpoint) bypasses RLS but is constrained by p_tenant_id matching
-- on every read/write below.

create or replace function public.edit_booking_slot(
  p_slot_id   uuid,
  p_patch     jsonb,
  p_tenant_id uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenant_id    uuid;
  v_booking_id   uuid;
  v_primary_id   uuid;
  v_is_primary   boolean;
  v_has_space    boolean;
  v_new_space_id uuid;
  v_slot_row     jsonb;
  v_booking_row  jsonb;
  v_min_start    timestamptz;
  v_max_end      timestamptz;
begin
  -- Tenant resolution mirrors create_booking (00277:271-275). Service-role
  -- callers pass it explicitly; user-token callers fall back to JWT claim.
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then
    raise exception 'edit_booking_slot: tenant_id required (none in JWT, none passed)';
  end if;

  -- Load the slot's booking_id under the tenant filter. NOT FOUND if
  -- the slot doesn't exist for this tenant — surfaced as P0002 so the
  -- API can map to NotFoundException(booking_slot.not_found).
  select booking_id
    into v_booking_id
    from public.booking_slots
   where id = p_slot_id
     and tenant_id = v_tenant_id;

  if not found then
    raise exception 'booking_slot.not_found' using errcode = 'P0002';
  end if;

  -- Primary slot resolution per D3 (lowest display_order, ties by
  -- created_at ascending — NOT just display_order = 0). Single-slot
  -- bookings: this trivially returns the only slot's id.
  select id
    into v_primary_id
    from public.booking_slots
   where booking_id = v_booking_id
     and tenant_id  = v_tenant_id
   order by display_order asc, created_at asc
   limit 1;

  v_is_primary := (v_primary_id = p_slot_id);
  v_has_space  := p_patch ? 'space_id';
  if v_has_space then
    v_new_space_id := nullif(p_patch->>'space_id', '')::uuid;
  end if;

  -- Apply the patch. Each conditional write is gated by `?` (key
  -- existence) so a missing key leaves the column untouched. Empty
  -- string would be coerced to null by `nullif` above for space_id.
  -- The trigger booking_slots_compute_effective_window (00277:204-206)
  -- recomputes effective_start_at / effective_end_at / time_range
  -- automatically — we don't write those here.
  update public.booking_slots
     set space_id = case when v_has_space then v_new_space_id else space_id end,
         start_at = case when p_patch ? 'start_at'
                         then (p_patch->>'start_at')::timestamptz
                         else start_at end,
         end_at   = case when p_patch ? 'end_at'
                         then (p_patch->>'end_at')::timestamptz
                         else end_at end
   where id = p_slot_id
     and tenant_id = v_tenant_id;

  -- Recompute booking-level start_at / end_at mirrors over the (possibly
  -- updated) slot set. Even single-slot bookings re-derive these — keeps
  -- the invariant simple.
  select min(start_at), max(end_at)
    into v_min_start, v_max_end
    from public.booking_slots
   where booking_id = v_booking_id
     and tenant_id  = v_tenant_id;

  if v_is_primary and v_has_space and v_new_space_id is not null then
    -- Primary slot's room changed → mirror the new space onto the booking
    -- location_id (matches editOne's behavior at reservation.service.ts:637).
    update public.bookings
       set start_at    = v_min_start,
           end_at      = v_max_end,
           location_id = v_new_space_id
     where id = v_booking_id
       and tenant_id = v_tenant_id;
  else
    update public.bookings
       set start_at = v_min_start,
           end_at   = v_max_end
     where id = v_booking_id
       and tenant_id = v_tenant_id;
  end if;

  -- Read the freshly-updated slot + booking back so the API layer can
  -- project them through slotWithBookingToReservation without a second
  -- round-trip.
  select to_jsonb(s.*)
    into v_slot_row
    from public.booking_slots s
   where s.id = p_slot_id
     and s.tenant_id = v_tenant_id;

  select to_jsonb(b.*)
    into v_booking_row
    from public.bookings b
   where b.id = v_booking_id
     and b.tenant_id = v_tenant_id;

  return jsonb_build_object(
    'slot', v_slot_row,
    'booking', v_booking_row
  );
end;
$$;

notify pgrst, 'reload schema';
