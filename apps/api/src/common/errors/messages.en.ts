/**
 * English error messages — keyed by `code`.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *   §3.4 (voice rules), §5 (registry), §6.5 (i18n).
 *
 * Voice rules (toast surface):
 *   - Title is what the user sees. Use "Couldn't <verb> <thing>." for
 *     errors. Neutral, human, no exclamation marks.
 *   - Detail is an optional one-line clarification.
 *   - NEVER include vendor names (Resend, Supabase, Stripe, Postgres).
 *   - NEVER include SQL fragments or stack frames.
 *   - For non-user-visible internal codes (outbox.*, setup_wo.*) we still
 *     register a generic ops-friendly message; the renderer falls back to
 *     `unknown.server_error` copy when the surface is user-facing.
 *
 * The renderer NEVER displays the server's `detail` verbatim — fail-closed
 * per decision #9. This map is the only path to user-visible copy for any
 * registered code.
 */

import type { KnownErrorCode } from '@prequest/shared';

export type ErrorMessage = {
  title: string;
  detail?: string;
};

export const ERROR_MESSAGES_EN: Record<KnownErrorCode, ErrorMessage> = {
  // ─── auth / permission ──────────────────────────────────────────────────
  'auth.unauthorized': {
    title: 'Sign in to continue',
    detail: 'Your session needs a fresh sign-in.',
  },
  'auth.expired': {
    title: 'Your session expired',
    detail: 'Sign in again to continue where you left off.',
  },
  'auth.invalid': {
    title: 'Sign-in failed',
    detail: 'Those credentials didn\'t work. Try again.',
  },
  'permission.denied': {
    title: "You don't have access to this",
    detail: 'Ask an admin if you need access.',
  },
  'permission.missing_role': {
    title: "You don't have access to this",
    detail: 'Your role is missing the permission for this action.',
  },

  // ─── generic legacy buckets ──────────────────────────────────────────────
  'generic.bad_request': {
    title: "Couldn't complete that",
    detail: 'The request was rejected.',
  },
  'generic.unauthorized': {
    title: 'Sign in to continue',
  },
  'generic.forbidden': {
    title: "You don't have access to this",
  },
  'generic.not_found': {
    title: "We can't find that",
  },
  'generic.conflict': {
    title: 'Something else changed',
    detail: 'This was updated by someone else. Reload and try again.',
  },

  // ─── validation ──────────────────────────────────────────────────────────
  'validation.failed': {
    title: 'Some fields need attention',
  },

  // ─── rate limit / quota / request ────────────────────────────────────────
  'rate_limit.exceeded': {
    title: 'Too many requests',
    detail: 'Slow down for a moment, then try again.',
  },
  'quota.exceeded': {
    title: 'Quota exceeded',
    detail: 'You\'ve hit a usage limit on this workspace.',
  },
  'request.too_large': {
    title: 'That request is too large',
    detail: 'Try a smaller payload or fewer items.',
  },
  'request.cancelled': {
    title: 'Request cancelled',
  },

  // ─── network ─────────────────────────────────────────────────────────────
  'network.offline': {
    title: 'You\'re offline',
    detail: 'Changes will sync when you reconnect.',
  },
  'network.timeout': {
    title: "Couldn't reach the server",
    detail: 'The request timed out. Try again.',
  },

  // ─── db (never leak SQL) ─────────────────────────────────────────────────
  'db.constraint': {
    title: "Couldn't save",
    detail: 'A data rule blocked this change.',
  },
  'db.unique_violation': {
    title: 'Already exists',
    detail: 'Something with that identifier already exists.',
  },
  'db.fk_violation': {
    title: "Couldn't save",
    detail: 'This refers to something that no longer exists.',
  },
  'db.deadlock': {
    title: "Couldn't save — try again",
    detail: 'Two changes collided. The retry usually works.',
  },

  // ─── third-party (no vendor names) ───────────────────────────────────────
  'email.dispatch_failed': {
    title: "Couldn't send the email",
    detail: 'The email service rejected the message. Try again later.',
  },
  'realtime.unavailable': {
    title: 'Live updates are paused',
    detail: 'Reconnecting in the background.',
  },

  // ─── render / unknown ────────────────────────────────────────────────────
  'render.failed': {
    title: 'Something went wrong on this page',
    detail: 'Reload the page to recover.',
  },
  'unknown.server_error': {
    title: 'Something went wrong on our end',
    detail: 'Try again. If it keeps happening, contact support with the trace ID.',
  },

  // ─── Phase 1 registered codes ────────────────────────────────────────────
  'work_order.plan_invalid': {
    title: "Couldn't create work order",
    detail: 'The plan has missing or invalid fields.',
  },
  'booking.slot_conflict': {
    title: "Couldn't book — time conflict",
    detail: 'The selected room is already booked for that time.',
  },
  'booking_slot.not_found': {
    title: "Couldn't find that booking slot",
  },
  'booking_slot.url_mismatch': {
    title: "Couldn't update that slot",
    detail: 'The slot in the URL doesn\'t match the body.',
  },
  'booking.edit_forbidden': {
    title: "You can't edit this booking",
  },
  'booking.partial_failure': {
    // I3: reclassified to server-class per phase-7-error-codes.md line 101.
    title: "Couldn't fully save the booking",
    detail: 'Some parts didn\'t save and rollback was blocked. Contact support with the trace ID.',
  },
  'booking.compensation_failed': {
    title: "Couldn't fully roll back the booking",
    detail: 'A cleanup step failed. Contact support with the trace ID.',
  },
  'booking.slot_space_invalid': {
    title: "Couldn't update — invalid space",
    detail: 'That space isn\'t valid for this slot.',
  },
  'booking.slot_update_failed': {
    title: "Couldn't update that slot",
  },
  'booking.invalid_attendee_count': {
    title: "Couldn't update — attendee count invalid",
  },
  'booking.invalid_attendee_person_ids': {
    title: "Couldn't update — invalid attendees",
  },
  'booking.invalid_window': {
    title: "Couldn't update — invalid time window",
    detail: 'Check the start and end times.',
  },
  'reference.not_in_tenant': {
    title: "Couldn't save — referenced item not available",
    detail: 'One of the references doesn\'t exist in this workspace.',
  },
  'reference.lookup_failed': {
    title: "Couldn't validate references",
    detail: 'Try again in a moment.',
  },
  'reference.invalid_uuid': {
    title: "Couldn't save — invalid reference",
    detail: 'A required identifier is malformed.',
  },
  'reference.too_many': {
    title: "Couldn't save — too many references",
    detail: 'Reduce the number of items and try again.',
  },
  'workflow.update_ticket_field_not_allowed': {
    title: "Couldn't update — field not allowed",
    detail: 'That field can\'t be changed by this workflow step.',
  },
  'outbox.idempotency_collision': {
    title: 'Duplicate event suppressed',
  },
  'outbox.tenant_id_required': {
    title: "Couldn't emit — missing workspace",
  },
  'outbox.idempotency_key_required': {
    title: "Couldn't emit — missing event key",
  },
  'setup_wo.requester_person_id_not_allowed': {
    title: "Couldn't create setup work order",
  },
  'setup_wo.fk_invalid': {
    title: "Couldn't create setup work order",
    detail: 'A reference is invalid.',
  },

  // ─── ticket / booking ────────────────────────────────────────────────────
  'ticket.not_found': {
    title: "We can't find that ticket",
  },
  'ticket.title_required': {
    title: "Couldn't save — title required",
  },
  'ticket.assignment_invalid': {
    title: "Couldn't assign — pick someone else",
    detail: 'That assignee can\'t take this ticket.',
  },
  'ticket.routing_no_match': {
    title: "Couldn't route — no team matches",
  },
  'booking.conflict': {
    title: "Couldn't book — conflict",
  },
  'booking.window_closed': {
    title: 'Booking window is closed',
  },
  'booking.capacity_exceeded': {
    title: 'Capacity exceeded',
    detail: 'Pick a larger room or remove attendees.',
  },
  'booking.permission_denied': {
    title: "You can't book this room",
  },
  'reservation.version_conflict': {
    title: 'This was changed by someone else',
    detail: 'Reload to see the latest version.',
  },
  'order.line_invalid': {
    title: "Couldn't add — invalid line",
  },
  'routing.no_match': {
    title: "Couldn't route — no match",
  },
  'routing.cycle_detected': {
    title: 'Routing loop detected',
  },
  'sla.policy_invalid': {
    title: "Couldn't apply SLA — policy invalid",
  },
  'sla.threshold_invalid': {
    title: "Couldn't save — escalation threshold invalid",
    detail: 'Check the threshold values and try again.',
  },
  'sla.target_missing': {
    title: "Couldn't update SLA — target not found",
  },

  // ─── booking-bundles module (Phase 7.A.2.c.i) ────────────────────────────
  'bundle.forbidden': {
    title: "You don't have access to this booking",
  },
  'bundle.not_found': {
    title: "We can't find that booking",
  },
  'bundle.no_services': {
    title: "Couldn't save — no service lines provided",
  },
  'bundle.line_not_in_bundle': {
    title: "Couldn't cancel — line isn't part of a booking",
  },
  'bundle.invalid_quantity': {
    title: "Couldn't save — quantity invalid",
  },
  'bundle.invalid_service_window': {
    title: "Couldn't save — service window invalid",
    detail: 'Provide valid start and end times.',
  },
  'bundle.invalid_requester_notes': {
    title: "Couldn't save — notes invalid",
    detail: 'Notes must be 2000 characters or fewer.',
  },
  'bundle.invalid_expected_updated_at': {
    title: "Couldn't save — version token invalid",
  },
  'bundle.lead_time_violation': {
    title: "Couldn't add — not enough lead time",
    detail: 'Move the meeting later or remove this service.',
  },
  'bundle.context_lookup_failed': {
    title: 'Something went wrong on our end',
    detail: 'Try again. If it keeps happening, contact support with the trace ID.',
  },
  'bundle.idempotency_key_required': {
    title: "Couldn't save — missing idempotency key",
  },
  'bundle.tenant_id_required': {
    title: 'Something went wrong on our end',
    detail: 'Missing workspace context. Try again.',
  },
  'booking.not_found': {
    title: "We can't find that booking",
  },
  'asset.not_found': {
    title: "We can't find that asset",
  },
  'catalog_item.not_found': {
    title: "We can't find that catalog item",
  },
  'plan.idempotency_key_required': {
    title: 'Something went wrong on our end',
    detail: 'Missing idempotency key. Try again.',
  },
  'plan.stable_index_required': {
    title: 'Something went wrong on our end',
    detail: 'Missing stable index. Try again.',
  },
  'plan.client_line_id_required': {
    title: 'Something went wrong on our end',
    detail: 'Missing client line id. Try again.',
  },
  service_rule_deny: {
    title: "Couldn't book — a rule blocked it",
  },
  asset_conflict: {
    title: "Couldn't book — asset already reserved",
    detail: 'A requested asset is already reserved for that window.',
  },
  line_not_found: {
    title: "We can't find that line",
  },
  line_state_changed: {
    title: 'This line was updated by someone else',
    detail: 'Reload to see the latest state.',
  },
  line_frozen: {
    title: "Couldn't edit — line already in fulfillment",
    detail: 'Cancel and re-add instead.',
  },
  line_already_fulfilled: {
    title: "Couldn't cancel — line has been fulfilled",
    detail: 'Contact the fulfillment team if needed.',
  },
  client_line_id_required: {
    title: "Couldn't save — missing client line id",
  },
  client_line_id_not_unique: {
    title: "Couldn't save — duplicate client line id",
  },

  // ─── reservations module (Phase 7.A.2.c.ii) ──────────────────────────────
  'booking.idempotency_payload_mismatch': {
    title: "Couldn't save — idempotency mismatch",
    detail: 'A retry sent a different payload than the original request.',
  },
  'booking.fk_invalid': {
    title: "Couldn't save — invalid reference",
    detail: 'A referenced item is missing or in a different workspace.',
  },
  'booking.internal_ref_invalid': {
    title: "Couldn't save — internal reference invalid",
  },
  'booking.snapshot_uuid_invalid': {
    title: "Couldn't save — snapshot reference invalid",
  },
  'booking.unexpected_error': {
    title: "Couldn't save the booking",
    detail: 'Try again. If it keeps happening, contact support with the trace ID.',
  },
  'booking.idempotency_key_required': {
    title: "Couldn't save — missing idempotency key",
  },
  'booking.completed_cannot_edit': {
    title: "Couldn't edit — booking is completed",
  },
  'booking.not_editable': {
    title: "You can't edit this booking",
  },
  'booking.not_cancelled': {
    title: "Couldn't restore — booking isn't cancelled",
  },
  'booking.cancellation_grace_expired': {
    title: "Couldn't restore — grace window expired",
  },
  'booking.slot_taken': {
    title: "Couldn't restore — slot is taken",
  },
  'booking.not_a_recurring_occurrence': {
    title: "Couldn't update — not a recurring occurrence",
  },
  'booking.too_early_to_check_in': {
    title: "It's too early to check in",
  },
  'booking.already_ended': {
    title: 'This booking has already ended',
  },
  'booking.already_checked_in': {
    title: 'Already checked in',
  },
  'booking.not_confirmed': {
    title: "Couldn't check in — booking not confirmed",
  },
  'booking.check_in_failed': {
    title: "Couldn't check in",
  },
  'booking.magic_link_invalid': {
    title: 'That check-in link is invalid',
  },
  'booking.magic_link_booking_mismatch': {
    title: 'That check-in link is for a different booking',
  },
  'booking.magic_link_person_mismatch': {
    title: 'That check-in link is for a different person',
  },
  'booking.scheduler_window_requires_range': {
    title: "Couldn't load — date range required",
  },
  'booking.no_primary_slot': {
    title: "Couldn't edit — no primary slot",
  },
  'booking.edit_failed': {
    title: "Couldn't save the changes",
  },
  'booking.list_failed': {
    title: "Couldn't load the bookings",
  },
  'booking.cancel_failed': {
    title: "Couldn't cancel the booking",
  },
  'booking.skip_failed': {
    title: "Couldn't skip the occurrence",
  },
  'booking.restore_failed': {
    title: "Couldn't restore the booking",
  },
  'booking.scheduler_window_failed': {
    title: "Couldn't load the scheduler window",
  },
  'booking.bundle_not_injected': {
    title: 'Something went wrong on our end',
    detail: 'Bundle service not configured. Contact support with the trace ID.',
  },
  'booking.recurrence_not_injected': {
    title: 'Something went wrong on our end',
    detail: 'Recurrence service not configured. Contact support with the trace ID.',
  },
  'booking.recurrence_series_not_found': {
    title: "Couldn't find that recurrence series",
  },
  'booking.master_not_found': {
    title: "Couldn't find the master booking",
  },
  'booking.recurrence_failed': {
    title: "Couldn't update the recurrence",
  },
  'reservation.projection_no_parent': {
    title: 'Something went wrong on our end',
    detail: 'A booking row was returned without its parent. Contact support with the trace ID.',
  },
  'auth.missing_user': {
    title: 'Sign in to continue',
  },
  'magic_check_in.secret_missing': {
    title: 'Something went wrong on our end',
    detail: 'Magic check-in is misconfigured.',
  },
  // legacy snake_case codes (already asserted in specs)
  book_on_behalf_forbidden: {
    title: "You can't book on behalf of another person",
  },
  multi_room_booking_failed: {
    title: "Couldn't book the rooms",
  },
  multi_room_requires_two: {
    title: "Couldn't book — at least two rooms required",
  },
  multi_room_too_many: {
    title: "Couldn't book — too many rooms",
    detail: 'Multi-room bookings are limited to 10 spaces.',
  },
  multi_room_create_failed: {
    title: "Couldn't book the rooms",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  multi_room_read_failed: {
    title: "Couldn't load the booking",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  rule_deny: {
    title: "Couldn't book — a rule blocked it",
  },
  reservation_not_visible: {
    title: "You don't have access to this booking",
  },
  reservation_operator_required: {
    title: "You need operator access for this view",
  },
  booking_not_found: {
    title: "We can't find that booking",
  },
  booking_not_editable: {
    title: "You can't edit this booking",
  },
  booking_completed: {
    title: 'That booking is completed',
  },
  not_a_recurring_occurrence: {
    title: "Couldn't update — not a recurring occurrence",
  },
  booking_slot_taken: {
    title: "Couldn't restore — slot is taken",
  },
  booking_already_ended: {
    title: 'This booking has already ended',
  },
  booking_too_early_to_check_in: {
    title: "It's too early to check in",
  },
  booking_already_checked_in: {
    title: 'Already checked in',
  },
  booking_not_confirmed: {
    title: "Couldn't check in — booking not confirmed",
  },
  check_in_failed: {
    title: "Couldn't check in",
  },
  magic_link_invalid: {
    title: 'That check-in link is invalid',
  },
  magic_link_booking_mismatch: {
    title: 'That check-in link is for a different booking',
  },
  magic_link_person_mismatch: {
    title: 'That check-in link is for a different person',
  },
  cancellation_grace_expired: {
    title: "Couldn't restore — grace window expired",
  },
  booking_not_cancelled: {
    title: "Couldn't restore — booking isn't cancelled",
  },
  scheduler_window_requires_range: {
    title: "Couldn't load — date range required",
  },
  cancel_failed: {
    title: "Couldn't cancel the booking",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  list_failed: {
    title: "Couldn't load the bookings",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  restore_failed: {
    title: "Couldn't restore the booking",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  skip_failed: {
    title: "Couldn't skip the occurrence",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  edit_failed: {
    title: "Couldn't save the changes",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  group_siblings_failed: {
    title: "Couldn't load the group siblings",
  },
  list_for_operator_failed: {
    title: "Couldn't load the bookings",
  },
  list_for_operator_orders: {
    title: "Couldn't load related orders",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  load_spaces_failed: {
    title: "Couldn't load the spaces",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  scheduler_window_failed: {
    title: "Couldn't load the scheduler window",
  },
  reservation_not_editable: {
    title: "You can't edit this booking",
  },
  missing_user: {
    title: 'Sign in to continue',
  },

  // ─── approval module (Phase 7.A.2.d) ─────────────────────────────────────
  'approval.not_found': {
    title: "We can't find that approval",
  },
  'approval.already_responded': {
    title: 'Approval already responded to',
  },
  'approval.not_an_approver': {
    title: "You're not an approver for this request",
  },
  'approval.no_person_record': {
    title: "You don't have access to this",
    detail: 'No person record is linked to your account.',
  },
  'approval.cross_actor_pending': {
    title: "You don't have access to this",
    detail: "You can only see your own pending approvals.",
  },
  'approval.responding_user_required': {
    title: "Couldn't approve — internal user reference missing",
  },
  'approval.grant_failed': {
    title: "Couldn't grant the approval",
    detail: 'Try again. If it keeps happening, contact support with the trace ID.',
  },
  'approval.non_booking_approved': {
    title: "Couldn't grant — wrong approval path for this target",
  },
  'approval.cas_lost': {
    title: 'Approval state changed during grant attempt',
    detail: 'Please retry.',
  },
  'approval.invalid_decision': {
    title: "Couldn't grant — decision must be approved or rejected",
  },
  'vendor.unavailable': {
    title: 'Vendor unavailable',
  },
  'vendor.not_in_scope': {
    title: "Couldn't pick — vendor not eligible",
  },

  // ─── ticket module migration (Phase 7.A.2.a) ─────────────────────────────
  'ticket.bulk_cap_exceeded': {
    title: "Couldn't update — selection too large",
    detail: 'Bulk updates are capped at 200 tickets per call.',
  },
  'ticket.no_writable_in_selection': {
    title: "You can't update any of those tickets",
  },
  'ticket.case_sla_immutable': {
    title: "Couldn't change SLA — parent SLA is locked",
  },
  'ticket.cannot_reassign_to_same': {
    title: "Couldn't reassign — already assigned there",
  },
  'ticket.tags_invalid': {
    title: "Couldn't save — tags invalid",
    detail: 'Tags must be an array of strings.',
  },
  'ticket.watchers_invalid': {
    title: "Couldn't save — watchers invalid",
    detail: 'Watchers must be an array of person identifiers.',
  },
  'ticket.no_files_uploaded': {
    title: "Couldn't upload — no files attached",
  },
  'ticket.visibility_trace_forbidden': {
    title: "You don't have access to this",
  },
  'ticket.write_forbidden': {
    title: "You can't change this ticket",
  },
  'ticket.read_forbidden': {
    title: "You don't have access to this ticket",
  },
  'ticket.plan_forbidden': {
    title: "You can't plan this ticket",
  },
  'ticket.bulk_update_invalid': {
    title: "Couldn't bulk-update — input invalid",
  },
  'ticket.reassignment_reason_required': {
    title: "Couldn't reassign — reason required",
  },
  'ticket.children_open_cannot_close': {
    title: "Couldn't close — open child work orders",
    detail: 'Resolve or close the work orders first.',
  },
  'ticket.priority_change_forbidden': {
    title: "You can't change ticket priority",
  },
  'ticket.assign_forbidden': {
    title: "You can't change ticket assignment",
  },
  'ticket.cannot_reclassify_child': {
    title: "Couldn't reclassify — reclassify the parent instead",
  },
  'ticket.terminal_cannot_reclassify': {
    title: "Couldn't reclassify — ticket is closed or resolved",
  },

  // ─── reclassify ──────────────────────────────────────────────────────────
  'reclassify.target_not_found': {
    title: "Couldn't reclassify — request type not found",
  },
  'reclassify.target_inactive': {
    title: "Couldn't reclassify — request type is inactive",
  },
  'reclassify.target_same': {
    title: "Couldn't reclassify — same request type",
  },
  'reclassify.reason_too_short': {
    title: "Couldn't reclassify — reason too short",
    detail: 'Provide at least 3 characters.',
  },
  'reclassify.reason_too_long': {
    title: "Couldn't reclassify — reason too long",
    detail: 'Keep the reason under 500 characters.',
  },
  'reclassify.in_progress_collision': {
    title: "Couldn't reclassify — another change in progress",
    detail: 'Try again once it finishes.',
  },
  'reclassify.in_progress_children_unacked': {
    title: "Couldn't reclassify — confirm in-progress work orders",
    detail: 'Acknowledge the in-progress child work orders to continue.',
  },
  'reclassify.terminal_state': {
    title: "Couldn't reclassify — ticket is closed or resolved",
  },
  'reclassify.work_order_target': {
    title: "Couldn't reclassify — pick the parent ticket",
  },
  'reclassify.actor_not_resolvable': {
    title: "Couldn't reclassify — actor not in this workspace",
  },

  // ─── dispatch ────────────────────────────────────────────────────────────
  'dispatch.title_required': {
    title: "Couldn't dispatch — title required",
  },
  'dispatch.from_work_order': {
    title: "Couldn't dispatch from a work order",
    detail: 'Dispatch from the parent case instead.',
  },
  'dispatch.parent_pending_approval': {
    title: "Couldn't dispatch — parent is pending approval",
  },
  'dispatch.assignment_required': {
    title: "Couldn't dispatch — assignment required",
  },
  'dispatch.parent_terminal': {
    title: "Couldn't dispatch — parent is closed or resolved",
  },

  // ─── Phase 1 legacy snake_case (renamed in 7.A.2) ────────────────────────
  insert_failed: {
    title: "Couldn't create the booking",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  reservation_slot_conflict: {
    title: "Couldn't book — time conflict",
    detail: 'The selected room is already booked for that time.',
  },
  override_reason_required: {
    title: "Couldn't book — override reason required",
  },
  multi_room_recurrence_unsupported: {
    title: "Couldn't book — recurrence with multiple rooms isn't supported",
  },
  wrong_endpoint: {
    title: "Couldn't update — wrong endpoint",
  },
  recurrence_unavailable: {
    title: 'Recurrence not available here',
  },
  edit_scope_failed: {
    title: "Couldn't apply that edit",
  },
  not_recurring: {
    title: 'This booking isn\'t recurring',
  },
  reservation_write_forbidden: {
    title: "You can't change this booking",
  },
  invalid_input: {
    title: "Couldn't save — input invalid",
  },
  space_not_found: {
    title: "We can't find that space",
  },
  space_inactive: {
    title: 'That space is inactive',
  },
  space_not_reservable: {
    title: 'That space isn\'t bookable',
  },
  permission_denied: {
    title: "You don't have access to this",
  },

  // ─── space module migration (Phase 7.B-1.space) ──────────────────────────
  'space.not_found': {
    title: "Couldn't find that space",
  },
  'space.parent_not_found': {
    title: "Couldn't find the parent space",
  },
  'space.invalid_root_type': {
    title: "Couldn't create that space at the root",
    detail: 'That space type needs a parent.',
  },
  'space.invalid_parent_type': {
    title: "Couldn't place that space under that parent",
    detail: 'That space type isn\'t allowed under that parent.',
  },

  // ─── reporting module migration (Phase 7.B-1.reporting) ──────────────────
  'report.invalid_date_range': {
    title: "Couldn't run that report",
    detail: 'The "from" date must be on or before the "to" date.',
  },
  'report.window_too_large': {
    title: "Couldn't run that report",
    detail: 'Date range is too long. Try 365 days or fewer.',
  },
  'report.rpc_failed': {
    title: "Couldn't run that report",
  },
  'report.invalid_date': {
    title: "Couldn't run that report",
    detail: 'Use a YYYY-MM-DD date.',
  },

  // ─── portal-announcements (Phase 7.B-1.portal-announcements) ─────────────
  'announcement.list_failed': {
    title: "Couldn't load announcements",
  },
  'announcement.publish_failed': {
    title: "Couldn't publish that announcement",
  },
  'announcement.unpublish_failed': {
    title: "Couldn't unpublish that announcement",
  },
  'announcement.invalid_payload': {
    title: "Couldn't publish that announcement",
    detail: 'Location, title, and body are required.',
  },
  'announcement.insert_no_row': {
    title: "Couldn't save that announcement",
  },

  // ─── person (Phase 7.B-1.person) ─────────────────────────────────────────
  'person.org_change_in_progress': {
    title: "Couldn't change that person's organisation",
    detail: 'Another organisation change for this person is in progress. Reload and try again.',
  },

  // ─── org-node (Phase 7.B-1.org-node) ─────────────────────────────────────
  'org_node.not_found': {
    title: "Couldn't find that organisation node",
  },
  'org_node.name_required': {
    title: "Couldn't save that organisation node",
    detail: 'Name is required.',
  },
  'org_node.create_failed': {
    title: "Couldn't create that organisation node",
  },
  'org_node.update_failed': {
    title: "Couldn't update that organisation node",
  },
  'org_node.delete_failed': {
    title: "Couldn't delete that organisation node",
  },
  'org_node.add_member_failed': {
    title: "Couldn't add that member",
  },
  'org_node.add_grant_failed': {
    title: "Couldn't add that location grant",
  },

  // ─── work-orders (Phase 7.B-1.work-orders) ───────────────────────────────
  'work_order.not_found': {
    title: "Couldn't find that work order",
  },
  'work_order.body_required': {
    title: "Couldn't update that work order",
    detail: 'Request body is required.',
  },
  'work_order.empty_update': {
    title: "Couldn't update that work order",
    detail: 'At least one field must change.',
  },
  'work_order.field_invalid': {
    title: "Couldn't update that work order",
    detail: 'One of the fields has the wrong type.',
  },
  'work_order.title_empty': {
    title: "Couldn't update that work order",
    detail: 'Title must not be empty.',
  },
  'work_order.priority_invalid': {
    title: "Couldn't update that work order",
    detail: 'Priority must be low, medium, high, or critical.',
  },
  'work_order.cost_invalid': {
    title: "Couldn't update that work order",
    detail: 'Cost must be a finite number or null.',
  },
  'work_order.tags_invalid': {
    title: "Couldn't update that work order",
    detail: 'Tags must be a list of strings.',
  },
  'work_order.watchers_invalid': {
    title: "Couldn't update that work order",
    detail: 'Watchers must be a list of person ids.',
  },
  'work_order.duration_invalid': {
    title: "Couldn't update that work order",
    detail: 'Planned duration must be a positive whole number of minutes.',
  },
  'work_order.planned_start_invalid': {
    title: "Couldn't update that work order",
    detail: 'Planned start must be a valid timestamp.',
  },
  'work_order.sla_unknown': {
    title: "Couldn't update that work order",
    detail: 'That SLA policy isn\'t in this tenant.',
  },
  'work_order.assignee_uuid_invalid': {
    title: "Couldn't update that work order",
    detail: 'Assignee id is not a valid UUID.',
  },
  'work_order.no_longer_accessible': {
    title: "You don't have access to this work order",
  },
  'work_order.permission_sla_override': {
    title: "You can't change SLA on this work order",
  },
  'work_order.permission_priority_change': {
    title: "You can't change priority on this work order",
  },
  'work_order.permission_assign': {
    title: "You can't assign this work order",
  },
  'work_order.empty_status_update': {
    title: "Couldn't update that work order",
    detail: 'At least one of status, status_category, waiting_reason is required.',
  },
  'work_order.empty_assignment_update': {
    title: "Couldn't update that work order",
    detail: 'At least one of assigned_team_id, assigned_user_id, assigned_vendor_id is required.',
  },
  'work_order.empty_metadata_update': {
    title: "Couldn't update that work order",
    detail: 'At least one of title, description, cost, tags, watchers is required.',
  },
  'work_order.reassign_reason_required': {
    title: "Couldn't reassign that work order",
    detail: 'Reassignment reason is required.',
  },
  'work_order.rerun_resolver_unsupported': {
    title: "Couldn't reassign that work order",
    detail: 'Auto-resolver isn\'t supported for work orders yet. Pass an explicit assignee.',
  },

  // ─── user-management (Phase 7.B-1.user-management) ───────────────────────
  'user_management.invalid_permission_key': {
    title: "Couldn't save that role",
    detail: 'One of the permission keys is invalid.',
  },

  // ─── service-catalog (Phase 7.B-1.service-catalog) ───────────────────────
  service_rule_not_found: {
    title: "Couldn't find that service rule",
  },
  name_required: {
    title: "Couldn't save",
    detail: 'Name is required.',
  },
  invalid_predicate: {
    title: "Couldn't save that rule",
    detail: 'The rule predicate is invalid.',
  },
  target_id_required: {
    title: "Couldn't save that rule",
    detail: 'Target id is required when target_kind is not tenant.',
  },
  target_kind_required: {
    title: "Couldn't save that rule",
    detail: 'Target kind is required.',
  },
  effect_required: {
    title: "Couldn't save that rule",
    detail: 'Effect is required.',
  },
  invalid_lead_time: {
    title: "Couldn't save that rule",
    detail: 'Lead time must be a non-negative integer up to 1440 minutes.',
  },
  template_required: {
    title: "Couldn't create that rule",
    detail: 'A template key is required.',
  },
  template_not_found: {
    title: "Couldn't find that template",
  },
  invalid_compiled_predicate: {
    title: "Couldn't create that rule",
    detail: 'The template compiled to an invalid predicate.',
  },
  param_required: {
    title: "Couldn't create that rule",
    detail: 'A required template parameter is missing.',
  },
  invalid_payload: {
    title: "Couldn't process that request",
    detail: 'Request body is required.',
  },
  missing_delivery_space: {
    title: "Couldn't load services",
    detail: 'A delivery space is required.',
  },
  missing_service_type: {
    title: "Couldn't load services",
    detail: 'A service type is required.',
  },

  // ─── portal-appearance (Phase 7.B-1.portal-appearance) ───────────────────
  'portal_appearance.location_required': {
    title: "Couldn't update appearance",
    detail: 'Location is required.',
  },
  'portal_appearance.file_required': {
    title: "Couldn't upload that image",
    detail: 'A file is required.',
  },
  'portal_appearance.unsupported_mime': {
    title: "Couldn't upload that image",
    detail: 'That file type isn\'t supported.',
  },
  'portal_appearance.file_too_large': {
    title: "Couldn't upload that image",
    detail: 'That file is too large.',
  },
  'portal_appearance.list_failed': {
    title: "Couldn't load portal appearance",
  },
  'portal_appearance.upsert_failed': {
    title: "Couldn't save portal appearance",
  },
  'portal_appearance.upsert_no_row': {
    title: "Couldn't save portal appearance",
  },
  'portal_appearance.upload_failed': {
    title: "Couldn't upload that image",
  },
  'portal_appearance.delete_failed': {
    title: "Couldn't delete portal appearance",
  },

  // ─── outbox (Phase 7.B-1.outbox) ─────────────────────────────────────────
  'outbox.duplicate_handler': {
    title: "Couldn't start the worker",
    detail: 'A duplicate outbox handler was registered.',
  },
};

/**
 * Resolve an English message for a code. Falls back to `unknown.server_error`
 * if the code isn't registered (decision #9 fail-closed). Decoupled from the
 * registry's `Set` so callers don't need to validate before lookup.
 */
export function resolveMessageEn(code: string): ErrorMessage {
  const known = ERROR_MESSAGES_EN[code as KnownErrorCode];
  if (known) return known;
  return ERROR_MESSAGES_EN['unknown.server_error'];
}
