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

  // ─── create_ticket_with_automation codes (B.2.A.Step12 §3.11) ────────────
  | 'create_ticket_with_automation.input_invalid'
  | 'create_ticket_with_automation.request_type_not_found'
  | 'create_ticket_with_automation.malformed_response'
  | 'automation_plan.effective_location_mismatch'
  | 'automation_plan.semantic_mismatch'
  | 'automation_plan.scope_override_mismatch'
  | 'automation_plan.routing_input_mismatch'
  | 'automation_plan.stale_resolution'

  // ─── reclassify_ticket RPC codes (B.2.A.Step11 §3.10) ────────────────────
  | 'reclassify_ticket.ticket_not_found'
  | 'reclassify_ticket.reclassify_during_approval'
  | 'reclassify_ticket.new_request_type_invalid'
  | 'reclassify_ticket.target_same'
  | 'reclassify_ticket.input_invalid'
  // Step11 self-review F-CRIT-1: defense-in-depth terminal-state guard.
  // TS layer rejects closed/resolved tickets via assertReclassifiable;
  // the RPC was bypassable by non-HTTP callers (psql, seed, orchestrator).
  // Migration 00355 adds the symmetric PG-side check.
  | 'reclassify_ticket.terminal_ticket'

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
  | 'booking.cancelled_cannot_edit'
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
  // ─── grant_ticket_approval RPC (B.2.A.Step10 reland §3.5) ────────────────
  // Six codes raised by migration 00356_grant_ticket_approval_rpc.sql.
  // mapRpcErrorToAppError routes them via STATUS_BY_CODE entries in
  // apps/api/src/common/errors/map-rpc-error.ts.
  | 'grant_ticket_approval.approval_not_found'
  | 'grant_ticket_approval.invalid_target_entity_type'
  | 'grant_ticket_approval.tenant_mismatch'
  | 'grant_ticket_approval.invalid_response'
  | 'grant_ticket_approval.ticket_not_found'
  | 'grant_ticket_approval.cas_lost'
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
  | 'org_node.has_children'
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

  // ─── auth migration (Phase 7.B-1.auth) ───────────────────────────────────
  | 'auth.missing_header'
  | 'auth.invalid_token'
  | 'auth.role_lookup_failed'
  | 'auth.user_not_in_tenant'
  | 'auth.admin_required'

  // ─── webhook migration (Phase 7.B-1.webhook) ─────────────────────────────
  | 'webhook.not_found'
  | 'webhook.tenant_resolution_failed'
  | 'webhook.invalid_mapping'
  | 'webhook.missing_api_key'
  | 'webhook.invalid_api_key'
  | 'webhook.inactive'
  | 'webhook.source_ip_unresolvable'
  | 'webhook.source_ip_not_permitted'

  // ─── workflow migration (Phase 7.B-1.workflow) ───────────────────────────
  | 'workflow.not_found'
  | 'workflow.invalid'
  | 'workflow_instance.not_found'

  // ─── service-routing migration (Phase 7.B-1.service-routing) ─────────────
  | 'service_routing_not_found'
  | 'service_routing_duplicate'
  | 'service_routing_immutable_key'
  | 'invalid_foreign_key'
  | 'invalid_service_category'
  | 'setup_routing_failed'

  // ─── routing migration (Phase 7.B-1.routing) ─────────────────────────────
  | 'routing.field_required'
  | 'routing.body_required'
  | 'routing.db_failed'
  | 'routing.not_found'
  | 'routing.invalid_definition'
  | 'routing.invalid_state'
  | 'routing.duplicate'
  | 'routing.v2_not_implemented'

  // ─── common migration (Phase 7.B-1.common) ───────────────────────────────
  | 'person.not_found'
  | 'tenant.unknown'
  | 'mail.config_missing'
  | 'mail.dispatch_failed'
  | 'mail.invalid_recipient'
  | 'mail.webhook_unauthorized'
  | 'mail.webhook_invalid'
  | 'reference.field_invalid'
  | 'reference.invalid_array_size'
  | 'client_request_id.required'
  | 'client_request_id.invalid'

  // ─── visitors migration (Phase 7.B-1.visitors) ───────────────────────────
  | 'visitor.not_found'
  | 'visitor.invalid_payload'
  | 'visitor.invalid_state'
  | 'visitor.forbidden'
  | 'visitor.unauthorized'
  | 'visitor.conflict'
  | 'visitor.field_required'
  | 'visitor.invalid_uuid'
  | 'visitor.duplicate'
  | 'visitor.host_not_found'
  | 'visitor.kiosk_unauthorized'
  | 'visitor.pass_not_found'
  | 'visitor.pass_unavailable'
  | 'visitor.invitation_not_found'
  | 'visitor.reception_failed'
  | 'visitor.notification_failed'
  | 'visitor.invalid_token'
  | 'visitor.config_missing'
  // Phase 7.B-1 review fixes (status-class drift)
  | 'visitor.host_required'
  | 'visitor.tenant_mismatch'
  | 'visitor_type.not_found'
  | 'visitor_pass.not_found'
  | 'kiosk_token.not_found'
  | 'pool_anchor.not_found'
  | 'pool_anchor.invalid'

  // ─── B.2.A §3.1 transition_entity_status RPC (00323/00325) ───────────────
  | 'transition_entity_status.unknown_kind'
  | 'transition_entity_status.not_found'
  | 'transition_entity_status.has_open_children'
  | 'transition_entity_status.invalid_status'
  | 'transition_entity_status.invalid_status_category'
  | 'command_operations.payload_mismatch'
  | 'command_operations.unexpected_state'
  | 'command_operations.client_request_id_required'
  | 'work_order.parent_terminal'

  // ─── B.2.A §3.2 set_entity_assignment RPC (00326) ────────────────────────
  | 'set_entity_assignment.unknown_kind'
  | 'set_entity_assignment.not_found'
  | 'set_entity_assignment.resolver_rerun_not_supported_at_rpc'

  // ─── B.2.A §3.3 update_entity_sla RPC (00328) ────────────────────────────
  | 'update_entity_sla.unknown_kind'
  | 'update_entity_sla.not_found'
  | 'update_entity_sla.timers_required'
  | 'update_entity_sla.sla_id_required'
  | 'sla.policy_not_found'
  | 'sla.policy_has_no_targets'

  // ─── B.2.A §3.0 update_entity_combined RPC (00331) ───────────────────────
  | 'update_entity_combined.unknown_kind'
  | 'update_entity_combined.not_found'
  | 'update_entity_combined.invalid_patches'
  | 'update_entity_combined.plan_not_supported_on_case'
  | 'update_entity_combined.invalid_priority'
  | 'update_entity_combined.invalid_metadata'
  | 'update_entity_combined.invalid_cost'
  | 'update_entity_combined.invalid_watcher'
  | 'update_entity_combined.invalid_plan'

  // ─── B.2.A §3.4 dispatch_child_work_order RPC (00338 / 00339 — v2) ───────
  // `parent_not_case` removed in remediation pass: post step1c.10c
  // `public.tickets` only holds case rows, so the RPC's parent SELECT
  // already returns parent_not_found for a work_order id — the
  // parent_not_case arm is unreachable. F-IMP-2 / plan-I2.
  | 'dispatch_child_work_order.parent_not_found'
  | 'dispatch_child_work_order.parent_not_dispatchable'
  | 'dispatch_child_work_order.invalid_payload'
  | 'dispatch_child_work_order.timers_required'
  | 'dispatch_child_work_orders_batch.empty_tasks'
  | 'dispatch_child_work_orders_batch.invalid_payload'

  // ─── tenant-FK validation helper (00317) — 422 codes ─────────────────────
  // The helper raises 42501-coded exceptions on first foreign-tenant miss.
  // Pre-registration these fell through `mapRpcErrorToAppError` to
  // `unknown.server_error` (500). Registered here so that any RPC defense-
  // in-depth raise routes to a clean 422 with neutral copy. F-IMP-4 / code-I1.
  | 'validate_assignees_in_tenant.assigned_team_id_not_in_tenant'
  | 'validate_assignees_in_tenant.assigned_user_id_not_in_tenant'
  | 'validate_assignees_in_tenant.assigned_vendor_id_not_in_tenant'

  // ─── tenant-entity validation helper (00321 / 00340) — 404 + 400 codes ───
  // `validate_entity_in_tenant` (00321 v2 + 00340 v3) raises 42501 on each
  // per-kind miss plus a global `unknown_kind` / `dispatch_missing` raise
  // for caller-side typos. Codex-S8-I2 (F-IMP-2): every code raised by
  // the helper MUST be registered or the §3.0/§3.1/§3.2/§3.3/§3.4 RPCs'
  // defense-in-depth path falls through `mapRpcErrorToAppError` to
  // `unknown.server_error` 500 — same regression class as the
  // validate_assignees_in_tenant pre-registration miss.
  | 'validate_entity_in_tenant.unknown_kind'
  | 'validate_entity_in_tenant.dispatch_missing'
  | 'validate_entity_in_tenant.case_not_in_tenant'
  | 'validate_entity_in_tenant.work_order_not_in_tenant'
  | 'validate_entity_in_tenant.asset_not_in_tenant'
  | 'validate_entity_in_tenant.space_not_in_tenant'
  | 'validate_entity_in_tenant.request_type_not_in_tenant'
  | 'validate_entity_in_tenant.scope_override_not_in_tenant'
  | 'validate_entity_in_tenant.workflow_definition_not_in_tenant'
  | 'validate_entity_in_tenant.sla_policy_not_in_tenant'
  | 'validate_entity_in_tenant.person_not_in_tenant'
  | 'validate_entity_in_tenant.routing_rule_not_in_tenant'
  // v4 (00359) — B.4.A.2 edit_booking foundation. booking_rule covers the
  // bookings.applied_rule_ids[] (→ room_booking_rules) cross-tenant gap;
  // cost_center covers the bookings.cost_center_id (→ cost_centers) FK
  // the edit_booking RPC rewrites when the host's default differs by
  // building. Both routed to 404 by map-rpc-error STATUS_BY_CODE,
  // mirroring the v3 'routing_rule' addition.
  | 'validate_entity_in_tenant.booking_rule_not_in_tenant'
  | 'validate_entity_in_tenant.cost_center_not_in_tenant'
  // v5 (00360) — codex finding. team covers the
  // approvals.approver_team_id (→ teams) GLOBAL FK gap that the
  // edit_booking RPC §3.6.5 approval-chain INSERTs would otherwise
  // commit cross-tenant. Same shape as Codex-S8-I1 routing_rule
  // (the team FK at 00012:12 doesn't join through teams.tenant_id
  // at 00003:100). Routed to 404 by map-rpc-error STATUS_BY_CODE.
  | 'validate_entity_in_tenant.team_not_in_tenant'

  // ─── privacy-compliance migration (Phase 7.B-1.privacy-compliance) ───────
  | 'privacy.invalid_payload'
  | 'privacy.reason_required'
  | 'privacy.hold_create_failed'
  | 'privacy.hold_not_found'
  | 'privacy.retention_not_found'
  | 'privacy.retention_invalid'
  | 'privacy.dsr_not_found'
  | 'privacy.dsr_invalid_state'
  | 'privacy.dsr_create_failed'
  | 'privacy.bundle_upload_failed'
  | 'privacy.signed_url_failed'
  | 'privacy.subject_not_found'
  | 'privacy.unknown_data_category'

  // ─── vendor-portal migration (Phase 7.B-1.vendor-portal) ─────────────────
  | 'vendor_portal.order_not_found'
  | 'vendor_portal.invalid_email'
  | 'vendor_portal.invalid_role'
  | 'vendor_portal.invite_failed'
  | 'vendor_portal.user_create_failed'
  | 'vendor_portal.user_not_found'
  | 'vendor_portal.user_deactivated'
  | 'vendor_portal.user_locked'
  | 'vendor_portal.magic_link_invalid'
  | 'vendor_portal.user_missing'
  | 'vendor_portal.token_required'
  | 'vendor_portal.no_session'
  | 'vendor_portal.session_invalid'
  | 'vendor_portal.field_required'
  | 'vendor_portal.invalid_status'
  | 'vendor_portal.invalid_transition'
  | 'vendor_portal.decline_reason_required'

  // ─── room-booking-rules migration (Phase 7.B-1.room-booking-rules) ───────
  | 'room_rule.template_param_required'
  | 'room_rule.template_invalid'
  | 'room_rule.invalid_predicate'
  | 'room_rule.scenario_not_found'
  | 'room_rule.not_found'
  | 'room_rule.version_not_found'
  | 'room_rule.invalid_effect'
  | 'room_rule.name_required'
  | 'room_rule.invalid_scope'
  | 'room_rule.space_not_found'
  | 'room_rule.impact_failed'

  // ─── calendar-sync migration (Phase 7.B-1.calendar-sync) ─────────────────
  | 'calendar_sync.no_auth'
  | 'calendar_sync.invalid_state'
  | 'calendar_sync.state_user_mismatch'
  | 'calendar_sync.no_link'
  | 'calendar_sync.conflict_not_found'
  | 'calendar_sync.conflict_not_open'
  | 'calendar_sync.link_not_found'
  | 'calendar_sync.no_user_in_tenant'
  | 'calendar_sync.token_failed'
  | 'calendar_sync.graph_failed'
  | 'calendar_sync.config_missing'

  // ─── config-engine migration (Phase 7.B-1.config-engine) ─────────────────
  | 'config_engine.invalid_expression'
  | 'config_engine.criteria_set_not_found'
  | 'config_engine.entity_not_found'
  | 'config_engine.draft_not_found'
  | 'config_engine.no_draft_to_publish'
  | 'config_engine.version_not_found'
  | 'config_engine.invalid_hierarchy'
  | 'config_engine.invalid_cover_source'
  | 'config_engine.file_required'
  | 'config_engine.unsupported_mime'
  | 'config_engine.file_too_large'
  | 'config_engine.upload_failed'
  | 'config_engine.update_failed'
  | 'config_engine.category_not_found'
  | 'config_engine.invalid_request_type'
  | 'config_engine.request_type_not_found'
  | 'config_engine.invalid_scope'
  | 'config_engine.invalid_handler'

  // ─── daily-list migration (Phase 7.B-1.daily-list) ───────────────────────
  | 'daily_list.pdf_renderer_unavailable'
  | 'daily_list.line_not_found'
  | 'daily_list.invalid_payload'
  | 'daily_list.invalid_date'
  | 'daily_list.body_required'
  | 'daily_list.field_required'
  | 'daily_list.mailer_failed'
  | 'daily_list.vendor_not_found'
  | 'daily_list.invalid_vendor'
  | 'daily_list.not_found'
  | 'daily_list.upload_failed'
  | 'daily_list.signed_url_failed'
  | 'daily_list.no_email'
  | 'daily_list.send_failed'
  | 'daily_list.pdf_missing'

  // ─── orders migration (Phase 7.B-1.orders) ───────────────────────────────
  | 'no_lines'
  | 'missing_location'
  | 'missing_window'
  | 'no_person'
  | 'no_user'
  | 'order_not_found'
  | 'master_order_not_found'
  | 'line_not_editable'
  | 'orders.not_implemented'
  | 'orders.approval_routing_failed'

  // ─── portal migration (Phase 7.B-1.portal) ───────────────────────────────
  | 'portal.no_linked_person'
  | 'portal.no_user_in_tenant'
  | 'portal.person_not_found'
  | 'portal.user_not_found'
  | 'portal.parent_space_not_found'
  | 'portal.request_type_not_found'
  | 'portal.field_required'
  | 'portal.unsupported_media_type'
  | 'portal.avatar_too_large'
  | 'portal.location_not_authorized'
  | 'portal.self_onboard_disabled'
  | 'portal.self_onboard_forbidden_person_type'
  | 'portal.default_already_set'
  | 'portal.grants_exist'
  | 'portal.requestable_failed'
  | 'portal.request_type_required'
  | 'portal.asset_not_found'

  // ─── tenant migration (Phase 7.B-1.tenant) ───────────────────────────────
  | 'tenant.not_found'
  | 'tenant.name_required'
  | 'tenant.name_too_long'
  | 'tenant.invalid_theme_mode'
  | 'tenant.invalid_color'
  | 'tenant.invalid_image_kind'
  | 'tenant.file_required'
  | 'tenant.invalid_svg'
  | 'tenant.update_failed'
  | 'tenant.upload_failed'

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
  | 'work_order.rerun_resolver_unsupported'

  // ─── B.4.A edit_booking RPC codes ──────────────────────────────────────
  // Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4 + §3.6.5.
  // v3 (00363) — codex Critical 2 — booking-scope rejections for child-row
  // patches. NULLABLE booking_id on the three sibling tables (00278:91/
  // 116/140) meant tenant-only filtering let cross-booking patches sneak
  // through; v3 raises these 404s when a patch references a child row not
  // anchored to p_booking_id.
  // v4 (00364) — approval reconciliation per §3.6.5 lands inside the RPC.
  // `approval_reconciliation_required` is RETIRED (no TS callers; lived
  // only in registries). `deny_on_edit` is the new 422 raised when the
  // rule resolver's new outcome is `deny` for the edit target (Row 10).
  | 'edit_booking.actor_not_found'
  | 'edit_booking.not_found'
  | 'edit_booking.invalid_plan_shape'
  | 'edit_booking.deny_on_edit'
  | 'edit_booking.work_order_not_in_booking'
  | 'edit_booking.order_not_in_booking'
  | 'edit_booking.asset_reservation_not_in_booking'
  // B.4.A.4 step 2D-C self-review remediation (PLAN-C1).
  // TS-side fail-fast at AssembleEditPlanService when the rule resolver's
  // new outcome is `require_approval` but `approvalConfig` is null OR
  // `required_approvers` is empty. Without this, the plan would shape
  // `new_chain_config=null` + Row 2/7/8 INSERT action, hitting 00364:577-583
  // with a misleading "edit_booking.invalid_plan_shape" 400. 422 is correct
  // (payload valid, server config blocks the action — same shape as
  // edit_booking.deny_on_edit). Possible when rule-resolver.service.ts:514
  // returns approvalConfig=null for a require_approval rule, or when the
  // rule is configured with required_approvers=[].
  | 'edit_booking.rule_missing_approvers'
  // B.4.A.4 step 2D-C self-review remediation (CODE-I2).
  // TS-side throw at edit-plan-helpers.ts loadCurrentApprovalChain when the
  // supabase admin read of `approvals` fails. Previously swallowed → null,
  // which lied about chain presence (caller derived old_outcome='allow').
  // 500 server-class — DB transient failures during plan assembly are not a
  // user payload problem; surface with traceId so ops can investigate.
  | 'approval.read_failed'
  // B.4 step 2D-D — controller cutover gate (B.4.A.5 sequencing).
  // Until B.4.A.5 ships notification dispatch (email approvers + in-app
  // inbox), TS controllers MUST pre-flight-reject any edit whose plan
  // would emit `booking.approval_required` (rows 2/7/8 of §3.6.5). The
  // reject prevents an approval chain from being committed without any
  // approver being notified — a silent stall worse than a clean 422.
  // Validation-class 422 (not 503) routes through the web classifier as
  // class:'validation' — surfaces inline as a form-level error with
  // concrete operator guidance, not as a retry-loop + contact-support
  // toast (which is what >=500 classes get). Reviewer-driven flip from
  // 503 → 422 in commit `fb7b163f`. Reference:
  // docs/follow-ups/b4-followups.md "Sequencing — controller cutover
  // MUST land in or after notification dispatch (B.4.A.5)".
  | 'booking.edit_requires_notification_dispatch'

  // ─── floor_plan ──────────────────────────────────────────────────────────
  | 'floor_plan.draft.not_found'
  | 'floor_plan.draft.create_failed'
  | 'floor_plan.draft.update_failed'
  | 'floor_plan.draft.discard_failed'
  | 'floor_plan.draft.stale_update'
  | 'floor_plan.draft.invalid_polygons'
  | 'floor_plan.publish.image_required'
  | 'floor_plan.publish.unlinked_polygons'
  | 'floor_plan.publish.invalid_polygons'
  | 'floor_plan.publish.cross_tenant'
  | 'floor_plan.publish_failed'
  | 'floor_plan.list_failed'
  | 'floor_plan.history.not_found'
  | 'floor_plan.history.cross_tenant'
  | 'floor_plan.restore_failed'
  | 'floor_plan.availability.invalid_window'
  | 'floor_plan.availability.invalid_args'
  | 'floor_plan.availability_failed';

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
  'create_ticket_with_automation.input_invalid',
  'create_ticket_with_automation.request_type_not_found',
  'create_ticket_with_automation.malformed_response',
  'automation_plan.effective_location_mismatch',
  'automation_plan.semantic_mismatch',
  'automation_plan.scope_override_mismatch',
  'automation_plan.routing_input_mismatch',
  'automation_plan.stale_resolution',
  'reclassify_ticket.ticket_not_found',
  'reclassify_ticket.reclassify_during_approval',
  'reclassify_ticket.new_request_type_invalid',
  'reclassify_ticket.target_same',
  'reclassify_ticket.input_invalid',
  'reclassify_ticket.terminal_ticket',
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
  'booking.cancelled_cannot_edit',
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
  // ─── grant_ticket_approval RPC (B.2.A.Step10 reland §3.5) ────────────────
  'grant_ticket_approval.approval_not_found',
  'grant_ticket_approval.invalid_target_entity_type',
  'grant_ticket_approval.tenant_mismatch',
  'grant_ticket_approval.invalid_response',
  'grant_ticket_approval.ticket_not_found',
  'grant_ticket_approval.cas_lost',
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
  'org_node.has_children',
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
  'auth.missing_header',
  'auth.invalid_token',
  'auth.role_lookup_failed',
  'auth.user_not_in_tenant',
  'auth.admin_required',
  'webhook.not_found',
  'webhook.tenant_resolution_failed',
  'webhook.invalid_mapping',
  'webhook.missing_api_key',
  'webhook.invalid_api_key',
  'webhook.inactive',
  'webhook.source_ip_unresolvable',
  'webhook.source_ip_not_permitted',
  'tenant.not_found',
  'tenant.name_required',
  'tenant.name_too_long',
  'tenant.invalid_theme_mode',
  'tenant.invalid_color',
  'tenant.invalid_image_kind',
  'tenant.file_required',
  'tenant.invalid_svg',
  'tenant.update_failed',
  'tenant.upload_failed',
  'workflow.not_found',
  'workflow.invalid',
  'workflow_instance.not_found',
  'service_routing_not_found',
  'service_routing_duplicate',
  'service_routing_immutable_key',
  'invalid_foreign_key',
  'invalid_service_category',
  'setup_routing_failed',
  'portal.no_linked_person',
  'portal.no_user_in_tenant',
  'portal.person_not_found',
  'portal.user_not_found',
  'portal.parent_space_not_found',
  'portal.request_type_not_found',
  'portal.field_required',
  'portal.unsupported_media_type',
  'portal.avatar_too_large',
  'portal.location_not_authorized',
  'portal.self_onboard_disabled',
  'portal.self_onboard_forbidden_person_type',
  'portal.default_already_set',
  'portal.grants_exist',
  'portal.requestable_failed',
  'portal.request_type_required',
  'portal.asset_not_found',
  'no_lines',
  'missing_location',
  'missing_window',
  'no_person',
  'no_user',
  'order_not_found',
  'master_order_not_found',
  'line_not_editable',
  'orders.not_implemented',
  'orders.approval_routing_failed',
  'daily_list.pdf_renderer_unavailable',
  'daily_list.line_not_found',
  'daily_list.invalid_payload',
  'daily_list.invalid_date',
  'daily_list.body_required',
  'daily_list.field_required',
  'daily_list.mailer_failed',
  'daily_list.vendor_not_found',
  'daily_list.invalid_vendor',
  'daily_list.not_found',
  'daily_list.upload_failed',
  'daily_list.signed_url_failed',
  'daily_list.no_email',
  'daily_list.send_failed',
  'daily_list.pdf_missing',
  'config_engine.invalid_expression',
  'config_engine.criteria_set_not_found',
  'config_engine.entity_not_found',
  'config_engine.draft_not_found',
  'config_engine.no_draft_to_publish',
  'config_engine.version_not_found',
  'config_engine.invalid_hierarchy',
  'config_engine.invalid_cover_source',
  'config_engine.file_required',
  'config_engine.unsupported_mime',
  'config_engine.file_too_large',
  'config_engine.upload_failed',
  'config_engine.update_failed',
  'config_engine.category_not_found',
  'config_engine.invalid_request_type',
  'config_engine.request_type_not_found',
  'config_engine.invalid_scope',
  'config_engine.invalid_handler',
  'calendar_sync.no_auth',
  'calendar_sync.invalid_state',
  'calendar_sync.state_user_mismatch',
  'calendar_sync.no_link',
  'calendar_sync.conflict_not_found',
  'calendar_sync.conflict_not_open',
  'calendar_sync.link_not_found',
  'calendar_sync.no_user_in_tenant',
  'calendar_sync.token_failed',
  'calendar_sync.graph_failed',
  'calendar_sync.config_missing',
  'room_rule.template_param_required',
  'room_rule.template_invalid',
  'room_rule.invalid_predicate',
  'room_rule.scenario_not_found',
  'room_rule.not_found',
  'room_rule.version_not_found',
  'room_rule.invalid_effect',
  'room_rule.name_required',
  'room_rule.invalid_scope',
  'room_rule.space_not_found',
  'room_rule.impact_failed',
  'vendor_portal.order_not_found',
  'vendor_portal.invalid_email',
  'vendor_portal.invalid_role',
  'vendor_portal.invite_failed',
  'vendor_portal.user_create_failed',
  'vendor_portal.user_not_found',
  'vendor_portal.user_deactivated',
  'vendor_portal.user_locked',
  'vendor_portal.magic_link_invalid',
  'vendor_portal.user_missing',
  'vendor_portal.token_required',
  'vendor_portal.no_session',
  'vendor_portal.session_invalid',
  'vendor_portal.field_required',
  'vendor_portal.invalid_status',
  'vendor_portal.invalid_transition',
  'vendor_portal.decline_reason_required',
  'privacy.invalid_payload',
  'privacy.reason_required',
  'privacy.hold_create_failed',
  'privacy.hold_not_found',
  'privacy.retention_not_found',
  'privacy.retention_invalid',
  'privacy.dsr_not_found',
  'privacy.dsr_invalid_state',
  'privacy.dsr_create_failed',
  'privacy.bundle_upload_failed',
  'privacy.signed_url_failed',
  'privacy.subject_not_found',
  'privacy.unknown_data_category',
  'routing.field_required',
  'routing.body_required',
  'routing.db_failed',
  'routing.not_found',
  'routing.invalid_definition',
  'routing.invalid_state',
  'routing.duplicate',
  'routing.v2_not_implemented',
  'person.not_found',
  'tenant.unknown',
  'mail.config_missing',
  'mail.dispatch_failed',
  'mail.invalid_recipient',
  'mail.webhook_unauthorized',
  'mail.webhook_invalid',
  'reference.field_invalid',
  'reference.invalid_array_size',
  'client_request_id.required',
  'client_request_id.invalid',
  'visitor.not_found',
  'visitor.invalid_payload',
  'visitor.invalid_state',
  'visitor.forbidden',
  'visitor.unauthorized',
  'visitor.conflict',
  'visitor.field_required',
  'visitor.invalid_uuid',
  'visitor.duplicate',
  'visitor.host_not_found',
  'visitor.kiosk_unauthorized',
  'visitor.pass_not_found',
  'visitor.pass_unavailable',
  'visitor.invitation_not_found',
  'visitor.reception_failed',
  'visitor.notification_failed',
  'visitor.invalid_token',
  'visitor.config_missing',
  'visitor.host_required',
  'visitor.tenant_mismatch',
  'visitor_type.not_found',
  'visitor_pass.not_found',
  'kiosk_token.not_found',
  'pool_anchor.not_found',
  'pool_anchor.invalid',
  'transition_entity_status.unknown_kind',
  'transition_entity_status.not_found',
  'transition_entity_status.has_open_children',
  'transition_entity_status.invalid_status',
  'transition_entity_status.invalid_status_category',
  'command_operations.payload_mismatch',
  'command_operations.unexpected_state',
  'command_operations.client_request_id_required',
  'work_order.parent_terminal',
  'set_entity_assignment.unknown_kind',
  'set_entity_assignment.not_found',
  'set_entity_assignment.resolver_rerun_not_supported_at_rpc',
  'update_entity_sla.unknown_kind',
  'update_entity_sla.not_found',
  'update_entity_sla.timers_required',
  'update_entity_sla.sla_id_required',
  'sla.policy_not_found',
  'sla.policy_has_no_targets',
  'update_entity_combined.unknown_kind',
  'update_entity_combined.not_found',
  'update_entity_combined.invalid_patches',
  'update_entity_combined.plan_not_supported_on_case',
  'update_entity_combined.invalid_priority',
  'update_entity_combined.invalid_metadata',
  'update_entity_combined.invalid_cost',
  'update_entity_combined.invalid_watcher',
  'update_entity_combined.invalid_plan',
  'dispatch_child_work_order.parent_not_found',
  'dispatch_child_work_order.parent_not_dispatchable',
  'dispatch_child_work_order.invalid_payload',
  'dispatch_child_work_order.timers_required',
  'dispatch_child_work_orders_batch.empty_tasks',
  'dispatch_child_work_orders_batch.invalid_payload',
  'validate_assignees_in_tenant.assigned_team_id_not_in_tenant',
  'validate_assignees_in_tenant.assigned_user_id_not_in_tenant',
  'validate_assignees_in_tenant.assigned_vendor_id_not_in_tenant',
  'validate_entity_in_tenant.unknown_kind',
  'validate_entity_in_tenant.dispatch_missing',
  'validate_entity_in_tenant.case_not_in_tenant',
  'validate_entity_in_tenant.work_order_not_in_tenant',
  'validate_entity_in_tenant.asset_not_in_tenant',
  'validate_entity_in_tenant.space_not_in_tenant',
  'validate_entity_in_tenant.request_type_not_in_tenant',
  'validate_entity_in_tenant.scope_override_not_in_tenant',
  'validate_entity_in_tenant.workflow_definition_not_in_tenant',
  'validate_entity_in_tenant.sla_policy_not_in_tenant',
  'validate_entity_in_tenant.person_not_in_tenant',
  'validate_entity_in_tenant.routing_rule_not_in_tenant',
  'validate_entity_in_tenant.booking_rule_not_in_tenant',
  'validate_entity_in_tenant.cost_center_not_in_tenant',
  'validate_entity_in_tenant.team_not_in_tenant',
  // B.4.A edit_booking RPC codes (00361 v1 → 00364 v4).
  'edit_booking.actor_not_found',
  'edit_booking.not_found',
  'edit_booking.invalid_plan_shape',
  // v4 (00364): deny-on-edit per §3.6.5 Row 10. Replaces v3's
  // `approval_reconciliation_required` (RETIRED — see edit_booking RPC
  // header for the supersession comment).
  'edit_booking.deny_on_edit',
  // v3 (00363) — codex Critical 2 — booking-scope rejections.
  'edit_booking.work_order_not_in_booking',
  'edit_booking.order_not_in_booking',
  'edit_booking.asset_reservation_not_in_booking',
  // B.4.A.4 step 2D-C self-review remediation (PLAN-C1 + CODE-I2).
  // rule_missing_approvers: TS-side fail-fast for require_approval-with-no-
  //   approvers (rule-resolver.service.ts:514 admits null approvalConfig).
  // approval.read_failed: TS-side throw replacing the silent null return on
  //   supabase error in loadCurrentApprovalChain.
  'edit_booking.rule_missing_approvers',
  'approval.read_failed',
  // B.4 step 2D-D — see KnownErrorCode union for rationale.
  'booking.edit_requires_notification_dispatch',
  // floor_plan module — A.9
  'floor_plan.draft.not_found',
  'floor_plan.draft.create_failed',
  'floor_plan.draft.update_failed',
  'floor_plan.draft.discard_failed',
  'floor_plan.draft.stale_update',
  'floor_plan.draft.invalid_polygons',
  'floor_plan.publish.image_required',
  'floor_plan.publish.unlinked_polygons',
  'floor_plan.publish.invalid_polygons',
  'floor_plan.publish.cross_tenant',
  'floor_plan.publish_failed',
  'floor_plan.list_failed',
  'floor_plan.history.not_found',
  'floor_plan.history.cross_tenant',
  'floor_plan.restore_failed',
  'floor_plan.availability.invalid_window',
  'floor_plan.availability.invalid_args',
  'floor_plan.availability_failed',
]);

/** Type-guard: is `code` a registered KnownErrorCode? */
export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN_ERROR_CODES.has(code as KnownErrorCode);
}
