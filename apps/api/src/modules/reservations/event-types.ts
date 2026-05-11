/**
 * Outbox event-type literals emitted by the booking edit pipeline (B.4).
 *
 * Convention matches the vendor-portal / daily-list / privacy-compliance
 * pattern (`<domain>.<verb>`). Wired through `OutboxService.emit()`.
 *
 * Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.4 step 9.
 *
 * Each event is fire-and-forget at emit time; the corresponding handler
 * ships with the consumer step (B.4.A.2+). Until then an emit will
 * dead-letter at the worker with `no_handler_registered` — that's the
 * intended behaviour while registry-only.
 */
export const BookingEditEventType = {
  /** Slot space_id changed; downstream cascade: catering delivery, work-orders. */
  LocationChanged:   'booking.location_changed',

  /** cost_amount_snapshot delta non-zero; downstream cascade: reporting. */
  CostChanged:       'booking.cost_changed',

  /** Edit flipped rule resolver final → require_approval; chain inserted. */
  ApprovalRequired:  'booking.approval_required',
} as const;

export type BookingEditEventType =
  (typeof BookingEditEventType)[keyof typeof BookingEditEventType];
