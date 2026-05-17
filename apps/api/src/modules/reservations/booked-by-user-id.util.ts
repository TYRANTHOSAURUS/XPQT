import type { ActorContext } from './dto/types';

/**
 * Booking-audit Slice 7 — discovered finding D-8 (pre-existing P1, NOT
 * Slice-7-caused; git-blame: the failing binds + `SYSTEM_ACTOR` landed
 * 2026-04-25 phase G/H, three weeks before Slice 7).
 *
 * `bookings.booked_by_user_id` + the `create_booking` /
 * `create_booking_with_attach_plan` booker params are `uuid` and NULLABLE
 * (00277:38 nullable FK → users.id; 00277:251 `p_booked_by_user_id uuid
 * default null`; 00309:151 / 00315:135 `nullif(...,'')::uuid`). The
 * SYNTHETIC system actors carry a sentinel `user_id` that is NOT a uuid:
 *   - `RecurrenceService.SYSTEM_ACTOR.user_id = 'system:recurrence'`
 *     (recurrence.service.ts:99-100) — materialiser + nightly rollover.
 *   - the Outlook-sync actor `user_id = 'system:outlook:<event_id>'`
 *     (reservations.module.ts:~190) — calendar inbound create.
 * Both flow through `BookingFlowService.create(..., actor)`. Binding
 * `actor.user_id` straight onto the uuid param 500s on supabase-js /
 * PostgREST (`invalid input syntax for type uuid: "system:..."`) BEFORE
 * the SQL runs, so EVERY recurrence-materialised occurrence (and every
 * Outlook-created booking) failed to insert — recurring bookings have
 * silently materialised ZERO occurrences via the HTTP entrypoint since
 * 2026-04-25.
 *
 * A system-materialised / calendar-synced booking has no human booker, so
 * the correct `booked_by_user_id` is NULL (the column + RPC params are
 * nullable by design — the attach-plan family already does
 * `nullif(...)::uuid`). This mirrors the sibling guard
 * `RecurrenceService.actorAuthUidForRpc` (recurrence.service.ts:120-124,
 * `system:*` → null for the F-CRIT-1 split RPCs). A genuine JWT `user_id`
 * (always a uuid — no human/JWT actor is ever `system:`-prefixed) passes
 * through unchanged, so the only behavioural effect is nulling a
 * synthetic booker that could never have been a valid uuid anyway.
 *
 * Applied at every create-RPC booker bind: the no-services `create_booking`
 * path + the `create_booking_with_attach_plan` input
 * (booking-flow.service.ts) AND the multi-room
 * `create_booking_with_attach_plan` input (multi-room-booking.service.ts).
 */
export function bookedByUserIdForRpc(actor: ActorContext): string | null {
  const uid = actor.user_id;
  if (!uid || uid.startsWith('system:')) return null;
  return uid;
}
