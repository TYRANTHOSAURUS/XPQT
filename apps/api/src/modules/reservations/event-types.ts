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

/**
 * Booking lifecycle outbox event types (Universal Workflow Architecture
 * Phase 1.A — `docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md`).
 *
 * SIBLING of `BookingEditEventType` — kept separate so the BookingEdit
 * shape stays tightly scoped to the edit pipeline (00364 emitter +
 * BookingApprovalRequiredHandler subscriber). Lifecycle events are the
 * create/cancel/status-transition surface that the universal workflow
 * Tier 2 wake mechanism subscribes to.
 *
 * Producer migrations (Phase 1.A):
 *   - `Created`        → 00372_create_booking_emit_lifecycle.sql
 *   - `Cancelled`      → 00373_delete_booking_emit_cancelled.sql
 *   - `StatusChanged`  → reserved for Phase 2 (`transition_booking_status`
 *                          RPC ships with the booking-side primary nodes).
 *                          Registered HERE today so the wake handler can
 *                          subscribe via @OutboxHandler at module-init time
 *                          and start consuming the moment the Phase 2 RPC
 *                          ships its first emit. Pre-Phase-2 there's no
 *                          producer yet — the literal sits idle, no events,
 *                          no dead-letters.
 *
 * Consumer:
 *   - `WorkflowSpawnWakeHandler` (apps/api/src/modules/outbox/handlers/
 *     workflow-spawn-wake.handler.ts) registers one @OutboxHandler decorator
 *     per literal and consults `workflow_instance_links` (00370) to wake
 *     any parent workflow_instance waiting on the booking entity.
 */
export const BookingLifecycleEventType = {
  /**
   * Booking row inserted by `create_booking_with_attach_plan` (00372).
   * Payload: { tenant_id, booking_id, location_id, requester_person_id,
   *            host_person_id, status, started_at }.
   *
   * Wake semantics (spec §3.5): a parent workflow_instance waiting with
   * `wait_for='entity_status'` and `entity_terminal_statuses` containing
   * the new booking's status (rare for `Created` — most parents wait for
   * `confirmed`/`checked_in` which are status changes, not creation) gets
   * resumed on the `created` branch.
   */
  Created:        'booking.created',

  /**
   * Booking row deleted by `delete_booking_with_guard` (00373) on the
   * rolled_back path. Payload: { tenant_id, booking_id, reason,
   * started_at }.
   *
   * Wake semantics (spec §3.5 + §3.6): any parent workflow_instance_link
   * with `child_entity_id = booking_id`, `spawn_mode='wait'`,
   * `resolved_at IS NULL` is atomically claimed and the parent resumes on
   * the `cancelled` branch. This is the wake half of the cancellation
   * propagation pattern (the OTHER half, parent-cancelled-cascading-to-
   * child, is generalised in Phase 1.B's cancelInstance refactor).
   */
  Cancelled:      'booking.cancelled',

  /**
   * Booking status transition (e.g. confirmed → checked_in → released).
   * NO PRODUCER YET — Phase 2 ships `transition_booking_status` RPC
   * which will emit this event. Registered today so the wake handler
   * subscribes at Phase 1.A time without a separate code change at
   * Phase 2 cutover.
   *
   * Wake semantics (spec §3.5): a parent workflow_instance waiting with
   * `wait_for='entity_status'` and `entity_terminal_statuses` containing
   * the new status gets resumed on a branch named for the new status
   * (e.g. 'confirmed', 'checked_in', 'released'). Payload (Phase 2 spec):
   * { tenant_id, booking_id, from_status, to_status, started_at }.
   */
  StatusChanged:  'booking.status_changed',
} as const;

export type BookingLifecycleEventType =
  (typeof BookingLifecycleEventType)[keyof typeof BookingLifecycleEventType];
