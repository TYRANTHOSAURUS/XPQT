/**
 * mapRpcErrorToAppError — translate a PostgrestError raised by a plpgsql RPC
 * into an AppError carrying the registered code.
 *
 * The plpgsql RPCs (00323–00333) raise exceptions of the shape:
 *
 *     <namespace>.<specifier>[: <details...>]
 *
 * supabase-js surfaces the RAISE message verbatim on `PostgrestError.message`.
 * This helper extracts the leading `<namespace>.<specifier>` token, checks
 * it against the registered `KNOWN_ERROR_CODES` set (defence-in-depth — the
 * AppError filter fail-closes on unregistered codes anyway), and routes it
 * to the right AppError factory based on a per-code status mapping.
 *
 * The status mapping is hand-curated rather than parsed from SQLSTATE because
 * plpgsql RPCs use `errcode = 'P0001'` for ~every domain error — SQLSTATE is
 * not informative. The mapping below is keyed on the registered code itself.
 *
 * Reference: spec §3.0/§3.1/§3.2/§3.3 of
 *   docs/follow-ups/b2-survey-and-design.md
 *
 * Citations:
 *   - 00325:84-86  transition_entity_status.unknown_kind
 *   - 00325:142    transition_entity_status.not_found
 *   - 00325:179-181 transition_entity_status.has_open_children
 *   - 00327:122-126 set_entity_assignment.resolver_rerun_not_supported_at_rpc
 *   - 00330:84-95   argument-shape preflight
 *   - 00330:104-107 update_entity_sla.sla_id_required
 *   - 00330:163-165 update_entity_sla.not_found
 *   - 00330:202-205 update_entity_sla.timers_required
 *   - 00333:172-179 argument-shape + invalid_patches
 *   - 00333:192-194 plan_not_supported_on_case
 *   - 00333:249-251 update_entity_combined.not_found
 *   - 00333:307-315 invalid_priority
 *   - 00333:509-510 invalid_metadata
 *   - 00333:544-549 invalid_cost
 *   - 00333:601-637 invalid_watcher
 *   - 00333:413-450 invalid_plan
 */

import { KNOWN_ERROR_CODES, type KnownErrorCode } from '@prequest/shared';
import { AppError, AppErrors } from './app-error';

interface PostgrestErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Map from registered RPC code → HTTP status. Codes not listed default to
 * 400 (validation/domain error). 404/409/500 must be explicit.
 */
