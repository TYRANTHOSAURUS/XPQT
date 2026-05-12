/**
 * Typed outbox event-type constants for the booking edit pipeline (B.4).
 *
 * Convention matches the vendor-portal / daily-list / privacy-compliance
 * pattern (`<domain>.<verb>`). These are producer-side typed constants for
 * typo safety on the TS layer; handlers register against the same string
 * literals on the consumer side.
 *
 * Emission pattern (B.0 cutover):
 *   The outbox row is inserted inside the producer RPC body via
 *   `perform outbox.emit(...)` in PL/pgSQL — same transaction as the domain
 *   mutation. See migrations 00309 (`create_booking_with_attach_plan`) and
 *   00310 (`grant_booking_approval`) for the canonical pattern. The TS-side
 *   `OutboxService.emit()` surface is `@deprecated` (see
 *   `apps/api/src/modules/outbox/outbox.service.ts:10-19`); do NOT add new
 *   TS-side producers. The B.4 edit RPC will emit these events from inside
 *   its PL/pgSQL body when it lands.
 *
 * Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.4 step 9.
 *
 * Until a handler registers for a given event type, an emit will dead-letter
 * at the worker with `no_handler_registered` — that's the intended behaviour
 * while registry-only. See per-event notes below for blast-radius differences.
 */
export const BookingEditEventType = {
  /**
   * Slot space_id changed; downstream cascade: catering delivery,
   * work-orders. Notification/audit-class — dead-lettering until handler
   * registration is benign (no user-visible regression).
   */
  LocationChanged:   'booking.location_changed',

  /**
   * cost_amount_snapshot delta non-zero; downstream cascade: reporting.
   * Notification/audit-class — dead-lettering until handler registration
   * is benign (no user-visible regression).
   */
  CostChanged:       'booking.cost_changed',

  /**
   * Edit flipped rule resolver final → require_approval; chain inserted.
   *
   * Handler status (post-B.4.A.4): `BookingApprovalRequiredHandler` is
   * registered as a v1 STUB (validates payload + tenant boundary, logs,
   * returns). The dead-letter shape `no_handler_registered` is no longer
   * the failure mode — the new failure mode is **ack-without-notification**:
   * the handler accepts the event and the chain row sits in `pending`, but
   * no email / in-app notification fires until B.4.A.5 ships notification
   * dispatch. Callers triggering row 2/7/8 emits today are commits without
   * an approver-side surface. See `docs/follow-ups/b4-followups.md` for
   * the controller-vs-notification sequencing invariant.
   */
  ApprovalRequired:  'booking.approval_required',
} as const;

export type BookingEditEventType =
  (typeof BookingEditEventType)[keyof typeof BookingEditEventType];
