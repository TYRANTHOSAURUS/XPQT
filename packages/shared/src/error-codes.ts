/**
 * Error code registry — Phase 7.A.1 foundation.
 *
 * Single source of truth for the wire-shape `code` field. Server emits codes
 * from this union via `AppError`; client looks them up in
 * `messages.<locale>.ts` to render user-visible copy.
 *
 * Reading order:
 *   1. `docs/superpowers/specs/2026-05-02-error-handling-system-design.md` §3.1, §5
 *   2. `docs/follow-ups/phase-7-error-codes.md` (Phase 1 codes registered here)
 *
 * Adding a code = one PR that:
 *   - Adds the literal to `KnownErrorCode`.
 *   - Adds an English message in `apps/api/src/common/errors/messages.en.ts`.
 *   - (Wave 4+) Adds Dutch in `messages.nl.ts`.
 *
 * Voice rules for messages live alongside `messages.en.ts`. Codes are
 * dot-namespaced by domain (`<entity>.<reason>`) per spec §5.
 */

/** Coarse error class — drives surface + recovery selection per spec §3.3. */
export type ErrorClass =
  | 'transport'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limit'
  | 'server'
  | 'realtime'
  | 'render'
  | 'unknown';

/**
 * Every error code emitted by the server. The string-literal union is the
 * registry. The filter validates emitted codes against this set; messages
 * lookup is keyed by the same union.
 */
export type KnownErrorCode =
  // ─── auth / permission ──────────────────────────────────────────────────
  | 'auth.unauthorized'
  | 'auth.expired'
  | 'auth.invalid'
  | 'permission.denied'
  | 'permission.missing_role'

  // ─── generic legacy buckets (filter mapping for un-coded throws) ─────────
  | 'generic.bad_request'
  | 'generic.unauthorized'
  | 'generic.forbidden'
  | 'generic.not_found'
  | 'generic.conflict'

  // ─── validation ──────────────────────────────────────────────────────────
  | 'validation.failed'

  // ─── rate limit / quota / request ────────────────────────────────────────
  | 'rate_limit.exceeded'
  | 'quota.exceeded'
  | 'request.too_large'
  | 'request.cancelled'

  // ─── network / transport (used client-side; registered for symmetry) ─────
  | 'network.offline'
  | 'network.timeout'

  // ─── db (pg / PostgREST) — never leak SQL ────────────────────────────────
  | 'db.constraint'
  | 'db.unique_violation'
  | 'db.fk_violation'
  | 'db.deadlock'

  // ─── third-party (vendor names never leak) ───────────────────────────────
  | 'email.dispatch_failed'
  | 'realtime.unavailable'

  // ─── render / unknown last-resort ────────────────────────────────────────
  | 'render.failed'
  | 'unknown.server_error'

  // ─── Phase 1 registered codes (per docs/follow-ups/phase-7-error-codes.md) ─
  | 'work_order.plan_invalid'
  | 'booking.slot_conflict'
  | 'booking_slot.not_found'
  | 'booking_slot.url_mismatch'
  | 'booking.edit_forbidden'
  | 'booking.partial_failure'
  | 'booking.compensation_failed'
  | 'booking.slot_space_invalid'
  | 'booking.slot_update_failed'
  | 'booking.invalid_attendee_count'
  | 'booking.invalid_attendee_person_ids'
  | 'booking.invalid_window'
  | 'reference.not_in_tenant'
  | 'reference.lookup_failed'
  | 'reference.invalid_uuid'
  | 'reference.too_many'
  | 'workflow.update_ticket_field_not_allowed'
  | 'outbox.idempotency_collision'
  | 'outbox.tenant_id_required'
  | 'outbox.idempotency_key_required'
  | 'setup_wo.requester_person_id_not_allowed'
  | 'setup_wo.fk_invalid'

  // ─── ticket / booking domain codes for Phase 7.B mapping ────────────────
  | 'ticket.not_found'
  | 'ticket.title_required'
  | 'ticket.assignment_invalid'
  | 'ticket.routing_no_match'

  // ─── ticket module migration (Phase 7.A.2.a) ─────────────────────────────
  | 'ticket.bulk_cap_exceeded'
  | 'ticket.no_writable_in_selection'
  | 'ticket.case_sla_immutable'
  | 'ticket.cannot_reassign_to_same'
  | 'ticket.tags_invalid'
  | 'ticket.watchers_invalid'
  | 'ticket.no_files_uploaded'
  | 'ticket.visibility_trace_forbidden'
  | 'ticket.write_forbidden'
  | 'ticket.read_forbidden'
  | 'ticket.plan_forbidden'
  | 'ticket.bulk_update_invalid'
  | 'ticket.reassignment_reason_required'
  | 'ticket.children_open_cannot_close'
  | 'ticket.priority_change_forbidden'
  | 'ticket.assign_forbidden'
  | 'ticket.cannot_reclassify_child'
  | 'ticket.terminal_cannot_reclassify'

  // ─── reclassify codes ────────────────────────────────────────────────────
  | 'reclassify.target_not_found'
  | 'reclassify.target_inactive'
  | 'reclassify.target_same'
  | 'reclassify.reason_too_short'
  | 'reclassify.reason_too_long'
  | 'reclassify.in_progress_collision'
  | 'reclassify.in_progress_children_unacked'
  | 'reclassify.terminal_state'
  | 'reclassify.work_order_target'
  | 'reclassify.actor_not_resolvable'

  // ─── dispatch codes ──────────────────────────────────────────────────────
  | 'dispatch.title_required'
  | 'dispatch.from_work_order'
  | 'dispatch.parent_pending_approval'
  | 'dispatch.assignment_required'
  | 'dispatch.parent_terminal'

  | 'booking.conflict'
  | 'booking.window_closed'
  | 'booking.capacity_exceeded'
  | 'booking.permission_denied'
  | 'reservation.version_conflict'
  | 'order.line_invalid'
  | 'routing.no_match'
  | 'routing.cycle_detected'
  | 'sla.policy_invalid'
  | 'vendor.unavailable'
  | 'vendor.not_in_scope'

  // ─── Phase 1 legacy snake_case codes (renamed in Phase 7.A.2) ────────────
  | 'insert_failed'
  | 'reservation_slot_conflict'
  | 'rule_deny'
  | 'override_reason_required'
  | 'multi_room_recurrence_unsupported'
  | 'wrong_endpoint'
  | 'recurrence_unavailable'
  | 'edit_scope_failed'
  | 'not_recurring'
  | 'reservation_write_forbidden'
  | 'invalid_input'
  | 'space_not_found'
  | 'space_inactive'
  | 'space_not_reservable'
  | 'permission_denied';