const STATUS_BY_CODE: Partial<Record<KnownErrorCode, number>> = {
  // ── 400 bad_request ──────────────────────────────────────────────
  // Defense-in-depth — controller's RequireClientRequestIdGuard normally
  // returns 400 before we reach the service. This entry is for the TS-
  // layer guard at TicketService.update + WorkOrderService.update which
  // catches internal callers bypassing the controller.
  'command_operations.client_request_id_required': 400,
  // CODEX-B-3: SLA policy missing both response_time_minutes +
  // resolution_time_minutes. Raised TS-side in
  // SlaService.buildTimersForRpc (not by an RPC) — listed here for
  // defense-in-depth so that any future RPC-side raise of the same
  // code routes to 400 consistently.
  'sla.policy_has_no_targets': 400,
  // Codex-S8-I2 (F-IMP-2). validate_entity_in_tenant raises
  // `unknown_kind` / `dispatch_missing` when the caller passes a kind
  // outside the allowlist (typo or partial migration). That's a 400
  // class — the request payload itself referenced an unrecognised
  // entity kind.
  'validate_entity_in_tenant.unknown_kind': 400,
  'validate_entity_in_tenant.dispatch_missing': 400,
  // B.2.A.Step10 reland §3.5 — grant_ticket_approval input/state errors.
  // invalid_response: p_decision was not 'approved' | 'rejected'. The
  //   TS layer narrows dto.status before calling, so this is a 400
  //   defense-in-depth.
  // invalid_target_entity_type: caller routed a non-ticket approval
  //   through this RPC arm. respond() in TS filters on
  //   target_entity_type === 'ticket' before calling — RPC bails out
  //   cleanly without mutating. 400 (client routing mistake).
  // tenant_mismatch: defense-in-depth for the rare case where the
  //   tenant_id passed to the RPC doesn't match the approval row's
  //   tenant_id. 400 — caller passed mismatched values (TS should never
  //   do this, but a future non-HTTP caller could).
  'grant_ticket_approval.invalid_response': 400,
  'grant_ticket_approval.invalid_target_entity_type': 400,
  'grant_ticket_approval.tenant_mismatch': 400,
  // B.4.A.3 — edit_booking RPC (00361). p_plan failed top-level shape
  // checks (missing booking object, missing slot_patches array, missing
  // _resolution_at string, etc.). TS plan-build mints these via a Zod
  // schema; the raise is defense-in-depth for non-HTTP callers.
  'edit_booking.invalid_plan_shape': 400,
  // B.4 Step 2F.1 — edit_booking_scope.invalid_plans (00367). Caller
  // passed a non-array, empty array, or malformed {booking_id, plan}
  // element. Same 400 shape as edit_booking.invalid_plan_shape — defense-
  // in-depth for non-HTTP callers; TS plan-build mints these via a Zod
  // schema.
  'edit_booking_scope.invalid_plans': 400,

  // ── 404 not_found ────────────────────────────────────────────────
  'transition_entity_status.not_found': 404,
  'set_entity_assignment.not_found': 404,
  'update_entity_sla.not_found': 404,
  'update_entity_combined.not_found': 404,
  'sla.policy_not_found': 404,
  'dispatch_child_work_order.parent_not_found': 404,
  // Codex-S8-I2 (F-IMP-2). Every per-kind miss from
  // validate_entity_in_tenant is a "the foreign-tenant ref doesn't exist
  // in this tenant" condition — 404 is the right shape, matching the
  // pattern used by `dispatch_child_work_order.parent_not_found`.
  // routing_rule is added in v3 (00340) for codex-S8-I1 / F-IMP-1.
  'validate_entity_in_tenant.case_not_in_tenant': 404,
  'validate_entity_in_tenant.work_order_not_in_tenant': 404,
  'validate_entity_in_tenant.asset_not_in_tenant': 404,
  'validate_entity_in_tenant.space_not_in_tenant': 404,
  'validate_entity_in_tenant.request_type_not_in_tenant': 404,
  'validate_entity_in_tenant.scope_override_not_in_tenant': 404,
  'validate_entity_in_tenant.workflow_definition_not_in_tenant': 404,
  'validate_entity_in_tenant.sla_policy_not_in_tenant': 404,
  'validate_entity_in_tenant.person_not_in_tenant': 404,
  'validate_entity_in_tenant.routing_rule_not_in_tenant': 404,
  // booking_rule + cost_center added in v4 (00359) for B.4.A.2 — same
  // 404 shape as the rest of the family. booking_rule guards
  // bookings.applied_rule_ids[] (→ public.room_booking_rules);
  // cost_center guards bookings.cost_center_id (→ public.cost_centers).
  'validate_entity_in_tenant.booking_rule_not_in_tenant': 404,
  'validate_entity_in_tenant.cost_center_not_in_tenant': 404,
  // team added in v5 (00360) — codex finding. Guards
  // approvals.approver_team_id (00012:12 GLOBAL FK with no tenant
  // join) against the §3.6.5 edit_booking approval-chain INSERTs.
  // Same defense-in-depth shape as the v3 routing_rule (Codex-S8-I1)
  // and v4 booking_rule/cost_center additions.
  'validate_entity_in_tenant.team_not_in_tenant': 404,
  // B.2.A.Step12 §3.11 — create RPC's request-type-not-found path.
  'create_ticket_with_automation.request_type_not_found': 404,
  // B.2.A.Step11 §3.10 — reclassify_ticket RPC.
  'reclassify_ticket.ticket_not_found': 404,
  // B.2.A.Step10 reland §3.5 — grant_ticket_approval RPC's miss paths.
  // approval_not_found: the approvals row was deleted between TS read
  //   and the RPC's FOR UPDATE select.
  // ticket_not_found: defense-in-depth — the approvals FK doesn't
  //   constrain target_entity_id to tickets, but in practice a
  //   ticket-target row always references a real ticket. Hard-delete
  //   between approval insert + grant is the only way this fires.
  'grant_ticket_approval.approval_not_found': 404,
  'grant_ticket_approval.ticket_not_found': 404,
  // B.4.A.3 — edit_booking RPC (00361). actor_not_found fires when the
  // caller's auth_uid has no public.users row in the tenant (F-CRIT-1
  // resolution miss). not_found fires when the booking row is missing
  // or belongs to a different tenant. Same 404 shape as the other
  // RPC-side miss paths in this family.
  'edit_booking.actor_not_found': 404,
  'edit_booking.not_found': 404,
  // v3 (00363) — codex Critical 2 — booking-scope rejections for child-row
  // patches. The plan referenced a work_order / order / asset_reservation
  // that isn't anchored to this booking (NULL booking_id, or anchored to a
  // different booking in the same tenant). 404 mirrors the not_found shape:
  // from the caller's perspective the row is invisible inside this edit's
  // scope.
  'edit_booking.work_order_not_in_booking': 404,
  'edit_booking.order_not_in_booking': 404,
  'edit_booking.asset_reservation_not_in_booking': 404,
  // B.4 Step 2F.1 — edit_booking_scope.booking_not_found (00367). One
  // of the booking_ids in p_plans doesn't exist or belongs to a
  // different tenant. 404 mirrors edit_booking.not_found shape — from
  // the caller's perspective the row is invisible inside this edit's
  // scope. Caller refetches the scope-edit plan and retries.
  'edit_booking_scope.booking_not_found': 404,

  // ── 409 conflict ─────────────────────────────────────────────────
  // payload_mismatch: the client reused the same X-Client-Request-Id
  // for two different payloads. From the server's perspective the
  // resource is in a state that conflicts with the request — 409
  // Conflict is the correct shape. (Plan-review F-IMP-5 originally
  // proposed 500 but that implies a server bug; this is unambiguously
  // a client mistake — the message copy makes that explicit.)
  'transition_entity_status.has_open_children': 409,
  'command_operations.payload_mismatch': 409,
  'dispatch_child_work_order.parent_not_dispatchable': 409,
  // Codex remediation (00384) — authoritative plan_version race gate. The
  // RPC raises this AFTER `SELECT FOR UPDATE` on the work_orders row,
  // carrying `detail = jsonb_build_object('current_version', N+1,
  // 'client_version', N)::text`. Parsed below into AppErrors.conflict's
  // serverVersion/clientVersion so the wire body matches the TS pre-check
  // shape (work-order.service.ts:278-282) byte-for-byte.
  'planning.version_conflict': 409,
  // B.2.A.Step10 reland §3.5 — grant_ticket_approval CAS race.
  // CAS update missed despite advisory lock + FOR UPDATE; bug in the
  // lock code, not a normal user race. Surface as 409 + log so ops can
  // triage. Symmetric with approval.cas_lost from grant_booking_approval.
  'grant_ticket_approval.cas_lost': 409,
  // B.4 §3.4 step 5 — semantic re-derivation gate raises this when
  // booking_rules.updated_at advanced past the TS-side plan's
  // _resolution_at timestamp. The rule set shifted while the operator
  // was editing; caller must refetch the plan. 409 mirrors the
  // payload_mismatch shape: the resource is in a state that conflicts
  // with the request — not a payload bug, a between-read-and-write race.
  'automation_plan.stale_resolution': 409,

  // ── 422 unprocessable entity ─────────────────────────────────────
  // Tenant-FK validation helper (00317) raises 42501 on first
  // foreign-tenant miss. Defense-in-depth path — TS preflight already
  // rejects cross-tenant assignees with the same shape; this entry
  // routes the RPC-side raise to a clean 422 if the preflight regresses
  // or a non-HTTP caller bypasses it. F-IMP-4 / code-I1.
  'validate_assignees_in_tenant.assigned_team_id_not_in_tenant': 422,
  'validate_assignees_in_tenant.assigned_user_id_not_in_tenant': 422,
  'validate_assignees_in_tenant.assigned_vendor_id_not_in_tenant': 422,
  // B.2.A.Step11 §3.10 — reclassify_during_approval: the ticket has
  // non-terminal approvals; the operator must resolve them before
  // re-running reclassify. 422 unprocessable-entity is the right shape
  // (request payload is valid, but the ticket state blocks the action).
  'reclassify_ticket.reclassify_during_approval': 422,
  // Step11 self-review F-CRIT-1 — terminal_ticket: the ticket is in
  // resolved | closed state. The TS preflight already rejects this in
  // ReclassifyService.assertReclassifiable; the RPC raise is the
  // defense-in-depth path for non-HTTP callers (psql, seed, future
  // orchestrator). 422 — payload is valid, ticket state blocks action.
  'reclassify_ticket.terminal_ticket': 422,

  // B.2.A.Step9 — workflow `update_ticket` node config that references a
  // field outside the tightened allowlist throws this code (TS-side).
  // The raise is unprocessable-entity rather than 400 validation:
  // the request payload is syntactically valid jsonb of the right
  // shape, but the workflow definition itself is misconfigured — only
  // an admin can fix it. Defense-in-depth listing for any future
  // RPC-side raise of the same code (none today; the workflow engine
  // is the sole producer).
  'workflow.update_ticket_field_not_allowed': 422,
  // B.4 §3.6.5 — edit attempted on a cancelled (terminal_rejected) booking.
  // Sibling to booking.completed_cannot_edit / booking.not_editable; 422
  // because the request payload is valid but the booking state blocks the
  // action (same shape as reclassify_ticket.terminal_ticket).
  'booking.cancelled_cannot_edit': 422,
  // B.4.A.4 — edit_booking RPC (00364). Raised when the rule resolver's
  // new outcome is `deny` for the edit target (§3.6.5 Row 10). Mirrors
  // CREATE: deny is a hard 422 — no actor-override path here (override
  // is a separate concern, B.4.D follow-up). Replaces v3's
  // `approval_reconciliation_required` (RETIRED — approval reconciliation
  // now happens inside the RPC per §3.6.5 decision table).
  'edit_booking.deny_on_edit': 422,
  // B.4.A.4 step 2D-C self-review remediation (PLAN-C1).
  // rule_missing_approvers fires TS-side at AssembleEditPlanService when
  // the resolver returns require_approval but approvalConfig is null OR
  // required_approvers is empty. TS already constructs AppError with
  // status=422; this entry is defense-in-depth for any future RPC raise of
  // the same code (none today; the gate is exclusively TS-side).
  'edit_booking.rule_missing_approvers': 422,
  // B.4 Step 2F.1 — edit_booking_scope RPC (00367) 422 raises.
  // - too_many_occurrences: N > 200 hard cap. Request payload is valid;
  //   the system can't safely commit an unbounded all-or-none batch in
  //   one transaction. Operator must split the edit OR pass a chunk
  //   confirmation (TS UX in §7.B.4.C handles this above 100).
  // - mixed_series: booking_ids don't all share the same non-null
  //   recurrence_series_id. Request payload is valid jsonb; the
  //   scope-derivation in the caller is wrong (TS bug or non-HTTP
  //   smuggling). 422 routes to the validation surface so the operator
  //   sees the actionable detail ("retry from the scope picker") rather
  //   than a generic 500 retry-loop.
  'edit_booking_scope.too_many_occurrences': 422,
  'edit_booking_scope.mixed_series': 422,
  // B.4 Step 2F.2 — TS-side defensive raises (assembleScopeEditPlan).
  // 422 for caller-fixable problems (operator picks a different path /
  // refetches scope); 500 for internal-consistency bugs (controller
  // computed effectiveSeriesId then drifted; data corruption).
  'edit_booking_scope.time_shift_not_supported': 422,
  'edit_booking_scope.not_recurring': 422,
  'edit_booking_scope.empty_scope': 422,
  // B.2.A semantic re-derivation gates — RPCs raise these when the
  // TS-side plan disagrees with the server's recomputation at write time
  // (workflow/SLA/scope-override changed, effective location resolved
  // differently, or the routing trace input drifted). Request payload is
  // syntactically valid; server state blocks the operation — 422 is the
  // right shape (same family as terminal_ticket / cancelled_cannot_edit).
  // Without these entries the default 400 misclassifies a re-fetch-and-
  // retry race as a payload-shape bug.
  'automation_plan.semantic_mismatch': 422, // raised by create_ticket_with_automation (00349 → 00350 → 00351) + reclassify_ticket (00354 → 00355)
  'automation_plan.effective_location_mismatch': 422, // raised by create_ticket_with_automation (00349 → 00350 → 00351) + reclassify_ticket (00354 → 00355)
  'automation_plan.scope_override_mismatch': 422, // raised by create_ticket_with_automation (00349 → 00350 → 00351) + reclassify_ticket (00354 → 00355)
  'automation_plan.routing_input_mismatch': 422, // raised by create_ticket_with_automation (00349 → 00350 → 00351) only — reclassify_ticket does not re-validate routing trace input

  // ── 500 server ───────────────────────────────────────────────────
  // timers_required is a programmer error: TS plan-build always
  // computes timers when sla_id is non-null. If the RPC sees a
  // non-null sla_id without timers, TS skipped its responsibility —
  // surface as a server error so the caller's UX shows a generic
  // failure and ops see the trace.
  'update_entity_sla.timers_required': 500,
  'dispatch_child_work_order.timers_required': 500,
  'command_operations.unexpected_state': 500,
  // B.4.A.4 step 2D-C self-review remediation (CODE-I2).
  // approval.read_failed surfaces a transient supabase failure during the
  // edit-plan builder's `loadCurrentApprovalChain` read. Server-class:
  // the user payload is fine, the DB blip is operational. TS already
  // constructs AppError with status=500 via AppErrors.server; this entry
  // is defense-in-depth for any future RPC raise of the same code.
  'approval.read_failed': 500,
  // B.4.A.5 sub-step D self-review remediation (CODE-I5). Split out from
  // the original `email.dispatch_failed` blanket so dashboards can isolate
  // a DB read failure from an email-channel rejection. Worker emit only;
  // never returned by an HTTP route — defense-in-depth.
  'users.lookup_failed': 500,
  'booking.read_failed': 500,
  // B.4 Step 2F.2 — assembleScopeEditPlan defense-in-depth 500s.
  // series_mismatch: pivot booking's recurrence_series_id != caller's
  // effectiveSeriesId. Internal consistency bug; should never happen post
  // controller computes effectiveSeriesId from pivot. primary_slot_not_found:
  // an in-scope booking has zero slot rows — data corruption (every booking
  // must have ≥1 slot per 00043 invariant).
  'edit_booking_scope.series_mismatch': 500,
  'edit_booking_scope.primary_slot_not_found': 500,
  // B.4 Step 2F.3 self-review remediation (I1) — server-class fallback for
  // unknown RPC errors out of edit_booking_scope (DB timeout, missing column,
  // any unrecognised raise). Mirrors `booking.edit_failed`'s role for editOne
  // (line 349 below). Pre-fix the fallback was `edit_booking_scope.invalid_plans`
  // (a 400), which routed server-class failures through the validation surface
  // — operator saw an inline "request was malformed" inline error for what was
  // actually a transient platform problem.
  'edit_booking_scope.update_failed': 500,
  // B.4 Step 2F.2 codex remediation — tenant context drift guard.
  // B.4 step 2D-D — controller-vs-notification gate. The TS layer in
  // ReservationService.editSlot pre-flight-rejects any edit whose plan
  // would emit `booking.approval_required` (rows 2/7/8 of §3.6.5) until
  // B.4.A.5 ships notification dispatch.
  //
  // self-review I1 (2026-05-12): WAS 503; corrected to 422. Rationale:
  //   - 503 → classify.ts:354-368 routes to class 'server' with
  //     `retry` + `contactSupport` recoveries. Toast offers a Retry
  //     button that re-fires → 503 → re-fires forever, AND offers
  //     "Contact Support" with traceId — telling ops there's an outage
  //     when there isn't. The user can't usefully retry; the gate is a
  //     temporary platform-state limitation until B.4.A.5 ships.
  //   - 422 → classify.ts:312-321 routes to class 'validation'. The
  //     edit can't be saved in current platform state; the operator's
  //     mitigation is to pick a different room or remove approval from
  //     the room. Validation surface (inline form error, no retry-loop
  //     bait) matches the user's actual situation.
  // The case 503 arm in mapRpcErrorToAppError stays — defense-in-depth
  // for any future RPC raise of a different code with status 503.
  // TS-only raise today; defense-in-depth listing in case any future
  // RPC raises the same code (none planned).
  'booking.edit_requires_notification_dispatch': 422,
  // self-review N-CODE-2 (2026-05-12): explicit fallback mapping for
  // the editSlot rpcErr path. The default behaviour (`?? 400` at line
  // 315 below) misclassifies an unrecognised RPC raise as a validation
  // error; the comment at reservation.service.ts:1184-1191 documents
  // the intended fallback as 500 server-class. Make it explicit so the
  // registered code matches the documented semantics.
  'booking.slot_update_failed': 500,
  // B.4 step 2E — symmetric fallback for the editOne rpcErr path
  // (reservation.service.ts:editOne post-cutover). Same shape as
  // booking.slot_update_failed above — a 500 server-class for any
  // unrecognised RPC raise that mapRpcErrorToAppError can't translate.
  // booking.edit_failed is already registered as a wider "couldn't
  // save the changes" code (packages/shared/src/error-codes.ts:239 +
  // api/web message tables); making it explicit here keeps the
  // (fallback, STATUS_BY_CODE) tuple consistent.
  'booking.edit_failed': 500,
  'booking.cascade_cross_tenant_batch': 500,
  // B.4.A.5 sub-step C — TemplateResolverService raises these when the
  // (eventKind, locale) registry has no match. Programming/config error
  // (not user-fixable); 500 + dead-letter is the right shape — the
  // outbox handler logs + drops, ops needs to ship the missing module.
  // TS-only raises today; defense-in-depth listing in case any future
  // RPC raises the same code.
  'notification.unknown_event_kind': 500,
  'notification.template_resolution_failed': 500,
  // ─── Phase 1.B universal workflow ───────────────────────────────────────
  // Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.12
  // (Phase 1 codes). All 422 — TS-only raises today (engine.assertSpawnLinkSafe);
  // listed here as defense-in-depth in case any future spawn RPC raises the
  // same code (Phase 3 spawn_*_with_link RPCs are the natural candidates).
  'spawn_link.parent_terminated': 422,
  'spawn_link.depth_exceeded': 422,
  'spawn_link.cycle_detected': 422,
};

