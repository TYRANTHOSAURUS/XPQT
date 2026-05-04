-- 00293_edit_booking_slot_lock.sql
-- /full-review v3 closure — C1 lock fix.
--
-- The 00291 RPC body updates the slot, then SELECTs MIN(start_at) /
-- MAX(end_at) from booking_slots, then UPDATEs bookings. There is no
-- explicit lock on the parent bookings row at the top of the function.
--
-- Two concurrent edit_booking_slot() calls on different slots of the same
-- booking can each:
--   1. UPDATE their own slot (two different rows, no row-lock contention),
--   2. SELECT MIN/MAX from booking_slots (snapshot timing — neither call
--      sees the other call's pending UPDATE under READ COMMITTED,
--      because each transaction's MVCC view excludes the other's
--      uncommitted writes),
--   3. UPDATE bookings.start_at = its locally-computed MIN.
--
-- Whichever transaction commits last writes its stale mirror. The
-- bookings.start_at / end_at can disagree with the actual MIN/MAX of
-- booking_slots after both commit. Functional bug: the booking-level
-- mirror used by listMine / listForOperator filters reflects only one
-- of the two edits, breaking visibility filtering.
--
-- Fix: take a row-level lock on the parent bookings row at the top of
-- the function (after tenant + booking-id resolution, before any read
-- of slot times for the mirror). FOR UPDATE serialises concurrent
-- callers — the second caller blocks until the first commits, then sees
-- the post-commit slot state and recomputes a MIN/MAX over the WHOLE
-- updated set.
--
-- Self-contained CREATE OR REPLACE so this migration can be applied to
-- remote without touching 00291. The function body is the same as 00291
-- with one PERFORM line added immediately after v_booking_id is read.
-- Cited reference: 00291_edit_booking_slot_rpc.sql lines 78-82 (booking_id
-- resolution), 91-97 (primary-slot resolution), 111-146 (mutate + mirror).

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

  -- C1 lock: serialise concurrent edits on different slots of the SAME
  -- booking. Without this, two callers can each UPDATE their own slot,
  -- then each compute MIN/MAX from a snapshot that excludes the other's
  -- pending UPDATE (READ COMMITTED MVCC), then each write stale mirrors
  -- to bookings.start_at / end_at — last-writer-wins corruption.
  --
  -- FOR UPDATE acquires a row-level lock on the parent bookings row.
  -- Concurrent callers block here until the first commits; when the
  -- second proceeds it sees the first's slot UPDATE and recomputes a
  -- correct MIN/MAX over the full slot set.
  --
  -- Placed BEFORE any read of slot times for the mirror (the SELECT
  -- min/max below at v_min_start/v_max_end). After v_booking_id is
  -- known, before the slot UPDATE so the lock covers the entire
  -- read-modify-write window.
  perform 1
    from public.bookings
   where id = v_booking_id
     and tenant_id = v_tenant_id
   for update;

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
