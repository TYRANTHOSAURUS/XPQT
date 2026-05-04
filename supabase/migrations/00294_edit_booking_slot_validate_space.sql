-- 00294_edit_booking_slot_validate_space.sql
-- /full-review v3 closure C1 — cross-tenant space-id corruption fix.
--
-- The 00291 + 00293 RPC trusts `p_patch->>'space_id'` blindly and writes
-- it to booking_slots.space_id (and bookings.location_id when the edited
-- slot is primary). The FK on booking_slots.space_id → spaces.id only
-- proves the row EXISTS — not that it belongs to the same tenant, is
-- active, or is even reservable.
--
-- Cross-tenant attack: caller passes a space_id from a different tenant.
-- The FK is satisfied (the row exists). The booking_slot now references
-- a foreign tenant's space; the booking's location_id (when primary)
-- mirrors it. Tenant isolation breached.
--
-- Cited file:line for codex's flag — apps/api/src/modules/reservations/
-- reservation.service.ts:884 (rpcPatch.space_id forward) +
-- supabase/migrations/00293_edit_booking_slot_lock.sql:121 (RPC writes
-- the unvalidated value).
--
-- Fix: insert a validation block immediately after `v_new_space_id` is
-- derived. Probe public.spaces for (id, tenant_id, active, reservable).
-- If any condition fails, raise P0001 with hint 'space.invalid_or_cross_tenant'
-- so the API layer can map to BadRequestException(booking.slot_space_invalid).
--
-- Columns confirmed by reading 00004_spaces.sql:13-14 — `active` and
-- `reservable` exist as boolean NOT NULL on public.spaces (no `is_*`
-- prefix used elsewhere in the codebase).
--
-- Self-contained CREATE OR REPLACE so this migration can be applied
-- without touching 00291/00293. Body equals 00293 with the validation
-- block added.

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
  -- booking. (See 00293 header for the full rationale.)
  perform 1
    from public.bookings
   where id = v_booking_id
     and tenant_id = v_tenant_id
   for update;

  -- Primary slot resolution per D3 (lowest display_order, ties by
  -- created_at ascending — NOT just display_order = 0).
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

  -- C1 validation: prove the target space belongs to this tenant AND is
  -- both active and reservable BEFORE writing it onto the slot.
  --
  -- Without this, a caller can pass any uuid that exists in public.spaces
  -- (the FK only proves existence) — including a space owned by a
  -- different tenant — and the row will land. The booking's location_id
  -- (when the edited slot is primary) mirrors that space, leaking
  -- cross-tenant data into visibility queries.
  --
  -- Errcode P0001 + hint 'space.invalid_or_cross_tenant' are the
  -- structured signal the TS service layer reads to map to
  -- BadRequestException({code: 'booking.slot_space_invalid'}).
  if v_has_space and v_new_space_id is not null then
    if not exists (
      select 1
        from public.spaces
       where id = v_new_space_id
         and tenant_id = v_tenant_id
         and active
         and reservable
    ) then
      raise exception 'space_invalid'
        using errcode = 'P0001',
              hint    = 'space.invalid_or_cross_tenant';
    end if;
  end if;

  -- Apply the patch. Each conditional write is gated by `?` (key
  -- existence) so a missing key leaves the column untouched.
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
  -- updated) slot set.
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
