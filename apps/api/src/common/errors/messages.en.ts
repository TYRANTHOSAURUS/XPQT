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
  // B.4.A.5 sub-step C — notification template resolution. Both are 500-class
  // programming errors (config drift); user-facing copy stays generic.
  'notification.unknown_event_kind': {
    title: "Couldn't send the notification",
    detail: 'The notification template is missing. Try again later.',
  },
  'notification.template_resolution_failed': {
    title: "Couldn't send the notification",
    detail: 'The notification template could not be resolved. Try again later.',
  },
  // B.4.A.5 sub-step E — inbox surface (404 / 401). User-facing copy stays generic;
  // the 404 specifically does NOT leak existence (cross-tenant ids surface here).
  'inbox_notification.not_found': {
    title: 'Notification not found',
    detail: "We couldn't find that notification.",
  },
  'inbox.not_resolvable': {
    title: 'Sign in again',
    detail: 'Your session is missing user details. Sign out and back in.',
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

  // ─── Slice B planning board ──────────────────────────────────────────────
  'planning.window_invalid': {
    title: "Couldn't load the planning board",
    detail: 'The date range is missing or invalid.',
  },
  'planning.window_too_wide': {
    title: 'Date range is too wide',
    detail: 'Pick a window of two weeks or less.',
  },
  'planning.status_invalid': {
    title: "Couldn't filter by that status",
    detail: 'The selected status is not recognised.',
  },
  'planning.version_conflict': {
    title: 'Moved by someone else',
    detail: 'Another dispatcher just moved this work order. Reload to see their change, or keep yours and overwrite theirs.',
  },
  'planning.operator_only': {
    title: "You don't have access to the planning board",
    detail: 'The planning board is available to operators only. Ask an administrator if you need access.',
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
  'booking.invalid_space_id': {
    title: "Couldn't update — invalid room",
    detail: 'Pick a valid room or leave the room unchanged.',
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
    title: 'Workflow node misconfigured',
    detail:
      "The `update_ticket` node config references a field that's no longer supported. See docs/follow-ups/b2-followups.md for the supported set.",
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
  'sla.policy_not_found': {
    title: "Couldn't update SLA",
    detail: 'SLA policy not found in this tenant.',
  },
  'sla.policy_has_no_targets': {
    title: "Couldn't assign SLA",
    detail: 'This SLA policy has no response or resolution targets configured. Set at least one before assigning it.',
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
  'booking.cancelled_cannot_edit': {
    title: "Couldn't edit — booking is cancelled",
    detail: 'This booking is cancelled and can no longer be edited.',
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
  'booking.cascade_cross_tenant_batch': {
    title: 'Server error',
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

  // ─── grant_ticket_approval RPC (B.2.A.Step10 reland §3.5) ────────────────
  'grant_ticket_approval.approval_not_found': {
    title: "We can't find that approval",
  },
  'grant_ticket_approval.invalid_target_entity_type': {
    title: "Couldn't grant — wrong approval path for this target",
  },
  'grant_ticket_approval.tenant_mismatch': {
    title: "Couldn't grant — approval doesn't belong to this workspace",
  },
  'grant_ticket_approval.invalid_response': {
    title: "Couldn't grant — decision must be approved or rejected",
  },
  'grant_ticket_approval.ticket_not_found': {
    title: "Couldn't grant — the related request is no longer available",
  },
  'grant_ticket_approval.cas_lost': {
    title: 'Approval state changed during grant attempt',
    detail: 'Please retry.',
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

  // ─── create_ticket_with_automation (B.2.A.Step12 §3.11) ─────────────────
  'create_ticket_with_automation.input_invalid': {
    title: "Couldn't create the ticket",
    detail: 'The request payload is missing a required field.',
  },
  'create_ticket_with_automation.request_type_not_found': {
    title: "Couldn't create the ticket",
    detail: 'The request type was not found or is inactive.',
  },
  'create_ticket_with_automation.malformed_response': {
    title: "Couldn't create the ticket",
    detail: 'The server returned an unexpected response. Try again.',
  },
  'automation_plan.effective_location_mismatch': {
    title: "Couldn't create the ticket — location mismatch",
    detail: 'The resolved location does not match the request. Try again.',
  },
  'automation_plan.semantic_mismatch': {
    title: "Couldn't create the ticket — configuration changed",
    detail: 'The workflow or SLA changed while the form was open. Refresh and resubmit.',
  },
  'automation_plan.scope_override_mismatch': {
    title: "Couldn't create the ticket — configuration changed",
    detail: 'The scope override changed while the form was open. Refresh and resubmit.',
  },
  'automation_plan.routing_input_mismatch': {
    title: "Couldn't create the ticket — routing input mismatch",
    detail: 'The routing context drifted while the form was open. Refresh and resubmit.',
  },
  'automation_plan.stale_resolution': {
    title: "Couldn't save the booking — rules changed",
    detail: 'The booking rule set changed while you were editing. Refresh and try again.',
  },

  // ─── reclassify_ticket RPC (B.2.A.Step11 §3.10) ──────────────────────────
  'reclassify_ticket.ticket_not_found': {
    title: "Couldn't reclassify — ticket not found",
  },
  'reclassify_ticket.reclassify_during_approval': {
    title: "Couldn't reclassify — approval pending",
    detail: 'Resolve all pending or delegated approvals on this ticket before reclassifying.',
  },
  'reclassify_ticket.new_request_type_invalid': {
    title: "Couldn't reclassify — request type unavailable",
    detail: 'The new request type was not found or is inactive.',
  },
  'reclassify_ticket.target_same': {
    title: "Couldn't reclassify — same request type",
    detail: 'The new request type equals the current one.',
  },
  'reclassify_ticket.input_invalid': {
    title: "Couldn't reclassify",
    detail: 'The request payload is missing a required field.',
  },
  'reclassify_ticket.terminal_ticket': {
    title: "Couldn't reclassify",
    detail: 'This ticket is closed or resolved. Reopen it first.',
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
  'org_node.has_children': {
    title: "Couldn't delete — has children",
    detail: 'Move or delete the children of this organization before deleting it.',
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

  // ─── cost-centers (Phase 7.B-1.cost-centers) ─────────────────────────────
  cost_center_not_found: {
    title: "Couldn't find that cost center",
  },
  cost_center_code_taken: {
    title: "Couldn't save that cost center",
    detail: 'A cost center with that code already exists.',
  },
  code_required: {
    title: "Couldn't save",
    detail: 'Code is required.',
  },
  code_too_long: {
    title: "Couldn't save",
    detail: 'Code must be 32 characters or fewer.',
  },

  // ─── bundle-templates (Phase 7.B-1.bundle-templates) ─────────────────────
  bundle_template_not_found: {
    title: "Couldn't find that bundle template",
  },
  invalid_services: {
    title: "Couldn't save that template",
    detail: 'Services must be a list.',
  },
  invalid_service_line: {
    title: "Couldn't save that template",
    detail: 'Each service line needs a catalog item.',
  },

  // ─── auth (Phase 7.B-1.auth) ─────────────────────────────────────────────
  'auth.missing_header': {
    title: 'Sign in to continue',
    detail: 'Authentication is required.',
  },
  'auth.invalid_token': {
    title: 'Sign in to continue',
    detail: 'Your session is no longer valid.',
  },
  'auth.role_lookup_failed': {
    title: "Couldn't verify access",
  },
  'auth.user_not_in_tenant': {
    title: "You don't have access here",
  },
  'auth.admin_required': {
    title: "You don't have access to this",
    detail: 'An admin role is required.',
  },

  // ─── webhook (Phase 7.B-1.webhook) ───────────────────────────────────────
  'webhook.not_found': {
    title: "Couldn't find that webhook",
  },
  'webhook.tenant_resolution_failed': {
    title: "Couldn't process that webhook",
    detail: 'Tenant resolution failed.',
  },
  'webhook.invalid_mapping': {
    title: "Couldn't save that webhook mapping",
  },
  'webhook.missing_api_key': {
    title: 'Authentication required',
    detail: 'Missing Bearer API key.',
  },
  'webhook.invalid_api_key': {
    title: 'Authentication failed',
    detail: 'Invalid API key.',
  },
  'webhook.inactive': {
    title: 'Webhook unavailable',
    detail: 'That webhook is inactive.',
  },
  'webhook.source_ip_unresolvable': {
    title: 'Webhook unavailable',
    detail: 'Source IP is unresolvable.',
  },
  'webhook.source_ip_not_permitted': {
    title: 'Webhook unavailable',
    detail: 'Source IP is not permitted.',
  },

  // ─── tenant (Phase 7.B-1.tenant) ─────────────────────────────────────────
  'tenant.not_found': { title: "Couldn't find that tenant" },
  'tenant.name_required': { title: "Couldn't save", detail: 'Name is required.' },
  'tenant.name_too_long': { title: "Couldn't save", detail: 'Name is too long.' },
  'tenant.invalid_theme_mode': {
    title: "Couldn't save",
    detail: 'Theme mode must be light, dark, or system.',
  },
  'tenant.invalid_color': { title: "Couldn't save", detail: 'Invalid color value.' },
  'tenant.invalid_image_kind': {
    title: "Couldn't upload that image",
    detail: 'Kind must be light, dark, or favicon.',
  },
  'tenant.file_required': { title: "Couldn't upload that image", detail: 'A file is required.' },
  'tenant.invalid_svg': {
    title: "Couldn't upload that image",
    detail: 'File doesn\'t appear to be an SVG.',
  },
  'tenant.update_failed': {
    title: "Couldn't update tenant",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  'tenant.upload_failed': { title: "Couldn't upload that image" },

  // ─── workflow (Phase 7.B-1.workflow) ─────────────────────────────────────
  'workflow.not_found': { title: "Couldn't find that workflow" },
  'workflow.invalid': {
    title: "Couldn't save that workflow",
    detail: 'The workflow definition is invalid.',
  },
  'workflow_instance.not_found': { title: "Couldn't find that workflow run" },

  // ─── Phase 1.5 visual approval workflow (sub-step 6.A.X) ─────────────────
  // 422: compiler rejected an admin-edited approval_config. Inline-form
  // surface — operator's fix is to add approvers / pick a valid threshold,
  // not to retry.
  'workflow_definition.compilation_failed': {
    title: "Couldn't save approval rule",
    detail:
      'The approval configuration is invalid. Add at least one approver and pick a threshold of either all or any.',
  },

  // ─── Phase 1.5 visual approval workflow (sub-step 6.A) ───────────────────
  // 422: tried to start a workflow whose definition exists but isn't in
  // `status='published'` (draft or archived). Operator's fix is to publish
  // the definition (or pick a different one).
  'workflow.definition_not_published': {
    title: "Couldn't start workflow",
    detail: 'The workflow definition is not published. Publish the workflow before using it.',
  },
  // 500: workflow cancel cascade failed because the
  // `cancel_workflow_instance_with_approvals` RPC raised. Server-class —
  // retry-loop with traceId.
  'workflow.cancel_with_approvals_failed': {
    title: "Couldn't cancel that workflow",
    detail: 'A server problem stopped the cancellation. Try again in a moment.',
  },
  // 500: engine internal failure during advance/resume — defensive raise.
  'workflow.advance_failed': {
    title: "Couldn't run the workflow",
    detail: 'The workflow engine ran into a problem. Try again in a moment.',
  },
  // Phase 1.5 sub-step 6.C — WorkflowApprovalGrantedHandler / RPC defenses.
  'workflow.approval_instance_not_found': {
    title: "Couldn't resume the approval workflow",
    detail: 'The workflow this approval belongs to could not be found.',
  },
  'workflow.tenant_mismatch_approval': {
    title: "Couldn't resume the approval workflow",
    detail: 'The approval belongs to a different organisation.',
  },
  'chain.threshold_invalid': {
    title: "Couldn't grant that approval",
    detail: 'The approval chain configuration is invalid. Contact support.',
  },
  'room_rule.workflow_recompile_failed': {
    title: "Couldn't save that approval rule",
    detail: 'The approval workflow could not be compiled. Try again in a moment.',
  },

  // ─── service-routing (Phase 7.B-1.service-routing) ───────────────────────
  service_routing_not_found: { title: "Couldn't find that routing rule" },
  service_routing_duplicate: {
    title: "Couldn't save that routing rule",
    detail: 'A routing rule for that service already exists.',
  },
  service_routing_immutable_key: {
    title: "Couldn't update that routing rule",
    detail: 'The service category cannot be changed after creation.',
  },
  invalid_foreign_key: {
    title: "Couldn't save",
    detail: 'A referenced item is not in this tenant.',
  },
  invalid_service_category: {
    title: "Couldn't save that routing rule",
    detail: 'Invalid service category.',
  },
  setup_routing_failed: { title: "Couldn't resolve setup routing" },

  // ─── portal (Phase 7.B-1.portal) ─────────────────────────────────────────
  'portal.no_linked_person': {
    title: 'No profile found',
    detail: 'Your account isn\'t linked to a person record.',
  },
  'portal.no_user_in_tenant': {
    title: 'No user in this tenant',
  },
  'portal.person_not_found': { title: "Couldn't find that person" },
  'portal.user_not_found': { title: "Couldn't find that user" },
  'portal.parent_space_not_found': { title: "Couldn't find that parent location" },
  'portal.request_type_not_found': { title: "Couldn't find that request type" },
  'portal.field_required': { title: "Couldn't process that request", detail: 'A required field is missing.' },
  'portal.unsupported_media_type': { title: "Couldn't upload that image", detail: 'Unsupported file type.' },
  'portal.avatar_too_large': { title: "Couldn't upload that image", detail: 'Avatar is too large.' },
  'portal.location_not_authorized': { title: "You don't have access to this location" },
  'portal.self_onboard_disabled': { title: 'Self-onboarding is disabled' },
  'portal.self_onboard_forbidden_person_type': {
    title: "Couldn't create that profile",
    detail: 'That person type is not allowed for self-onboarding.',
  },
  'portal.default_already_set': {
    title: "Couldn't change default",
    detail: 'A default location is already set for this person.',
  },
  'portal.grants_exist': {
    title: "Couldn't change defaults",
    detail: 'Other location grants exist for this person.',
  },
  'portal.requestable_failed': { title: "Couldn't load request types" },
  'portal.request_type_required': {
    title: "Couldn't submit",
    detail: 'A request type is required.',
  },
  'portal.asset_not_found': { title: "Couldn't find that asset" },

  // ─── orders (Phase 7.B-1.orders) ─────────────────────────────────────────
  no_lines: { title: "Couldn't submit", detail: 'At least one order line is required.' },
  missing_location: {
    title: "Couldn't submit",
    detail: 'Delivery location is required.',
  },
  missing_window: {
    title: "Couldn't submit",
    detail: 'Requested time window is required.',
  },
  no_person: { title: 'No profile found', detail: 'Your account isn\'t linked to a person.' },
  no_user: { title: 'No user record found' },
  order_not_found: { title: "Couldn't find that order" },
  master_order_not_found: { title: "Couldn't find that master order" },
  line_not_editable: {
    title: "Couldn't update that order line",
    detail: 'This line is no longer editable.',
  },
  'orders.not_implemented': {
    title: "That feature isn't available yet",
  },
  'orders.approval_routing_failed': {
    title: "Couldn't resolve approval routing",
  },

  // ─── daily-list (Phase 7.B-1.daily-list) ─────────────────────────────────
  'daily_list.pdf_renderer_unavailable': {
    title: "Couldn't generate PDF",
    detail: 'PDF rendering is currently unavailable.',
  },
  'daily_list.line_not_found': { title: "Couldn't find that line" },
  'daily_list.invalid_payload': { title: "Couldn't process that request" },
  'daily_list.invalid_date': { title: "Couldn't process that request", detail: 'Invalid date format.' },
  'daily_list.body_required': { title: "Couldn't process that request", detail: 'Request body is required.' },
  'daily_list.field_required': { title: "Couldn't process that request", detail: 'A required field is missing.' },
  'daily_list.mailer_failed': { title: "Couldn't send that email" },
  'daily_list.vendor_not_found': { title: "Couldn't find that vendor" },
  'daily_list.invalid_vendor': { title: "Couldn't process that request", detail: 'Vendor is not configured for daily lists.' },
  'daily_list.not_found': { title: "Couldn't find that daily list" },
  'daily_list.upload_failed': { title: "Couldn't upload PDF" },
  'daily_list.signed_url_failed': { title: "Couldn't generate signed link" },
  'daily_list.no_email': {
    title: "Couldn't send daily list",
    detail: 'Vendor has no email address configured.',
  },
  'daily_list.send_failed': {
    title: "Couldn't send daily list",
    detail: 'Retry from the daily list page or contact support.',
  },
  'daily_list.pdf_missing': { title: "Couldn't render daily list", detail: 'PDF storage path is missing.' },

  // ─── config-engine (Phase 7.B-1.config-engine) ───────────────────────────
  'config_engine.invalid_expression': { title: "Couldn't save", detail: 'Invalid expression.' },
  'config_engine.criteria_set_not_found': { title: "Couldn't find that criteria set" },
  'config_engine.entity_not_found': { title: "Couldn't find that config entity" },
  'config_engine.draft_not_found': { title: "Couldn't find a draft" },
  'config_engine.no_draft_to_publish': { title: "Couldn't publish", detail: 'No draft to publish.' },
  'config_engine.version_not_found': { title: "Couldn't find that version" },
  'config_engine.invalid_hierarchy': {
    title: "Couldn't save",
    detail: 'Invalid catalog hierarchy.',
  },
  'config_engine.invalid_cover_source': {
    title: "Couldn't save",
    detail: 'cover_source must be image, icon, or null.',
  },
  'config_engine.file_required': { title: "Couldn't upload that image", detail: 'A file is required.' },
  'config_engine.unsupported_mime': { title: "Couldn't upload that image", detail: 'Unsupported file type.' },
  'config_engine.file_too_large': { title: "Couldn't upload that image", detail: 'File is too large.' },
  'config_engine.upload_failed': { title: "Couldn't upload that image" },
  'config_engine.update_failed': { title: "Couldn't update" },
  'config_engine.category_not_found': { title: "Couldn't find that category" },
  'config_engine.invalid_request_type': { title: "Couldn't save that request type" },
  'config_engine.request_type_not_found': { title: "Couldn't find that request type" },
  'config_engine.invalid_scope': {
    title: "Couldn't save",
    detail: 'Scope is invalid.',
  },
  'config_engine.invalid_handler': {
    title: "Couldn't save",
    detail: 'Handler configuration is invalid.',
  },

  // ─── calendar-sync (Phase 7.B-1.calendar-sync) ───────────────────────────
  'calendar_sync.no_auth': { title: 'Sign in to continue' },
  'calendar_sync.invalid_state': { title: "Couldn't complete sign-in", detail: 'OAuth state is unknown or expired.' },
  'calendar_sync.state_user_mismatch': { title: "Couldn't complete sign-in", detail: 'OAuth state belongs to another user.' },
  'calendar_sync.no_link': { title: 'No calendar linked' },
  'calendar_sync.conflict_not_found': { title: "Couldn't find that conflict" },
  'calendar_sync.conflict_not_open': { title: "Couldn't update that conflict", detail: 'Conflict is no longer open.' },
  'calendar_sync.link_not_found': { title: "Couldn't find that calendar link" },
  'calendar_sync.no_user_in_tenant': { title: 'No user in this tenant' },
  'calendar_sync.token_failed': { title: "Couldn't process tokens" },
  'calendar_sync.graph_failed': { title: "Couldn't reach calendar service" },
  'calendar_sync.config_missing': { title: "Calendar sync isn't configured" },

  // ─── room-booking-rules (Phase 7.B-1.room-booking-rules) ─────────────────
  'room_rule.template_param_required': { title: "Couldn't apply template", detail: 'A required parameter is missing.' },
  'room_rule.template_invalid': { title: "Couldn't apply template" },
  'room_rule.invalid_predicate': { title: "Couldn't save", detail: 'Predicate is invalid.' },
  'room_rule.scenario_not_found': { title: "Couldn't find that scenario" },
  'room_rule.not_found': { title: "Couldn't find that rule" },
  'room_rule.version_not_found': { title: "Couldn't find that version" },
  'room_rule.invalid_effect': { title: "Couldn't save", detail: 'Effect is invalid.' },
  'room_rule.name_required': { title: "Couldn't save", detail: 'Name is required.' },
  'room_rule.invalid_scope': { title: "Couldn't save", detail: 'Scope is invalid.' },
  'room_rule.space_not_found': { title: "Couldn't find that space" },
  'room_rule.impact_failed': { title: "Couldn't preview impact" },

  // ─── vendor-portal (Phase 7.B-1.vendor-portal) ───────────────────────────
  'vendor_portal.order_not_found': { title: "Couldn't find that order" },
  'vendor_portal.invalid_email': { title: "Couldn't save", detail: 'That email address looks invalid.' },
  'vendor_portal.invalid_role': { title: "Couldn't save", detail: 'Role must be fulfiller or manager.' },
  'vendor_portal.invite_failed': { title: "Couldn't send that invite" },
  'vendor_portal.user_create_failed': { title: "Couldn't create that vendor user" },
  'vendor_portal.user_not_found': { title: "Couldn't find that vendor user" },
  'vendor_portal.user_deactivated': { title: 'Account deactivated' },
  'vendor_portal.user_locked': { title: 'Account temporarily locked' },
  'vendor_portal.magic_link_invalid': {
    title: "Couldn't sign in",
    detail: 'Magic link is invalid, expired, or already used.',
  },
  'vendor_portal.user_missing': { title: "Couldn't sign in" },
  'vendor_portal.token_required': { title: "Couldn't process", detail: 'Token is required.' },
  'vendor_portal.no_session': { title: 'Sign in to continue' },
  'vendor_portal.session_invalid': { title: 'Sign in to continue', detail: 'Session is invalid or expired.' },
  'vendor_portal.field_required': { title: "Couldn't process", detail: 'A required field is missing.' },
  'vendor_portal.invalid_status': { title: "Couldn't update status" },
  'vendor_portal.invalid_transition': { title: "Couldn't update status", detail: 'That status transition isn\'t allowed.' },
  'vendor_portal.decline_reason_required': {
    title: "Couldn't decline",
    detail: 'A reason of at least 8 characters is required.',
  },

  // ─── privacy-compliance (Phase 7.B-1.privacy-compliance) ─────────────────
  'privacy.invalid_payload': { title: "Couldn't process that request" },
  'privacy.reason_required': { title: "Couldn't process", detail: 'A reason is required.' },
  'privacy.hold_create_failed': { title: "Couldn't create that legal hold" },
  'privacy.hold_not_found': { title: "Couldn't find that legal hold" },
  'privacy.retention_not_found': { title: "Couldn't find those retention settings" },
  'privacy.retention_invalid': { title: "Couldn't update retention" },
  'privacy.dsr_not_found': { title: "Couldn't find that DSR" },
  'privacy.dsr_invalid_state': { title: "Couldn't update that DSR" },
  'privacy.dsr_create_failed': { title: "Couldn't create that DSR" },
  'privacy.bundle_upload_failed': {
    title: "Couldn't upload bundle",
    detail: 'Try again. The export will retry from the start.',
  },
  'privacy.signed_url_failed': {
    title: "Couldn't generate signed link",
    detail: 'Try again. If it keeps happening, contact support.',
  },
  'privacy.subject_not_found': { title: "Couldn't find that subject" },
  'privacy.unknown_data_category': { title: "Couldn't process", detail: 'Unknown data category.' },

  // ─── routing (Phase 7.B-1.routing) ───────────────────────────────────────
  'routing.field_required': { title: "Couldn't process", detail: 'A required field is missing.' },
  'routing.body_required': { title: "Couldn't process", detail: 'Request body is required.' },
  'routing.db_failed': { title: "Couldn't process that request" },
  'routing.not_found': { title: "Couldn't find that record" },
  'routing.invalid_definition': { title: "Couldn't save", detail: 'Invalid definition.' },
  'routing.invalid_state': { title: "Couldn't process", detail: 'Invalid state for this action.' },
  'routing.duplicate': { title: "Couldn't save", detail: 'A duplicate already exists.' },
  'routing.v2_not_implemented': { title: "That feature isn't available yet" },

  // ─── common (Phase 7.B-1.common) ─────────────────────────────────────────
  'person.not_found': { title: "Couldn't find that person" },
  'tenant.unknown': { title: "Couldn't find that workspace" },
  'mail.config_missing': { title: "Couldn't send that email", detail: 'Mail provider is not configured.' },
  'mail.dispatch_failed': { title: "Couldn't send that email" },
  'mail.invalid_recipient': { title: "Couldn't send that email", detail: 'Recipient address is invalid.' },
  'mail.webhook_unauthorized': { title: 'Webhook authentication failed' },
  'mail.webhook_invalid': { title: 'Webhook request invalid' },
  'reference.field_invalid': { title: "Couldn't save", detail: 'A referenced field is invalid.' },
  'reference.invalid_array_size': { title: "Couldn't save", detail: 'Array exceeds the allowed size.' },
  'client_request_id.required': {
    title: "Couldn't process",
    detail: 'A client request id is required for this operation.',
  },
  'client_request_id.invalid': {
    title: "Couldn't process",
    detail: 'Client request id is invalid.',
  },

  // ─── visitors (Phase 7.B-1.visitors) ─────────────────────────────────────
  'visitor.not_found': { title: "Couldn't find that visitor" },
  'visitor.invalid_payload': { title: "Couldn't process that request" },
  'visitor.invalid_state': { title: "Couldn't update that visitor", detail: "That state transition isn't allowed." },
  'visitor.forbidden': { title: "You don't have access to this" },
  'visitor.unauthorized': { title: 'Sign in to continue' },
  'visitor.conflict': { title: "Couldn't save", detail: 'Conflict with existing data.' },
  'visitor.field_required': { title: "Couldn't process", detail: 'A required field is missing.' },
  'visitor.invalid_uuid': { title: "Couldn't process", detail: 'Invalid UUID.' },
  'visitor.duplicate': { title: "Couldn't save", detail: 'A duplicate already exists.' },
  'visitor.host_not_found': { title: "Couldn't find that host" },
  'visitor.kiosk_unauthorized': { title: 'Kiosk authentication failed' },
  'visitor.pass_not_found': { title: "Couldn't find that pass" },
  'visitor.pass_unavailable': { title: 'Pass unavailable' },
  'visitor.invitation_not_found': { title: "Couldn't find that invitation" },
  'visitor.reception_failed': { title: "Couldn't process at reception" },
  'visitor.notification_failed': { title: "Couldn't send notification" },
  'visitor.invalid_token': { title: 'Invitation link is invalid', detail: 'This link has expired or is no longer valid.' },
  'visitor.config_missing': { title: "Couldn't process", detail: 'Visitor service is not configured.' },
  // Phase 7.B-1 review fixes (status-class drift)
  'visitor.host_required': { title: "You don't have access to this", detail: 'You are not a host on this visit.' },
  'visitor.tenant_mismatch': { title: "Couldn't find that visitor" },
  'visitor_type.not_found': { title: "Couldn't find that visitor type" },
  'visitor_pass.not_found': { title: "Couldn't find that pass" },
  'kiosk_token.not_found': { title: "Couldn't find that kiosk" },
  'pool_anchor.not_found': { title: "Couldn't find that anchor space" },
  'pool_anchor.invalid': { title: "Couldn't process", detail: 'Pool anchor must be a site or building.' },
  // B.2.A §3.1 transition_entity_status RPC
  'transition_entity_status.unknown_kind': { title: "Couldn't update", detail: 'Unknown entity kind.' },
  'transition_entity_status.not_found': { title: "Couldn't find that ticket" },
  'transition_entity_status.has_open_children': { title: "Couldn't close", detail: 'This case has open work orders.' },
  'transition_entity_status.invalid_status': { title: "Couldn't update", detail: 'Invalid status.' },
  'transition_entity_status.invalid_status_category': { title: "Couldn't update", detail: 'Invalid status category.' },
  'command_operations.payload_mismatch': { title: 'Duplicate request with different payload.', detail: 'Your client reused the same X-Client-Request-Id header for two different requests. Generate a fresh request id and retry.' },
  'command_operations.unexpected_state': { title: "Couldn't replay", detail: 'Unexpected state on the previous attempt.' },
  'command_operations.client_request_id_required': { title: "Couldn't update", detail: 'This request is missing the X-Client-Request-Id header.' },
  'work_order.parent_terminal': { title: "Couldn't add to a closed case" },
  // B.2.A §3.2 set_entity_assignment RPC (00326)
  'set_entity_assignment.unknown_kind': { title: "Couldn't update", detail: 'Unknown entity kind.' },
  'set_entity_assignment.not_found': { title: "Couldn't find that ticket" },
  'set_entity_assignment.resolver_rerun_not_supported_at_rpc': {
    title: "Couldn't update",
    detail: "Server can't rerun routing — this is an internal-only signal that an orchestration step was skipped.",
  },
  // B.2.A §3.3 update_entity_sla RPC (00328)
  'update_entity_sla.unknown_kind': { title: "Couldn't update SLA", detail: 'Unknown entity kind.' },
  'update_entity_sla.not_found': { title: "Couldn't find that ticket" },
  'update_entity_sla.timers_required': {
    title: "Couldn't update SLA",
    detail: 'Timers required.',
  },
  'update_entity_sla.sla_id_required': {
    title: "Couldn't update SLA",
    detail: 'sla_id required.',
  },
  // B.2.A §3.0 update_entity_combined RPC (00331)
  'update_entity_combined.unknown_kind': { title: "Couldn't update", detail: 'Unknown entity kind.' },
  'update_entity_combined.not_found': { title: "Couldn't find that ticket" },
  'update_entity_combined.invalid_patches': { title: "Couldn't update", detail: 'The patch payload must be a JSON object.' },
  'update_entity_combined.plan_not_supported_on_case': {
    title: "Couldn't update",
    detail: 'Plan dates can only be set on work orders.',
  },
  'update_entity_combined.invalid_priority': {
    title: "Couldn't update",
    detail: 'Priority must be one of low, medium, high, critical.',
  },
  'update_entity_combined.invalid_metadata': {
    title: "Couldn't update",
    detail: 'Title cannot be empty.',
  },
  'update_entity_combined.invalid_cost': {
    title: "Couldn't update",
    detail: 'Cost must be a non-negative number.',
  },
  'update_entity_combined.invalid_watcher': {
    title: "Couldn't update",
    detail: 'One or more watchers are not part of this tenant.',
  },
  'update_entity_combined.invalid_plan': {
    title: "Couldn't update",
    detail: 'Plan dates must be a valid ISO timestamp and duration must be a non-negative integer.',
  },
  'update_entity_combined.invalid_source': {
    title: "Couldn't update",
    detail: 'Plan change source must be one of board, detail, or generator.',
  },

  // B.2.A §3.4 dispatch_child_work_order RPC (00338 / 00339)
  // parent_not_case removed (F-IMP-2 / plan-I2): post step1c.10c
  // public.tickets only holds case rows so a work_order id misses the
  // parent SELECT and surfaces as parent_not_found.
  'dispatch_child_work_order.parent_not_found': { title: "Couldn't find that case" },
  'dispatch_child_work_order.parent_not_dispatchable': {
    title: "Couldn't dispatch a work order",
    detail: 'This case is pending approval or already closed.',
  },
  'dispatch_child_work_order.invalid_payload': {
    title: "Couldn't dispatch a work order",
    detail: 'The dispatch payload is malformed.',
  },
  'dispatch_child_work_order.timers_required': {
    title: "Couldn't dispatch a work order",
    detail: 'An SLA policy was set without any timer thresholds. Try again.',
  },
  'dispatch_child_work_orders_batch.empty_tasks': {
    title: "Couldn't dispatch work orders",
    detail: 'No tasks were provided to dispatch.',
  },
  'dispatch_child_work_orders_batch.invalid_payload': {
    title: "Couldn't dispatch work orders",
    detail: 'The dispatch batch payload is malformed.',
  },
  // Tenant-FK validation helper (00317) raises on first foreign-tenant miss
  // (F-IMP-4 / code-I1). Registered as 422 so the HTTP surface is clean if
  // TS preflight regresses and the RPC's defense-in-depth raise reaches users.
  'validate_assignees_in_tenant.assigned_team_id_not_in_tenant': {
    title: "Couldn't update assignment",
    detail: 'The team is not part of this tenant.',
  },
  'validate_assignees_in_tenant.assigned_user_id_not_in_tenant': {
    title: "Couldn't update assignment",
    detail: 'The user is not part of this tenant.',
  },
  'validate_assignees_in_tenant.assigned_vendor_id_not_in_tenant': {
    title: "Couldn't update assignment",
    detail: 'The vendor is not part of this tenant.',
  },
  // Tenant-entity validation helper (00321 / 00340 / 00359 / 00360) —
  // Codex-S8-I2 / F-IMP-2 + B.4.A.2 + B.4.A.4.
  //
  // self-review I3 (2026-05-12): voice was "Couldn't dispatch" everywhere
  // because the helper's original caller was the dispatch RPC. With B.4
  // step 2D-D the helper now serves edit_booking too — `Couldn't dispatch`
  // bleeds into the booking-edit surface (e.g. operator drags a booking
  // onto a foreign-tenant space and gets "Couldn't dispatch — The space
  // is not part of this tenant" instead of a booking-voice message).
  // Refactored to domain-neutral copy that reads correctly on EVERY
  // caller surface (dispatch, edit_booking, future combined RPCs):
  //   - Title names the entity that wasn't found (no verb).
  //   - Detail names the situation + a generic operator action.
  // No more "Couldn't dispatch" vs "Couldn't save the booking" — just
  // the entity miss, stated plainly.
  'validate_entity_in_tenant.unknown_kind': {
    title: 'Unknown entity kind',
    detail: 'The request referenced an unknown entity kind.',
  },
  'validate_entity_in_tenant.dispatch_missing': {
    title: 'Unknown entity kind',
    detail: 'The request referenced an unknown entity kind.',
  },
  'validate_entity_in_tenant.case_not_in_tenant': {
    title: 'Case not found',
    detail: "The selected case isn't part of this tenant. Pick a different case.",
  },
  'validate_entity_in_tenant.work_order_not_in_tenant': {
    title: 'Work order not found',
    detail: "The selected work order isn't part of this tenant. Pick a different work order.",
  },
  'validate_entity_in_tenant.asset_not_in_tenant': {
    title: 'Asset not found',
    detail: "The selected asset isn't part of this tenant. Pick a different asset.",
  },
  'validate_entity_in_tenant.space_not_in_tenant': {
    title: 'Space not found',
    detail: "The selected space isn't part of this tenant. Pick a different space.",
  },
  'validate_entity_in_tenant.request_type_not_in_tenant': {
    title: 'Request type not found',
    detail: "The selected request type isn't part of this tenant. Pick a different request type.",
  },
  'validate_entity_in_tenant.scope_override_not_in_tenant': {
    title: 'Scope override not found',
    detail: "The selected scope override isn't part of this tenant.",
  },
  'validate_entity_in_tenant.workflow_definition_not_in_tenant': {
    title: 'Workflow not found',
    detail: "The selected workflow definition isn't part of this tenant.",
  },
  'validate_entity_in_tenant.sla_policy_not_in_tenant': {
    title: 'SLA policy not found',
    detail: "The selected SLA policy isn't part of this tenant.",
  },
  'validate_entity_in_tenant.person_not_in_tenant': {
    title: 'Person not found',
    detail: "The selected person isn't part of this tenant. Pick a different person.",
  },
  'validate_entity_in_tenant.routing_rule_not_in_tenant': {
    title: 'Routing rule not found',
    detail: "The selected routing rule isn't part of this tenant.",
  },
  'validate_entity_in_tenant.booking_rule_not_in_tenant': {
    title: 'Booking rule not found',
    detail: "The selected booking rule isn't part of this tenant.",
  },
  'validate_entity_in_tenant.cost_center_not_in_tenant': {
    title: 'Cost center not found',
    detail: "The selected cost center isn't part of this tenant. Pick a different cost center.",
  },
  'validate_entity_in_tenant.team_not_in_tenant': {
    title: 'Team not found',
    detail: "The selected team isn't part of this tenant. Pick a different team.",
  },
  // ─── B.4.A edit_booking RPC (00361 v1 → 00364 v4) ───────────────────────
  // actor_not_found: the JWT's auth_uid has no users row in the tenant.
  //   Defense-in-depth — TS auth guard normally rejects this earlier.
  // not_found: the booking row is missing or in a different tenant.
  //   Mirrors booking.not_found shape with the RPC-specific namespace.
  // invalid_plan_shape: the TS-built plan failed top-level structural
  //   validation (missing booking object, slot_patches array, etc.).
  // deny_on_edit: §3.6.5 Row 10 — rule resolver's new outcome is `deny`
  //   for the edit target. Hard 422; pick a different room or revert the
  //   change. Replaces v3's `approval_reconciliation_required` (RETIRED).
  'edit_booking.actor_not_found': {
    title: "Couldn't save the booking",
    detail: 'Your account is not registered in this tenant. Sign in again or contact an administrator.',
  },
  'edit_booking.not_found': {
    title: "Couldn't save the booking — not found",
    detail: "This booking no longer exists, or you don't have access to it.",
  },
  'edit_booking.invalid_plan_shape': {
    title: "Couldn't save the booking",
    detail: 'The edit request was malformed. Refresh the page and try again.',
  },
  'edit_booking.deny_on_edit': {
    title: "Couldn't save the booking",
    detail: "This edit isn't allowed by the rules for this room.",
  },
  // v3 (00363) — codex Critical 2 — booking-scope rejections. The plan
  // referenced a child row (work order / order / asset reservation) that
  // belongs to a different booking, or has no booking link at all. From
  // the operator's perspective: the row isn't part of this booking, so
  // the same not_found voice applies — "refresh and try again" recovers
  // by rebuilding the plan against the current booking state.
  'edit_booking.work_order_not_in_booking': {
    title: "Couldn't save the booking — not found",
    detail: 'A work order in the edit no longer belongs to this booking. Refresh the page and try again.',
  },
  'edit_booking.order_not_in_booking': {
    title: "Couldn't save the booking — not found",
    detail: 'An order in the edit no longer belongs to this booking. Refresh the page and try again.',
  },
  'edit_booking.asset_reservation_not_in_booking': {
    title: "Couldn't save the booking — not found",
    detail: 'An asset reservation in the edit no longer belongs to this booking. Refresh the page and try again.',
  },
  // B.4.A.4 step 2D-C self-review remediation (PLAN-C1).
  // rule_missing_approvers: thrown by AssembleEditPlanService when the
  // rule resolver's outcome is require_approval but approvalConfig is null
  // OR required_approvers is empty. Operator-actionable: an admin must
  // configure approvers on the rule for this room, OR pick a different room.
  'edit_booking.rule_missing_approvers': {
    title: "Couldn't save the booking",
    detail: 'The rule for this room requires approval but no approvers are configured. Ask an administrator to configure approvers, or pick a different room.',
  },
  // B.4 step 2D-D — controller-vs-notification gate (B.4.A.5 sequencing).
  // Gate LIFTED by B.4.A.5 sub-step H (2026-05-13); code retained for
  // defense-in-depth across editOne / editSlot / editScope so a future
  // regression that re-introduces the gate reuses this title/detail
  // rather than inventing a new one. Voice is unchanged: class
  // 'validation' (422), actionable for the operator (rooms admin remove
  // approval OR pick a different room).
  'booking.edit_requires_notification_dispatch': {
    title: "Edit blocked — approval changes can't be saved yet",
    detail:
      "This edit would change approval requirements. Ask the rooms admin to remove approval from this room, or pick a different room.",
  },
  // B.4.A.4 step 2D-C self-review remediation (CODE-I2).
  // approval.read_failed: AssembleEditPlanService.loadCurrentApprovalChain
  // could not read the approvals table. Generic server-class voice; the
  // traceId attached by the filter routes ops to the underlying supabase
  // error.
  'approval.read_failed': {
    title: "Couldn't save the booking",
    detail: "We couldn't read this booking's approval state. Try again in a moment.",
  },
  // B.4.A.5 sub-step D self-review remediation (CODE-I5). Worker-emit only;
  // user voice mirrors approval.read_failed (generic server-class) — the
  // traceId attached by the filter routes ops to the underlying read error.
  'users.lookup_failed': {
    title: "Couldn't send the notification",
    detail: "We couldn't look up the recipients. Try again in a moment.",
  },
  'booking.read_failed': {
    title: "Couldn't send the notification",
    detail: "We couldn't read the booking details. Try again in a moment.",
  },

  // ─── floor_plan ──────────────────────────────────────────────────────────
  'floor_plan.draft.not_found': {
    title: 'Floor plan draft not found',
    detail: 'This floor has no active draft. Open the designer to create one.',
  },
  'floor_plan.draft.create_failed': {
    title: "Couldn't create draft",
    detail: "We couldn't create a floor plan draft. Try again in a moment.",
  },
  'floor_plan.draft.update_failed': {
    title: "Couldn't save draft",
    detail: "We couldn't save your changes to the draft. Try again in a moment.",
  },
  'floor_plan.draft.discard_failed': {
    title: "Couldn't discard draft",
    detail: "We couldn't discard the floor plan draft. Try again in a moment.",
  },
  'floor_plan.draft.stale_update': {
    title: 'Draft changed by another editor',
    detail: 'Someone else saved changes to this draft while you were editing. Reload to continue.',
  },
  'floor_plan.draft.invalid_polygons': {
    title: 'Invalid polygon data',
    detail: 'One or more polygons reference spaces that are not part of this floor.',
  },
  'floor_plan.draft.point_out_of_bounds': {
    title: 'Polygon points out of bounds',
    detail: 'One or more polygon points fall outside the floor image. Drag them inside the canvas and try again.',
  },
  'floor_plan.publish.image_required': {
    title: "Can't publish without a floor image",
    detail: 'Upload a floor plan image and set dimensions before publishing.',
  },
  'floor_plan.publish.unlinked_polygons': {
    title: "Can't publish — unlinked polygons",
    detail: 'All polygons must be linked to a space before publishing. Select a space for each unlinked polygon.',
  },
  'floor_plan.publish.invalid_polygons': {
    title: "Can't publish — invalid polygons",
    detail: 'One or more polygons are invalid (fewer than 3 points or missing a space). Fix them in the designer.',
  },
  'floor_plan.publish.cross_tenant': {
    title: 'Permission denied',
    detail: "You can't publish a floor plan from another organisation.",
  },
  'floor_plan.publish_failed': {
    title: "Couldn't publish floor plan",
    detail: "The floor plan couldn't be published. Try again in a moment.",
  },
  'floor_plan.list_failed': {
    title: "Couldn't load floor plans",
    detail: "We couldn't load the floor plans list. Try again in a moment.",
  },
  'floor_plan.history.not_found': {
    title: 'Publish history entry not found',
    detail: 'The selected publish snapshot no longer exists.',
  },
  'floor_plan.history.cross_tenant': {
    title: "Couldn't restore floor plan",
    detail: "You don't have permission to restore this snapshot.",
  },
  'floor_plan.restore_failed': {
    title: "Couldn't restore floor plan",
    detail: "The floor plan couldn't be restored. Try again in a moment.",
  },
  'floor_plan.availability.invalid_window': {
    title: "Couldn't load availability",
    detail: 'The time window is invalid. The start must be before the end.',
  },
  'floor_plan.availability.invalid_args': {
    title: "Couldn't load availability",
    detail: 'A required parameter is missing.',
  },
  'floor_plan.availability_failed': {
    title: "Couldn't load availability",
    detail: "Floor availability couldn't be loaded. Try again in a moment.",
  },
  // B.4 Step 2F.1 — edit_booking_scope RPC (00367). Series-scope edits
  // fan out one EditPlan per occurrence; failures here surface with the
  // same operator-actionable voice as the single-occurrence edit codes.
  'edit_booking_scope.invalid_plans': {
    title: "Couldn't save the series edit",
    detail: 'The series edit request was malformed. Refresh the page and try again.',
  },
  'edit_booking_scope.too_many_occurrences': {
    title: "Couldn't save the series edit — too large",
    detail: 'This edit affects too many occurrences to commit in one step. Narrow the scope (e.g. "this and following") or contact support.',
  },
  'edit_booking_scope.booking_not_found': {
    title: "Couldn't save the series edit — not found",
    detail: 'One or more occurrences in the series no longer exist. Refresh the page and try again.',
  },
  'edit_booking_scope.mixed_series': {
    title: "Couldn't save the series edit",
    detail: 'The selected occurrences are not all part of the same series. Refresh the page and pick the scope again.',
  },
  // B.4 Step 2F.2 — TS-side defensive raises (assembleScopeEditPlan).
  // 422 codes route to inline validation surface; 500 codes route to a
  // generic server-error toast with traceId (the renderer handles that).
  'edit_booking_scope.time_shift_not_supported': {
    title: "Couldn't save the series edit",
    detail: 'Series time-shift edits are not supported. Pick a single occurrence to change the start or end time.',
  },
  'edit_booking_scope.not_recurring': {
    title: "Couldn't save the series edit",
    detail: 'This booking is not part of a recurring series. Use the single-occurrence edit instead.',
  },
  'edit_booking_scope.series_mismatch': {
    title: "Couldn't save the series edit",
    detail: "Something went wrong matching this edit to the series. Refresh the page and try again.",
  },
  'edit_booking_scope.empty_scope': {
    title: "Couldn't save the series edit",
    detail: 'No occurrences were found in this series. Refresh the page and pick the scope again.',
  },
  'edit_booking_scope.primary_slot_not_found': {
    title: "Couldn't save the series edit",
    detail: "One of the occurrences is in an inconsistent state. Contact support if this persists.",
  },
  // B.4 Step 2F.3 self-review remediation (I1) — 500 server-class fallback
  // for unknown RPC errors. Voice mirrors `booking.edit_failed`'s
  // "Couldn't save the changes" — a transient platform problem the operator
  // can retry, not an inline validation message.
  'edit_booking_scope.update_failed': {
    title: "Couldn't save the series edit",
    detail: "Something went wrong saving this series edit. Try again in a moment; contact support if this persists.",
  },
  // ─── Booking-audit remediation Slice 2 — cancel_booking_with_cascade ────
  // RPC 00408 (audit 03 P0-1 + P1-5). Voice mirrors the edit_booking.*
  // family: same "Couldn't cancel the booking" title shape, actionable
  // recovery in the detail. actor_not_found / not_found = the
  // edit_booking.* wording with "cancel" swapped in; invalid_scope /
  // not_recurring = the edit_booking_scope.not_recurring shape.
  'cancel_booking_with_cascade.actor_not_found': {
    title: "Couldn't cancel the booking",
    detail: 'Your account is not registered in this tenant. Sign in again or contact an administrator.',
  },
  'cancel_booking_with_cascade.not_found': {
    title: "Couldn't cancel the booking — not found",
    detail: "This booking no longer exists, or you don't have access to it.",
  },
  'cancel_booking_with_cascade.invalid_scope': {
    title: "Couldn't cancel the booking",
    detail: 'The cancellation scope was invalid. Refresh the page and pick the scope again.',
  },
  'cancel_booking_with_cascade.not_recurring': {
    title: "Couldn't cancel the series",
    detail: 'This booking is not part of a recurring series. Cancel the single occurrence instead.',
  },
  // ─── Booking-audit remediation Slice 4 — split_recurrence_series ────────
  // RPC 00411 (audit 03 P1-2). Voice mirrors the cancel_booking_with_
  // cascade.* family: same "Couldn't update the recurrence" shape with
  // actionable recovery in the detail.
  'split_recurrence_series.actor_not_found': {
    title: "Couldn't update the recurrence",
    detail: 'Your account is not registered in this tenant. Sign in again or contact an administrator.',
  },
  'split_recurrence_series.not_found': {
    title: "Couldn't update the recurrence — not found",
    detail: "This booking no longer exists, or you don't have access to it.",
  },
  'split_recurrence_series.not_recurring': {
    title: "Couldn't update the series",
    detail: 'This booking is not part of a recurring series. Edit the single occurrence instead.',
  },
  // ─── Phase 1.B universal workflow ───────────────────────────────────────
  // Spec §3.6 + §3.12. Three guards that block invalid spawn-link writes
  // before the engine commits. 422 surfaces as inline editor copy — the
  // operator's fix is to restructure the workflow definition, not to retry.
  'spawn_link.parent_terminated': {
    title: "Couldn't spawn — parent workflow ended",
    detail: "This workflow has been cancelled or completed. New child entities can't be spawned from a terminated parent.",
  },
  'spawn_link.depth_exceeded': {
    title: "Couldn't spawn — workflow chain too deep",
    detail: 'The workflow chain has reached the 10-level depth limit. Restructure the workflow to spawn fewer layers.',
  },
  'spawn_link.cycle_detected': {
    title: "Couldn't spawn — workflow cycle",
    detail: 'This spawn would re-enter an ancestor entity, creating an infinite chain. Refactor the workflow to avoid revisiting the same entity.',
  },
  'maintenance_plans.target_mutex_violation': {
    title: "Couldn't save plan",
    detail: 'Pick exactly one target — a specific asset or an asset type — not both.',
  },
  'maintenance_plans.invalid_recurrence': {
    title: "Couldn't save plan",
    detail: 'Set a positive interval and pick a recurrence unit (day, week, month, or year).',
  },
  'maintenance_plans.not_found': {
    title: "We can't find that plan",
  },
  'maintenance_plans.in_use': {
    title: "Couldn't delete plan",
    detail: 'Work orders still reference this plan. Deactivate the plan instead, or remove the linked work orders first.',
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
