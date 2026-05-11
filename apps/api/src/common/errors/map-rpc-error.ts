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
  // B.2.A.Step12 §3.11 — create RPC's request-type-not-found path.
  'create_ticket_with_automation.request_type_not_found': 404,
  // B.2.A.Step11 §3.10 — reclassify_ticket RPC.
  'reclassify_ticket.ticket_not_found': 404,

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

  // B.2.A.Step9 — workflow `update_ticket` node config that references a
  // field outside the tightened allowlist throws this code (TS-side).
  // The raise is unprocessable-entity rather than 400 validation:
  // the request payload is syntactically valid jsonb of the right
  // shape, but the workflow definition itself is misconfigured — only
  // an admin can fix it. Defense-in-depth listing for any future
  // RPC-side raise of the same code (none today; the workflow engine
  // is the sole producer).
  'workflow.update_ticket_field_not_allowed': 422,

  // ── 500 server ───────────────────────────────────────────────────
  // timers_required is a programmer error: TS plan-build always
  // computes timers when sla_id is non-null. If the RPC sees a
  // non-null sla_id without timers, TS skipped its responsibility —
  // surface as a server error so the caller's UX shows a generic
  // failure and ops see the trace.
  'update_entity_sla.timers_required': 500,
  'dispatch_child_work_order.timers_required': 500,
  'command_operations.unexpected_state': 500,
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
    case 409:
      return AppErrors.conflict(code, { cause: error });
    case 422:
      // 422 unprocessable entity — used for cross-tenant FK rejections
      // that need to differ from generic 400 validation failures. No
      // dedicated factory yet; construct AppError directly. F-IMP-4.
      return new AppError(code, 422, { cause: error });
    case 500:
      return AppErrors.server(code, { cause: error });
    case 400:
    default:
      return AppErrors.validationFailed(code, { cause: error });
  }
}