/**
 * Runtime set of registered codes. Filter uses this to validate every
 * emitted code; messages.en.ts uses it as the key set for the English
 * mapping. Build fails if either drifts.
 */
export const KNOWN_ERROR_CODES: ReadonlySet<KnownErrorCode> = new Set<KnownErrorCode>([
  'auth.unauthorized',
  'auth.expired',
  'auth.invalid',
  'permission.denied',
  'permission.missing_role',
  'generic.bad_request',
  'generic.unauthorized',
  'generic.forbidden',
  'generic.not_found',
  'generic.conflict',
  'validation.failed',
  'rate_limit.exceeded',
  'quota.exceeded',
  'request.too_large',
  'request.cancelled',
  'network.offline',
  'network.timeout',
  'db.constraint',
  'db.unique_violation',
  'db.fk_violation',
  'db.deadlock',
  'email.dispatch_failed',
  'realtime.unavailable',
  'render.failed',
  'unknown.server_error',
  'work_order.plan_invalid',
  'booking.slot_conflict',
  'booking_slot.not_found',
  'booking_slot.url_mismatch',
  'booking.edit_forbidden',
  'booking.partial_failure',
  'booking.compensation_failed',
  'booking.slot_space_invalid',
  'booking.slot_update_failed',
  'booking.invalid_attendee_count',
  'booking.invalid_attendee_person_ids',
  'booking.invalid_window',
  'reference.not_in_tenant',
  'reference.lookup_failed',
  'reference.invalid_uuid',
  'reference.too_many',
  'workflow.update_ticket_field_not_allowed',
  'outbox.idempotency_collision',
  'outbox.tenant_id_required',
  'outbox.idempotency_key_required',
  'setup_wo.requester_person_id_not_allowed',
  'setup_wo.fk_invalid',
  'ticket.not_found',
  'ticket.title_required',
  'ticket.assignment_invalid',
  'ticket.routing_no_match',
  'ticket.bulk_cap_exceeded',
  'ticket.no_writable_in_selection',
  'ticket.case_sla_immutable',
  'ticket.cannot_reassign_to_same',
  'ticket.tags_invalid',
  'ticket.watchers_invalid',
  'ticket.no_files_uploaded',
  'ticket.visibility_trace_forbidden',
  'ticket.write_forbidden',
  'ticket.read_forbidden',
  'ticket.plan_forbidden',
  'ticket.bulk_update_invalid',
  'ticket.reassignment_reason_required',
  'ticket.children_open_cannot_close',
  'ticket.priority_change_forbidden',
  'ticket.assign_forbidden',
  'ticket.cannot_reclassify_child',
  'ticket.terminal_cannot_reclassify',
  'reclassify.target_not_found',
  'reclassify.target_inactive',
  'reclassify.target_same',
  'reclassify.reason_too_short',
  'reclassify.reason_too_long',
  'reclassify.in_progress_collision',
  'reclassify.in_progress_children_unacked',
  'reclassify.terminal_state',
  'reclassify.work_order_target',
  'reclassify.actor_not_resolvable',
  'dispatch.title_required',
  'dispatch.from_work_order',
  'dispatch.parent_pending_approval',
  'dispatch.assignment_required',
  'dispatch.parent_terminal',
  'booking.conflict',
  'booking.window_closed',
  'booking.capacity_exceeded',
  'booking.permission_denied',
  'reservation.version_conflict',
  'order.line_invalid',
  'routing.no_match',
  'routing.cycle_detected',
  'sla.policy_invalid',
  'vendor.unavailable',
  'vendor.not_in_scope',
  'insert_failed',
  'reservation_slot_conflict',
  'rule_deny',
  'override_reason_required',
  'multi_room_recurrence_unsupported',
  'wrong_endpoint',
  'recurrence_unavailable',
  'edit_scope_failed',
  'not_recurring',
  'reservation_write_forbidden',
  'invalid_input',
  'space_not_found',
  'space_inactive',
  'space_not_reservable',
  'permission_denied',
]);

/** Type-guard: is `code` a registered KnownErrorCode? */
export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN_ERROR_CODES.has(code as KnownErrorCode);
}
