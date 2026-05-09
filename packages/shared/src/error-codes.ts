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
  | 'sla.threshold_invalid'
  | 'sla.target_missing'

  // ─── booking-bundles module migration (Phase 7.A.2.c.i) ──────────────────
  | 'bundle.forbidden'
  | 'bundle.not_found'
  | 'bundle.no_services'
  | 'bundle.line_not_in_bundle'
  | 'bundle.invalid_quantity'
  | 'bundle.invalid_service_window'
  | 'bundle.invalid_requester_notes'
  | 'bundle.invalid_expected_updated_at'
  | 'bundle.lead_time_violation'
  | 'bundle.context_lookup_failed'
  | 'bundle.idempotency_key_required'
  | 'bundle.tenant_id_required'
  | 'booking.not_found'
  | 'asset.not_found'
  | 'catalog_item.not_found'
  | 'plan.idempotency_key_required'
  | 'plan.stable_index_required'
  | 'plan.client_line_id_required'
  // legacy snake_case codes — tests assert on these literal codes
  | 'service_rule_deny'
  | 'asset_conflict'
  | 'line_not_found'
  | 'line_state_changed'
  | 'line_frozen'
  | 'line_already_fulfilled'
  | 'client_line_id_required'
  | 'client_line_id_not_unique'

  // ─── reservations module migration (Phase 7.A.2.c.ii) ────────────────────
  // namespaced (preferred form for new codes)
  | 'booking.idempotency_payload_mismatch'
  | 'booking.fk_invalid'
  | 'booking.internal_ref_invalid'
  | 'booking.snapshot_uuid_invalid'
  | 'booking.unexpected_error'
  | 'booking.idempotency_key_required'
  | 'booking.completed_cannot_edit'
  | 'booking.not_editable'
  | 'booking.not_cancelled'
  | 'booking.cancellation_grace_expired'
  | 'booking.slot_taken'
  | 'booking.not_a_recurring_occurrence'
  | 'booking.too_early_to_check_in'
  | 'booking.already_ended'
  | 'booking.already_checked_in'
  | 'booking.not_confirmed'
  | 'booking.check_in_failed'
  | 'booking.magic_link_invalid'
  | 'booking.magic_link_booking_mismatch'
  | 'booking.magic_link_person_mismatch'
  | 'booking.scheduler_window_requires_range'
  | 'booking.no_primary_slot'
  | 'booking.edit_failed'
  | 'booking.list_failed'
  | 'booking.cancel_failed'
  | 'booking.skip_failed'
  | 'booking.restore_failed'
  | 'booking.scheduler_window_failed'
  | 'booking.bundle_not_injected'
  | 'booking.recurrence_not_injected'
  | 'booking.recurrence_series_not_found'
  | 'booking.master_not_found'
  | 'booking.recurrence_failed'
  | 'reservation.projection_no_parent'
  | 'auth.missing_user'
  | 'magic_check_in.secret_missing'
  // legacy snake_case codes (already asserted in specs / wire shape)
  | 'book_on_behalf_forbidden'
  | 'multi_room_booking_failed'
  | 'multi_room_requires_two'
  | 'multi_room_too_many'
  | 'multi_room_create_failed'
  | 'multi_room_read_failed'
  | 'rule_deny'
  | 'reservation_not_visible'
  | 'reservation_operator_required'
  | 'booking_not_found'
  | 'booking_not_editable'
  | 'booking_completed'
  | 'not_a_recurring_occurrence'
  | 'booking_slot_taken'
  | 'booking_already_ended'
  | 'booking_too_early_to_check_in'
  | 'booking_already_checked_in'
  | 'booking_not_confirmed'
  | 'check_in_failed'
  | 'magic_link_invalid'
  | 'magic_link_booking_mismatch'
  | 'magic_link_person_mismatch'
  | 'cancellation_grace_expired'
  | 'booking_not_cancelled'
  | 'scheduler_window_requires_range'
  | 'cancel_failed'
  | 'list_failed'
  | 'restore_failed'
  | 'skip_failed'
  | 'edit_failed'
  | 'group_siblings_failed'
  | 'list_for_operator_failed'
  | 'list_for_operator_orders'
  | 'load_spaces_failed'
  | 'scheduler_window_failed'
  | 'reservation_not_editable'
  | 'missing_user'

  // ─── approval module migration (Phase 7.A.2.d) ───────────────────────────
  | 'approval.not_found'
  | 'approval.already_responded'
  | 'approval.not_an_approver'
  | 'approval.no_person_record'
  | 'approval.cross_actor_pending'
  | 'approval.responding_user_required'
  | 'approval.grant_failed'
  | 'approval.non_booking_approved'
  | 'approval.cas_lost'
  | 'approval.invalid_decision'
  | 'vendor.unavailable'
  | 'vendor.not_in_scope'

  // ─── Phase 1 legacy snake_case codes (renamed in Phase 7.A.2) ────────────
  | 'insert_failed'
  | 'reservation_slot_conflict'
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
  | 'permission_denied'

  // ─── space module migration (Phase 7.B-1.space) ──────────────────────────
  | 'space.not_found'
  | 'space.parent_not_found'
  | 'space.invalid_root_type'
  | 'space.invalid_parent_type'

  // ─── reporting module migration (Phase 7.B-1.reporting) ──────────────────
  | 'report.invalid_date_range'
  | 'report.window_too_large'
  | 'report.rpc_failed'
  | 'report.invalid_date'

  // ─── portal-announcements migration (Phase 7.B-1.portal-announcements) ───
  | 'announcement.list_failed'
  | 'announcement.publish_failed'
  | 'announcement.unpublish_failed'
  | 'announcement.invalid_payload'
  | 'announcement.insert_no_row'

  // ─── person module migration (Phase 7.B-1.person) ────────────────────────
  | 'person.org_change_in_progress'

  // ─── org-node module migration (Phase 7.B-1.org-node) ────────────────────
  | 'org_node.not_found'
  | 'org_node.name_required'
  | 'org_node.create_failed'
  | 'org_node.update_failed'
  | 'org_node.delete_failed'
  | 'org_node.add_member_failed'
  | 'org_node.add_grant_failed'

  // ─── user-management migration (Phase 7.B-1.user-management) ────────────
  | 'user_management.invalid_permission_key'

  // ─── outbox migration (Phase 7.B-1.outbox) ───────────────────────────────
  | 'outbox.duplicate_handler'

  // ─── cost-centers migration (Phase 7.B-1.cost-centers) ───────────────────
  | 'cost_center_not_found'
  | 'cost_center_code_taken'
  | 'code_required'
  | 'code_too_long'

  // ─── bundle-templates migration (Phase 7.B-1.bundle-templates) ───────────
  | 'bundle_template_not_found'
  | 'invalid_services'
  | 'invalid_service_line'

  // ─── portal-appearance migration (Phase 7.B-1.portal-appearance) ────────
  | 'portal_appearance.location_required'
  | 'portal_appearance.file_required'
  | 'portal_appearance.unsupported_mime'
  | 'portal_appearance.file_too_large'
  | 'portal_appearance.list_failed'
  | 'portal_appearance.upsert_failed'
  | 'portal_appearance.upsert_no_row'
  | 'portal_appearance.upload_failed'
  | 'portal_appearance.delete_failed'

  // ─── service-catalog migration (Phase 7.B-1.service-catalog) ─────────────
  | 'service_rule_not_found'
  | 'name_required'
  | 'invalid_predicate'
  | 'target_id_required'
  | 'target_kind_required'
  | 'effect_required'
  | 'invalid_lead_time'
  | 'template_required'
  | 'template_not_found'
  | 'invalid_compiled_predicate'
  | 'param_required'
  | 'invalid_payload'
  | 'missing_delivery_space'
  | 'missing_service_type'

  // ─── work-orders module migration (Phase 7.B-1.work-orders) ──────────────
  | 'work_order.not_found'
  | 'work_order.body_required'
  | 'work_order.empty_update'
  | 'work_order.field_invalid'
  | 'work_order.title_empty'
  | 'work_order.priority_invalid'
  | 'work_order.cost_invalid'
  | 'work_order.tags_invalid'
  | 'work_order.watchers_invalid'
  | 'work_order.duration_invalid'
  | 'work_order.planned_start_invalid'
  | 'work_order.sla_unknown'
  | 'work_order.assignee_uuid_invalid'
  | 'work_order.no_longer_accessible'
  | 'work_order.permission_sla_override'
  | 'work_order.permission_priority_change'
  | 'work_order.permission_assign'
  | 'work_order.empty_status_update'
  | 'work_order.empty_assignment_update'
  | 'work_order.empty_metadata_update'
  | 'work_order.reassign_reason_required'
  | 'work_order.rerun_resolver_unsupported';

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
  'sla.threshold_invalid',
  'sla.target_missing',
  'bundle.forbidden',
  'bundle.not_found',
  'bundle.no_services',
  'bundle.line_not_in_bundle',
  'bundle.invalid_quantity',
  'bundle.invalid_service_window',
  'bundle.invalid_requester_notes',
  'bundle.invalid_expected_updated_at',
  'bundle.lead_time_violation',
  'bundle.context_lookup_failed',
  'bundle.idempotency_key_required',
  'bundle.tenant_id_required',
  'booking.not_found',
  'asset.not_found',
  'catalog_item.not_found',
  'plan.idempotency_key_required',
  'plan.stable_index_required',
  'plan.client_line_id_required',
  'service_rule_deny',
  'asset_conflict',
  'line_not_found',
  'line_state_changed',
  'line_frozen',
  'line_already_fulfilled',
  'client_line_id_required',
  'client_line_id_not_unique',
  'booking.idempotency_payload_mismatch',
  'booking.fk_invalid',
  'booking.internal_ref_invalid',
  'booking.snapshot_uuid_invalid',
  'booking.unexpected_error',
  'booking.idempotency_key_required',
  'booking.completed_cannot_edit',
  'booking.not_editable',
  'booking.not_cancelled',
  'booking.cancellation_grace_expired',
  'booking.slot_taken',
  'booking.not_a_recurring_occurrence',
  'booking.too_early_to_check_in',
  'booking.already_ended',
  'booking.already_checked_in',
  'booking.not_confirmed',
  'booking.check_in_failed',
  'booking.magic_link_invalid',
  'booking.magic_link_booking_mismatch',
  'booking.magic_link_person_mismatch',
  'booking.scheduler_window_requires_range',
  'booking.no_primary_slot',
  'booking.edit_failed',
  'booking.list_failed',
  'booking.cancel_failed',
  'booking.skip_failed',
  'booking.restore_failed',
  'booking.scheduler_window_failed',
  'booking.bundle_not_injected',
  'booking.recurrence_not_injected',
  'booking.recurrence_series_not_found',
  'booking.master_not_found',
  'booking.recurrence_failed',
  'reservation.projection_no_parent',
  'auth.missing_user',
  'magic_check_in.secret_missing',
  'book_on_behalf_forbidden',
  'multi_room_booking_failed',
  'multi_room_requires_two',
  'multi_room_too_many',
  'multi_room_create_failed',
  'multi_room_read_failed',
  'rule_deny',
  'reservation_not_visible',
  'reservation_operator_required',
  'booking_not_found',
  'booking_not_editable',
  'booking_completed',
  'not_a_recurring_occurrence',
  'booking_slot_taken',
  'booking_already_ended',
  'booking_too_early_to_check_in',
  'booking_already_checked_in',
  'booking_not_confirmed',
  'check_in_failed',
  'magic_link_invalid',
  'magic_link_booking_mismatch',
  'magic_link_person_mismatch',
  'cancellation_grace_expired',
  'booking_not_cancelled',
  'scheduler_window_requires_range',
  'cancel_failed',
  'list_failed',
  'restore_failed',
  'skip_failed',
  'edit_failed',
  'group_siblings_failed',
  'list_for_operator_failed',
  'list_for_operator_orders',
  'load_spaces_failed',
  'scheduler_window_failed',
  'reservation_not_editable',
  'missing_user',
  'approval.not_found',
  'approval.already_responded',
  'approval.not_an_approver',
  'approval.no_person_record',
  'approval.cross_actor_pending',
  'approval.responding_user_required',
  'approval.grant_failed',
  'approval.non_booking_approved',
  'approval.cas_lost',
  'approval.invalid_decision',
  'vendor.unavailable',
  'vendor.not_in_scope',
  'insert_failed',
  'reservation_slot_conflict',
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
  'space.not_found',
  'space.parent_not_found',
  'space.invalid_root_type',
  'space.invalid_parent_type',
  'report.invalid_date_range',
  'report.window_too_large',
  'report.rpc_failed',
  'report.invalid_date',
  'announcement.list_failed',
  'announcement.publish_failed',
  'announcement.unpublish_failed',
  'announcement.invalid_payload',
  'announcement.insert_no_row',
  'person.org_change_in_progress',
  'org_node.not_found',
  'org_node.name_required',
  'org_node.create_failed',
  'org_node.update_failed',
  'org_node.delete_failed',
  'org_node.add_member_failed',
  'org_node.add_grant_failed',
  'work_order.not_found',
  'work_order.body_required',
  'work_order.empty_update',
  'work_order.field_invalid',
  'work_order.title_empty',
  'work_order.priority_invalid',
  'work_order.cost_invalid',
  'work_order.tags_invalid',
  'work_order.watchers_invalid',
  'work_order.duration_invalid',
  'work_order.planned_start_invalid',
  'work_order.sla_unknown',
  'work_order.assignee_uuid_invalid',
  'work_order.no_longer_accessible',
  'work_order.permission_sla_override',
  'work_order.permission_priority_change',
  'work_order.permission_assign',
  'work_order.empty_status_update',
  'work_order.empty_assignment_update',
  'work_order.empty_metadata_update',
  'work_order.reassign_reason_required',
  'work_order.rerun_resolver_unsupported',
  'user_management.invalid_permission_key',
  'service_rule_not_found',
  'name_required',
  'invalid_predicate',
  'target_id_required',
  'target_kind_required',
  'effect_required',
  'invalid_lead_time',
  'template_required',
  'template_not_found',
  'invalid_compiled_predicate',
  'param_required',
  'invalid_payload',
  'missing_delivery_space',
  'missing_service_type',
  'portal_appearance.location_required',
  'portal_appearance.file_required',
  'portal_appearance.unsupported_mime',
  'portal_appearance.file_too_large',
  'portal_appearance.list_failed',
  'portal_appearance.upsert_failed',
  'portal_appearance.upsert_no_row',
  'portal_appearance.upload_failed',
  'portal_appearance.delete_failed',
  'outbox.duplicate_handler',
  'cost_center_not_found',
  'cost_center_code_taken',
  'code_required',
  'code_too_long',
  'bundle_template_not_found',
  'invalid_services',
  'invalid_service_line',
]);

/** Type-guard: is `code` a registered KnownErrorCode? */
export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN_ERROR_CODES.has(code as KnownErrorCode);
}