/**
 * Extract the leading `<namespace>.<specifier>` token from a RAISE message.
 * Matches the shape every B.2.A RPC uses (00325:142 / 00327:179 / 00330:163 /
 * 00333:250 etc.). Returns null when no recognisable token is present.
 */
function extractCode(message: string): string | null {
  // No `/i` flag: registered codes are lowercase by convention (see
  // KNOWN_ERROR_CODES). Dropping the flag tightens the match to the
  // exact shape RPCs raise.
  const match = message.match(/^([a-z_][a-z0-9_]*\.[a-z0-9_]+)/);
  return match?.[1] ?? null;
}

/**
 * Map a PostgrestError (or plain Error with a postgrest-shaped message) to
 * an AppError. Unknown codes route to `unknown.server_error` so the renderer
 * fails closed.
 */
export function mapRpcErrorToAppError(
  error: PostgrestErrorLike | Error | null | undefined,
  options: { fallbackCode?: KnownErrorCode } = {},
): AppError {
  const fallback = options.fallbackCode ?? 'unknown.server_error';

  if (!error) {
    return AppErrors.server(fallback);
  }

  const message =
    (error as PostgrestErrorLike).message ?? (error as Error).message ?? '';
  const candidate = extractCode(message);

  if (!candidate || !KNOWN_ERROR_CODES.has(candidate as KnownErrorCode)) {
    // Defence-in-depth: filter normalises unregistered codes to
    // `unknown.server_error`. Surface the raw RAISE message as `detail` so
    // ops can triage from logs. Cause carries the original PostgrestError
    // so AppError's downstream logging captures it.
    return AppErrors.server(fallback, {
      detail: message || undefined,
      cause: error,
    });
  }

  const code = candidate as KnownErrorCode;
  const status = STATUS_BY_CODE[code] ?? 400;

  // CODEX-B-1 (2026-05-11): for REGISTERED codes, do NOT pass `detail`.
  // The renderer (normalize.ts:181-189) prefers an explicit detail
  // override over the registry copy from messages.en/nl. Passing the
  // stripped SQL raise tail (`case=<uuid> open_children=3`,
  // `kind=case id=<uuid>`, etc.) leaked operator-only diagnostic
  // strings into user-visible wire bodies — e.g.
  // `transition_entity_status.has_open_children` was rendered as the
  // SQL tail instead of the curated "This case has open work orders."
  // copy. Keep `cause: error` so the filter's logger captures the
  // PostgrestError for traceId association; the user just sees the
  // registry detail.
  switch (status) {
    case 404:
      // notFoundWithCode rather than notFound(entity, id) because the entity
      // alias on the wire is `<namespace>.<specifier>`, not the standard
      // `<entity>.not_found` shape.
      return AppErrors.notFoundWithCode(code, undefined, { cause: error });
    case 409: {
      // Codex remediation (00384) — surface plan_version conflict details
      // on the wire. The RPC raises `planning.version_conflict` with
      // `using detail = jsonb_build_object('current_version', N,
      // 'client_version', M)::text`. supabase-js puts that on
      // `PostgrestError.details`; parse and forward into AppErrors.conflict
      // so the FE sees the same `serverVersion`/`clientVersion` body the
      // TS pre-check produces (work-order.service.ts:278-282). Defensive
      // try/catch — if the detail isn't parseable JSON the conflict
      // surfaces without versions but doesn't crash.
      if (code === 'planning.version_conflict') {
        const rawDetail = (error as PostgrestErrorLike).details ?? null;
        let serverVersion: string | undefined;
        let clientVersion: string | undefined;
        if (typeof rawDetail === 'string' && rawDetail.length > 0) {
          try {
            const parsed = JSON.parse(rawDetail) as {
              current_version?: number | string;
              client_version?: number | string;
            };
            if (parsed.current_version !== undefined && parsed.current_version !== null) {
              serverVersion = String(parsed.current_version);
            }
            if (parsed.client_version !== undefined && parsed.client_version !== null) {
              clientVersion = String(parsed.client_version);
            }
          } catch {
            // fall through with undefined versions
          }
        }
        return AppErrors.conflict(code, {
          cause: error,
          serverVersion,
          clientVersion,
        });
      }
      return AppErrors.conflict(code, { cause: error });
    }
    case 422:
      // 422 unprocessable entity — used for cross-tenant FK rejections
      // that need to differ from generic 400 validation failures. No
      // dedicated factory yet; construct AppError directly. F-IMP-4.
      return new AppError(code, 422, { cause: error });
    case 500:
      return AppErrors.server(code, { cause: error });
    case 503:
      // 503 service-unavailable. No dedicated factory; construct AppError
      // directly. Defense-in-depth — no current registered code maps to
      // 503 (B.4 Step 2D-D's `booking.edit_requires_notification_dispatch`
      // gate originally landed as 503 but was reviewer-flipped to 422 in
      // commit `fb7b163f` so it surfaces as a validation-class inline
      // error, not a retry-loop + contact-support toast). Kept registered
      // for any future RPC raise that genuinely means "platform isn't
      // ready, retry later."
      return new AppError(code, 503, { cause: error });
    case 400:
    default:
      return AppErrors.validationFailed(code, { cause: error });
  }
}

