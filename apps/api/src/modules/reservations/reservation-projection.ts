// Booking-canonicalisation rewrite (2026-05-02):
//
// Projection helper that turns a `booking_slots` row joined with its parent
// `bookings` row (00277:116, 00277:27) into the legacy flat `Reservation`
// shape that downstream consumers (notifications, audit, multi-room, etc.)
// still consume. The shim is transitional — see dto/types.ts. Removed once
// every consumer migrates to `Booking` + `BookingSlot`.
//
// Field mapping (slot field ← booking field):
//   - id                       ← booking.id  (BREAKING: legacy = reservations.id, new = bookings.id)
//   - tenant_id                ← booking.tenant_id
//   - reservation_type         ← slot.slot_type (00277:122) mapped 'asset' → 'other'
//   - space_id                 ← slot.space_id (00277:124)
//   - requester_person_id      ← booking.requester_person_id (00277:36)
//   - host_person_id           ← booking.host_person_id (00277:37)
//   - start_at / end_at        ← slot.start_at / slot.end_at (00277:127-128)
//   - attendee_count           ← slot.attendee_count (00277:138)
//   - attendee_person_ids      ← slot.attendee_person_ids (00277:139)
//   - status                   ← slot.status (00277:142-144)
//   - recurrence_*             ← booking.recurrence_* (00277:74-77)
//   - recurrence_master_id     ← null (column dropped — series link is one-direction)
//   - approval_id              ← null (back-link via approvals.target_entity_id)
//   - linked_order_id          ← null (legacy field; nothing in tree reads it)
//   - setup/teardown buffers   ← slot.{setup,teardown}_buffer_minutes (00277:131-132)
//   - effective_*_at           ← slot.effective_*_at (00277:133-134, trigger-maintained)
//   - check_in_*               ← slot.check_in_* (00277:147-151)
//   - policy_snapshot          ← booking.policy_snapshot (00277:63)
//   - applied_rule_ids         ← booking.applied_rule_ids (00277:64)
//   - source                   ← booking.source (00277:56-58)
//   - booked_by_user_id        ← booking.booked_by_user_id (00277:38)
//   - cost_amount_snapshot     ← booking.cost_amount_snapshot (00277:62)
//   - multi_room_group_id      ← null (column dropped — replaced by booking_id grouping)
//   - calendar_*               ← booking.calendar_* (00277:68-71)
//   - booking_bundle_id        ← booking.id (under canonicalisation, the booking IS the bundle)

import type { Booking, BookingSlot, Reservation, ReservationSource } from './dto/types';

/**
 * The PostgREST embed shape returned when querying booking_slots with a join.
 * The slot row has booking via either `bookings(...)` or `booking:bookings(...)`
 * depending on the select string.
 */
export interface SlotWithBookingEmbed extends Omit<BookingSlot, 'booking_id'> {
  booking_id: string;
  bookings: Booking | Booking[] | null;
}

/**
 * Project a slot+booking embed into the legacy `Reservation` shape.
 *
 * BREAKING: `id` is the BOOKING id (was the reservation id pre-rewrite).
 * Every caller passing this id back to a server endpoint should be treating
 * it as a booking id from now on.
 */
export function slotWithBookingToReservation(
  row: SlotWithBookingEmbed,
): Reservation {
  const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
  if (!booking) {
    throw new Error(
      `slotWithBookingToReservation: slot ${row.id} has no parent booking — corrupted join`,
    );
  }
  return slotAndBookingToReservation(row, booking);
}

/**
 * Project a slot row + an explicit booking row into the legacy shape.
 * Used when the caller has already separated the joined data (or read them
 * separately).
 */
export function slotAndBookingToReservation(
  slot: BookingSlot,
  booking: Booking,
): Reservation {
  return {
    id: booking.id,                                // BREAKING — was reservations.id
    slot_id: slot.id,                              // canonical booking_slots.id (NEW; post-/full-review I2 fix)
    booking_id: booking.id,                        // Phase 1.4: explicit booking grouping field — same value as `id`
                                                   //   today, emitted separately so list dedup/grouping consumers
                                                   //   (Phase 1.2 cursor pagination, /desk/bookings cards, command
                                                   //   palette) don't conflate it with the per-slot key.
    tenant_id: booking.tenant_id,
    // 00277:122 enumerates room/desk/asset/parking; legacy ReservationType
    // included 'other' which we map back from 'asset' so consumers checking
    // `reservation_type === 'other'` keep working transitionally.
    reservation_type: slot.slot_type === 'asset' ? 'other' : slot.slot_type,
    space_id: slot.space_id,
    requester_person_id: booking.requester_person_id,
    host_person_id: booking.host_person_id,
    start_at: slot.start_at,
    end_at: slot.end_at,
    attendee_count: slot.attendee_count,
    attendee_person_ids: slot.attendee_person_ids,
    status: slot.status,
    // Recurrence rule itself is no longer stored on the row in v1; it was
    // never persisted in the legacy schema either (it lives on
    // recurrence_series.recurrence_rule). Keep null in the shim.
    recurrence_rule: null,
    recurrence_series_id: booking.recurrence_series_id,
    // recurrence_master_id field dropped from the projection — the
    // canonical link is recurrence_series_id (one direction).
    recurrence_index: booking.recurrence_index,
    recurrence_overridden: booking.recurrence_overridden,
    recurrence_skipped: booking.recurrence_skipped,
    linked_order_id: null,
    approval_id: null,
    setup_buffer_minutes: slot.setup_buffer_minutes,
    teardown_buffer_minutes: slot.teardown_buffer_minutes,
    effective_start_at: slot.effective_start_at,
    effective_end_at: slot.effective_end_at,
    check_in_required: slot.check_in_required,
    check_in_grace_minutes: slot.check_in_grace_minutes,
    checked_in_at: slot.checked_in_at,
    released_at: slot.released_at,
    cancellation_grace_until: slot.cancellation_grace_until,
    policy_snapshot: booking.policy_snapshot,
    applied_rule_ids: booking.applied_rule_ids,
    source: booking.source as ReservationSource,
    booked_by_user_id: booking.booked_by_user_id,
    cost_amount_snapshot: booking.cost_amount_snapshot,
    // multi_room_group_id field dropped from the projection — multi-room
    // atomicity is expressed via shared booking_id on slots.
    calendar_event_id: booking.calendar_event_id,
    calendar_provider: booking.calendar_provider,
    calendar_etag: booking.calendar_etag,
    calendar_last_synced_at: booking.calendar_last_synced_at,
    // booking_bundle_id field dropped here by slice H6 (00288); the
    // projection no longer emits it. Readers should use Reservation.id
    // directly — the booking IS the bundle (00277:27).
    created_at: booking.created_at,
    updated_at: booking.updated_at,
  };
}

/**
 * Standard PostgREST select string for "give me a slot row plus all the
 * booking fields needed to reconstruct the legacy Reservation shape".
 */
export const SLOT_WITH_BOOKING_SELECT = `
  *,
  bookings!inner (
    id, tenant_id, title, description,
    requester_person_id, host_person_id, booked_by_user_id,
    location_id, start_at, end_at, timezone, status, source,
    cost_center_id, cost_amount_snapshot,
    policy_snapshot, applied_rule_ids, config_release_id,
    calendar_event_id, calendar_provider, calendar_etag, calendar_last_synced_at,
    recurrence_series_id, recurrence_index, recurrence_overridden, recurrence_skipped,
    template_id, created_at, updated_at
  )
`;
