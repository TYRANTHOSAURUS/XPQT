/**
 * Idempotency-key helpers for the B.2.A §3.0 `update_entity_combined`
 * orchestrator. Single source of truth for the outer
 * `command_operations.idempotency_key` shape.
 *
 * Why this module exists:
 *   The §3.0 orchestrator stores one row per (tenant_id,
 *   idempotency_key) in `command_operations`. The key is composed of a
 *   fixed prefix + entity kind + entity id + the caller-supplied
 *   `clientRequestId`. Pre-this-module the format was minted inline in
 *   three places — `TicketService.update`, `WorkOrderService.update`,
 *   and the live smoke probes — making a silent drift between them
 *   possible (e.g. cutover changes the prefix, smoke keeps the old
 *   format, every probe asserts NO row found, but the test "passes"
 *   anyway because the no-row path is the failure path that becomes
 *   silently green).
 *
 * The .mjs smoke scripts also keep a literal copy of this format with
 * a code comment cross-referencing this file. If you change the shape
 * here, update both smoke files in lockstep (search for
 * `PATCH_IDEMPOTENCY_KEY_PREFIX` in scripts/).
 *
 * Citations:
 *   - 00316_command_operations_table.sql:31-42 (table schema)
 *   - 00335_update_entity_combined_v5.sql:203-205, :792-794
 *     (insert in_progress + final UPDATE to success)
 *   - apps/api/src/modules/ticket/ticket.service.ts (TicketService.update)
 *   - apps/api/src/modules/work-orders/work-order.service.ts (WorkOrderService.update)
 *   - apps/api/scripts/smoke-tickets.mjs + smoke-work-orders.mjs
 */

import { v5 as uuidv5 } from 'uuid';

/**
 * Prefix for every `update_entity_combined` outer idempotency key. Kept
 * narrow on purpose — a "patch" key is the orchestrator's contract; if
 * a future RPC needs its own prefix, add a new constant rather than
 * widening this one.
 */
export const PATCH_IDEMPOTENCY_KEY_PREFIX = 'patch';

/**
 * The two entity kinds the §3.0 orchestrator dispatches on. Mirrored
 * from the RPC's `p_kind` parameter (00335:118-120).
 */
export type PatchEntityKind = 'case' | 'work_order';

/**
 * Build the outer idempotency key for `update_entity_combined`. Shape:
 *   `patch:<kind>:<entityId>:<clientRequestId>`
 *
 * The single helper lets the TS layer and the smoke scripts agree on
 * the format. A drift between them is a silent regression — the
 * smoke probe would assert a row that the API never wrote (or the
 * other way around) and report "no row found" without telling you the
 * key format moved underneath it.
 *
 * `clientRequestId` is required (no default, no fallback). The
 * controller's `RequireClientRequestIdGuard` enforces presence at the
 * HTTP boundary; the service-layer hard-fail enforces it for internal
 * callers (workflow engine, cron). See F-CRIT-1 in the B.2.A interim
 * retro (`docs/follow-ups/b2-a-interim-retro-2026-05-11.md`) for the
 * rationale.
 */
export function buildPatchIdempotencyKey(
  kind: PatchEntityKind,
  entityId: string,
  clientRequestId: string,
): string {
  return `${PATCH_IDEMPOTENCY_KEY_PREFIX}:${kind}:${entityId}:${clientRequestId}`;
}

/**
 * Prefix for every `dispatch_child_work_order` outer idempotency key.
 * Mirrors `PATCH_IDEMPOTENCY_KEY_PREFIX` but namespaced separately so the
 * two RPCs never collide on a shared (tenant_id, idempotency_key).
 *
 * Citations:
 *   - 00338_dispatch_child_work_order_v2.sql (single)
 *   - 00339_dispatch_child_work_orders_batch_v2.sql (batch)
 *   - spec §3.4 (docs/follow-ups/b2-survey-and-design.md lines 2165-2234)
 */
export const DISPATCH_IDEMPOTENCY_KEY_PREFIX = 'dispatch';
export const DISPATCH_BATCH_IDEMPOTENCY_KEY_PREFIX = 'dispatch_batch';

/**
 * Build the outer idempotency key for `dispatch_child_work_order`. Shape:
 *   `dispatch:<parentId>:<clientRequestId>`
 *
 * **NO actor in the key.** F-CRIT-2 / plan-C1: actor-in-key created a
 * double-dispatch hazard — same parent + same clientRequestId + two
 * different actors yielded two command_operations rows + two committed
 * children. The clientRequestId is the deduplication boundary; tying it
 * to actor identity defeats the deduplication contract. SYSTEM_ACTOR is
 * not special here either — the call-site supplies the same
 * clientRequestId across retries regardless of who's running the retry.
 */
export function buildDispatchIdempotencyKey(
  parentId: string,
  clientRequestId: string,
): string {
  return `${DISPATCH_IDEMPOTENCY_KEY_PREFIX}:${parentId}:${clientRequestId}`;
}

/**
 * Build the outer idempotency key for `dispatch_child_work_orders_batch`.
 * Shape:
 *   `dispatch_batch:<parentId>:<clientRequestId>`
 *
 * Same shape rules as the single key: no actor, clientRequestId is the
 * deduplication boundary. Different prefix so a single-dispatch retry
 * against the same parent can never collide with a batch-dispatch retry.
 * Workflow-engine call sites supply a stable `clientRequestId` derived
 * from the workflow instance + node id so that replay of the same node
 * deterministically replays the batch.
 */
export function buildDispatchBatchIdempotencyKey(
  parentId: string,
  clientRequestId: string,
): string {
  return `${DISPATCH_BATCH_IDEMPOTENCY_KEY_PREFIX}:${parentId}:${clientRequestId}`;
}

/**
 * Stable uuidv5 namespace for deterministic dispatch `child_id` minting.
 * **NEVER change this value in production** — the §3.4 RPC's
 * retry-safety contract requires that the same idempotency_key always
 * derive the same child_id across deploys. Regenerating the namespace
 * makes a retry mint a fresh child_id, which would (a) bypass the
 * command_operations idempotency gate (different row), (b) write a
 * second work_orders row, and (c) silently break the contract.
 *
 * F-CRIT-3 / plan-C2: this constant was previously inlined in
 * `apps/api/src/modules/ticket/dispatch.service.ts:25`. Moved here so a
 * `git mv`, a refactor, or a regen of the inline constant can't change
 * it accidentally.
 *
 * Value generated once for this codebase; treated as immutable.
 */
export const DISPATCH_CHILD_ID_NAMESPACE = 'a3f4b21e-7c5d-4e6f-9a8b-1c2d3e4f5061';

/**
 * Derive the deterministic `child_id` for a `dispatch_child_work_order`
 * call from its outer idempotency_key. Same key → same uuid → the RPC's
 * `INSERT into work_orders(id, ...)` is idempotent on retry. For the
 * batch path, callers should mix in the task index before calling:
 *   `buildDispatchChildId(`${batchKey}:${taskIndex}`)`
 */
export function buildDispatchChildId(idempotencyKey: string): string {
  return uuidv5(idempotencyKey, DISPATCH_CHILD_ID_NAMESPACE);
}

/**
 * Prefix for the workflow-engine `assign` node's outer idempotency key,
 * shared with the §3.2 `set_entity_assignment` RPC. Namespaced separately
 * from `patch` / `dispatch` / `dispatch_batch` so a workflow-engine retry
 * can never collide with a controller PATCH or a dispatch call.
 *
 * Citations:
 *   - 00327_set_entity_assignment_v2.sql (RPC accepts arbitrary text key)
 *   - spec §3.2 lines 1986-2037 — workflow engine assign cutover (Step 9)
 *   - apps/api/src/modules/workflow/workflow-engine.service.ts — the only caller
 */
export const WORKFLOW_ASSIGNMENT_IDEMPOTENCY_KEY_PREFIX = 'workflow:assignment';
export const WORKFLOW_UPDATE_TICKET_IDEMPOTENCY_KEY_PREFIX = 'workflow:update_ticket';

/**
 * Build the outer idempotency key for `set_entity_assignment` calls from
 * the workflow engine's `assign` node. Shape:
 *   `workflow:assignment:<workflow_instance_id>:<node_id>:<entity_id>`
 *
 * The key is stable across retries — same workflow instance, same node,
 * same entity ⇒ same key ⇒ `command_operations` short-circuits the
 * second call. Replay-safe by construction. Step 9 cuts the workflow
 * engine over to the RPC layer; pre-Step 9 the engine wrote directly to
 * `tickets` with no idempotency, so retries silently double-applied.
 */
export function buildWorkflowAssignmentIdempotencyKey(
  workflowInstanceId: string,
  nodeId: string,
  entityId: string,
): string {
  return `${WORKFLOW_ASSIGNMENT_IDEMPOTENCY_KEY_PREFIX}:${workflowInstanceId}:${nodeId}:${entityId}`;
}

/**
 * Build the outer idempotency key for `update_entity_combined` calls from
 * the workflow engine's `update_ticket` node. Shape:
 *   `workflow:update_ticket:<workflow_instance_id>:<node_id>:<entity_id>`
 *
 * Same retry-safety rationale as `buildWorkflowAssignmentIdempotencyKey`.
 * The §3.0 orchestrator wraps every branch (status/priority/assignment/
 * sla/plan/metadata) in one transaction; the idempotency cache is keyed
 * on the OUTER key, sub-RPC keys are sentinel-prefixed (00335:135-137).
 */
export function buildWorkflowUpdateTicketIdempotencyKey(
  workflowInstanceId: string,
  nodeId: string,
  entityId: string,
): string {
  return `${WORKFLOW_UPDATE_TICKET_IDEMPOTENCY_KEY_PREFIX}:${workflowInstanceId}:${nodeId}:${entityId}`;
}

/**
 * Prefix for the `create_ticket_with_automation` outer idempotency key.
 * B.2.A.Step12 §3.11 — same actor + same clientRequestId is the
 * unique-retry contract per F-CRIT-1 (no payload fingerprint in the
 * key; the RPC's own payload_hash gate detects "same key, different
 * payload" and raises payload_mismatch).
 *
 * Citations:
 *   - 00349_create_ticket_with_automation_rpc.sql
 *   - spec §3.11 (docs/follow-ups/b2-survey-and-design.md lines 2793-3034)
 *   - apps/api/src/modules/ticket/ticket.service.ts (TicketService.create)
 *   - apps/api/src/modules/portal/portal-submit.service.ts (PortalSubmitService.submit)
 */
export const CREATE_TICKET_IDEMPOTENCY_KEY_PREFIX = 'create:ticket';

/**
 * Build the outer idempotency key for `create_ticket_with_automation`.
 * Shape:
 *   `create:ticket:<actorAuthUid>:<clientRequestId>`
 *
 * Same actor + same clientRequestId ⇒ same key ⇒ `command_operations`
 * short-circuits the second call. Cross-actor uses of the same
 * clientRequestId mint different keys — separate idempotency scopes.
 * That's intentional: user A double-submitting is one retry chain;
 * user B happening to send the same clientRequestId is a coincidence,
 * not a retry. SYSTEM_ACTOR creates (cron / webhook ingest) use the
 * sentinel string as the actor segment.
 */
export function buildCreateTicketIdempotencyKey(
  actorAuthUid: string,
  clientRequestId: string,
): string {
  return `${CREATE_TICKET_IDEMPOTENCY_KEY_PREFIX}:${actorAuthUid}:${clientRequestId}`;
}

/**
 * Stable uuidv5 namespace for deterministic `ticket_id` minting on the
 * `create_ticket_with_automation` path. Same idempotency_key always
 * yields the same uuid across retries + deploys. Mirrors
 * DISPATCH_CHILD_ID_NAMESPACE — never change this value in production.
 */
export const CREATE_TICKET_ID_NAMESPACE = '4f6e1c92-8a3b-4d2e-9f5c-1a8b7c6d5e3f';

/**
 * Derive the deterministic `ticket_id` for a `create_ticket_with_automation`
 * call from its outer idempotency_key. Used by TicketController +
 * PortalSubmitService to pre-mint the id before calling the RPC, so a
 * retry doesn't mint a fresh uuid and bypass the idempotency gate.
 */
export function buildCreateTicketId(idempotencyKey: string): string {
  return uuidv5(idempotencyKey, CREATE_TICKET_ID_NAMESPACE);
}

/**
 * Prefix for the `reclassify_ticket` outer idempotency key. B.2.A.Step11
 * §3.10 — the RPC's `command_operations` gate is keyed on
 * (tenant_id, idempotency_key); a retry of the SAME ticket reclassify
 * (same ticket + same clientRequestId) collapses to the cached result.
 *
 * Citations:
 *   - 00354_reclassify_ticket_rpc.sql (B.2.A.Step11)
 *   - spec §3.10 (docs/follow-ups/b2-survey-and-design.md lines 2579-2790)
 *   - apps/api/src/modules/ticket/reclassify.service.ts (ReclassifyService.execute)
 */
export const RECLASSIFY_IDEMPOTENCY_KEY_PREFIX = 'reclassify';

/**
 * Build the outer idempotency key for `reclassify_ticket`. Shape:
 *   `reclassify:<ticket_id>:<clientRequestId>`
 *
 * Same ticket + same clientRequestId ⇒ same key ⇒ command_operations
 * short-circuits the second call. No actor in the key — actor-in-key
 * created a double-dispatch hazard in F-CRIT-2 / plan-C1 (dispatch
 * RPC); the same reasoning applies here.
 */
export function buildReclassifyIdempotencyKey(
  ticketId: string,
  clientRequestId: string,
): string {
  return `${RECLASSIFY_IDEMPOTENCY_KEY_PREFIX}:${ticketId}:${clientRequestId}`;
}

/**
 * Prefix for the `grant_ticket_approval` outer idempotency key.
 * B.2.A.Step10 reland §3.5 — the RPC's `command_operations` gate is
 * keyed on (tenant_id, idempotency_key); a retry of the SAME approval
 * grant (same approval id + same clientRequestId) collapses to the
 * cached result.
 *
 * Citations:
 *   - 00356_grant_ticket_approval_rpc.sql (B.2.A.Step10 reland)
 *   - spec §3.5 (docs/follow-ups/b2-survey-and-design.md lines 2238-2350)
 *   - apps/api/src/modules/approval/approval.service.ts
 *     (ApprovalService.respond — ticket branch dispatcher)
 */
export const APPROVAL_GRANT_IDEMPOTENCY_KEY_PREFIX = 'approval:grant';

/**
 * Build the outer idempotency key for `grant_ticket_approval`. Shape:
 *   `approval:grant:<approval_id>:<clientRequestId>`
 *
 * Same approval + same clientRequestId ⇒ same key ⇒ command_operations
 * short-circuits the second call. **No actor in the key** per
 * F-CRIT-2 / plan-C1 (dispatch RPC); the clientRequestId is the
 * deduplication boundary. Tying it to actor identity defeats the
 * deduplication contract — same approval + same client retry across
 * a delegation switch would mint different keys and double-decide.
 */
export function buildApprovalGrantIdempotencyKey(
  approvalId: string,
  clientRequestId: string,
): string {
  return `${APPROVAL_GRANT_IDEMPOTENCY_KEY_PREFIX}:${approvalId}:${clientRequestId}`;
}

/**
 * Prefix for the `edit_booking` outer idempotency key. B.4.A.2 foundation —
 * paired with the upcoming `edit_booking(...)` RPC (B.4 §3.4). Namespaced
 * separately from every other prefix so an edit retry against a booking
 * can never collide with a dispatch / patch / approval call.
 *
 * Citations:
 *   - docs/follow-ups/b4-booking-edit-pipeline.md §3.2 (RPC signature
 *     accepts `p_idempotency_key text`)
 *   - docs/follow-ups/b4-booking-edit-pipeline.md §3.4 step 2 (the RPC
 *     gates on `command_operations` keyed on this prefix)
 */
export const EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX = 'booking:edit';

/**
 * Operation discriminator for the booking-edit family of producer routes.
 * The three values map to the three controller entry points + their
 * underlying RPCs:
 *
 *   - `'one'`   → `PATCH /reservations/:id`            (editOne → edit_booking)
 *   - `'slot'`  → `PATCH /reservations/:id/slots/:sid` (editSlot → edit_booking)
 *   - `'scope'` → `POST  /reservations/:id/edit-scope` (editScope → edit_booking_scope)
 *
 * B.4 Step 2F.3 adds this discriminator (the helper was originally a
 * 2-arg shape). Rationale: the docstring previously punted cross-
 * operation deduplication to "client mints different crids per
 * operation," but a buggy frontend reusing the same crid across an
 * editOne + editSlot to the same booking would collapse to a single
 * `command_operations` row and the second call would surface the first
 * call's cached_result. The discriminator lifts that constraint —
 * keys diverge by operation even when (bookingId, clientRequestId) match.
 * Closes the cross-op-collision followup in `docs/follow-ups/b4-followups.md`.
 */
export type EditBookingOp = 'one' | 'slot' | 'scope';

/**
 * Build the outer idempotency key for the booking-edit RPC family. Shape:
 *   - With op (current):       `booking:edit:<op>:<booking_id>:<clientRequestId>`
 *   - Without op (legacy):     `booking:edit:<booking_id>:<clientRequestId>`
 *
 * Same booking + same clientRequestId + same op ⇒ same key ⇒
 * `command_operations` short-circuits the second call. Different ops
 * with the same (bookingId, clientRequestId) mint distinct keys — an
 * editOne retry never collides with an editSlot retry. **No actor in the
 * key** per F-CRIT-2 / plan-C1 (dispatch RPC): clientRequestId is the
 * deduplication boundary; tying it to actor identity defeats the
 * deduplication contract across delegation switches.
 *
 * `op` is the 3rd parameter (optional) to preserve backward compat for
 * any caller that hasn't been migrated yet. Inside the booking-edit
 * pipeline (editOne / editSlot / editScope), all call sites pass `op`.
 * The 2-arg legacy shape is retained ONLY so historical fixtures and
 * smoke probes that pre-date Step 2F.3 keep compiling; new callers must
 * always supply `op`.
 */
export function buildEditBookingIdempotencyKey(
  bookingId: string,
  clientRequestId: string,
  op?: EditBookingOp,
): string {
  return op
    ? `${EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX}:${op}:${bookingId}:${clientRequestId}`
    : `${EDIT_BOOKING_IDEMPOTENCY_KEY_PREFIX}:${bookingId}:${clientRequestId}`;
}

/**
 * Prefix for the `set_entity_assignment` outer idempotency key on the
 * audited `POST /tickets/:id/reassign` + `POST /work-orders/:id/reassign`
 * paths. Audit-02 P1-1 reassign cutover (2026-05-16). Namespaced
 * separately from `patch` / `dispatch` / `workflow:assignment` so a
 * controller reassign retry can never collide with a single PATCH, a
 * dispatch, or a workflow-engine assign-node call against the same
 * entity (all of which also drive `set_entity_assignment` /
 * `update_entity_combined`).
 *
 * Citations:
 *   - 00327_set_entity_assignment_v2.sql (RPC accepts arbitrary text key)
 *   - docs/follow-ups/audits/02-tickets-work-orders.md P1-1 / P2-2 / P2-4
 *   - apps/api/src/modules/ticket/ticket.service.ts (TicketService.reassign)
 *   - apps/api/src/modules/work-orders/work-order.service.ts (WorkOrderService.reassign)
 */
export const REASSIGN_IDEMPOTENCY_KEY_PREFIX = 'reassign';

/**
 * Build the outer idempotency key for `set_entity_assignment` on the
 * reassign paths. Shape:
 *   `reassign:<kind>:<entityId>:<clientRequestId>`
 *
 * Same entity + same clientRequestId + same kind ⇒ same key ⇒
 * `command_operations` short-circuits the second call (the RPC's own
 * gate). `kind` is part of the key so a (coincidentally shared)
 * clientRequestId reused across a case reassign and a work_order
 * reassign mints distinct keys — they are independent retry chains.
 * **No actor in the key** per F-CRIT-2 / plan-C1 (dispatch RPC): the
 * clientRequestId is the deduplication boundary; tying it to actor
 * identity defeats deduplication across a delegation switch.
 */
export function buildReassignIdempotencyKey(
  kind: PatchEntityKind,
  entityId: string,
  clientRequestId: string,
): string {
  return `${REASSIGN_IDEMPOTENCY_KEY_PREFIX}:${kind}:${entityId}:${clientRequestId}`;
}
 * Prefix for the `cancel_booking_with_cascade` outer idempotency key.
 * Booking-audit remediation Slice 2 (audit 03 P0-1 / P1-5). Paired with
 * the `cancel_booking_with_cascade(...)` RPC (migration 00408).
 * Namespaced separately from every other prefix (including
 * `booking:edit`) so a cancel retry against a booking can never collide
 * with an edit / dispatch / patch / approval call on the same booking.
 *
 * Citations:
 *   - supabase/migrations/00408_cancel_booking_with_cascade.sql
 *     (RPC accepts `p_idempotency_key text`, gates on command_operations)
 *   - docs/follow-ups/cancel-booking-equivalence-checklist.md (row 6.2 —
 *     the cancel route gains RequireClientRequestIdGuard + this key)
 */
export const CANCEL_BOOKING_IDEMPOTENCY_KEY_PREFIX = 'booking:cancel';

/**
 * Build the outer idempotency key for `cancel_booking_with_cascade`.
 * Shape: `booking:cancel:<scope>:<booking_id>:<clientRequestId>`
 *
 * `scope` is the discriminator (mirrors `op` on the edit family at
 * `buildEditBookingIdempotencyKey`): a buggy frontend reusing the same
 * clientRequestId across a `this` cancel and a `series` cancel of the
 * same booking would otherwise collapse onto one `command_operations`
 * row and the second call would surface the first's cached_result.
 * Distinct scope ⇒ distinct key. **No actor in the key** per
 * F-CRIT-2 / plan-C1 (dispatch RPC): clientRequestId is the
 * deduplication boundary.
 */
export function buildCancelBookingIdempotencyKey(
  bookingId: string,
  clientRequestId: string,
  scope: RecurrenceCancelScope,
): string {
  return `${CANCEL_BOOKING_IDEMPOTENCY_KEY_PREFIX}:${scope}:${bookingId}:${clientRequestId}`;
}

/**
 * Prefix for the `split_recurrence_series` outer idempotency key.
 * Booking-audit remediation Slice 4 (audit 03 P1-2). Paired with the
 * `split_recurrence_series(...)` RPC (migration 00411). Namespaced
 * separately from every other prefix (including `booking:edit` and
 * `booking:cancel`) so a recurrence-split retry can never collide with
 * an edit / cancel / dispatch / patch call on the same booking.
 *
 * The split runs INSIDE `ReservationService.editScope` for
 * `scope='this_and_following'` commits. It is keyed on the SAME
 * (bookingId, clientRequestId) the surrounding editScope uses so a
 * retry of the same editScope re-calls the split with the same key →
 * the RPC's command_operations gate returns the cached new_series_id,
 * no orphan series minted. This is what makes the legacy TS
 * `skipSplitSeries` pre-check obsolete.
 *
 * Citations:
 *   - supabase/migrations/00411_split_recurrence_series.sql
 *     (RPC accepts `p_idempotency_key text`, gates on command_operations)
 *   - apps/api/src/modules/reservations/recurrence.service.ts
 *     (RecurrenceService.splitSeries — the thin RPC wrapper)
 */
export const SPLIT_RECURRENCE_SERIES_IDEMPOTENCY_KEY_PREFIX =
  'booking:recurrence:split';

/**
 * Build the outer idempotency key for `split_recurrence_series`.
 * Shape: `booking:recurrence:split:<booking_id>:<clientRequestId>`
 *
 * Same booking + same clientRequestId ⇒ same key ⇒ command_operations
 * short-circuits the second call and returns the same new_series_id.
 * **No actor in the key** per F-CRIT-2 / plan-C1 (dispatch RPC):
 * clientRequestId is the deduplication boundary. No scope/op
 * discriminator — split is only ever invoked on the
 * `this_and_following` commit leg of editScope, so the pair
 * (bookingId, clientRequestId) is the natural retry boundary (and it
 * MUST match the editScope crid so a single editScope retry replays
 * both the split and the edit_booking_scope RPC against the same
 * post-split series — see the retry-replay trace in
 * docs/follow-ups/slice4-split-recurrence-decision.md).
 */
export function buildSplitSeriesIdempotencyKey(
  bookingId: string,
  clientRequestId: string,
): string {
  return `${SPLIT_RECURRENCE_SERIES_IDEMPOTENCY_KEY_PREFIX}:${bookingId}:${clientRequestId}`;
}

/**
 * Prefix for the `attach_services_to_existing_booking` outer idempotency
 * key. Booking-audit remediation Slice 5 (audit 03 P1-3). Paired with the
 * `attach_services_to_existing_booking(...)` RPC (migration 00412), which
 * gates on `public.attach_operations` (the attach-family idempotency table —
 * NOT `command_operations`, mirroring the LIVE create_booking_with_attach_plan
 * which also uses attach_operations). Namespaced separately from every
 * other prefix (including `booking:edit`, `booking:cancel`,
 * `booking:recurrence:split`) so a post-booking service-attach retry can
 * never collide with an edit / cancel / split / dispatch / patch call on
 * the same booking.
 *
 * The attach runs from `POST /reservations/:id/services`
 * (RequireClientRequestIdGuard-gated). It is keyed on
 * (bookingId, clientRequestId): a retry of the same attach click re-calls
 * the RPC with the same key → the RPC's attach_operations gate returns the
 * cached result, ZERO duplicate orders/OLIs/asset_reservations/approvals.
 * This is what makes the legacy TS `Cleanup` reverse-order undo-queue
 * obsolete — Postgres transaction atomicity replaces it.
 *
 * Citations:
 *   - supabase/migrations/00412_attach_services_to_existing_booking_rpc.sql
 *     (RPC accepts `p_idempotency_key text`, gates on attach_operations)
 *   - apps/api/src/modules/booking-bundles/bundle.service.ts
 *     (BundleService.attachServicesToBooking — the thin RPC wrapper)
 */
export const ATTACH_SERVICES_IDEMPOTENCY_KEY_PREFIX = 'booking:attach';

/**
 * Build the outer idempotency key for `attach_services_to_existing_booking`.
 * Shape: `booking:attach:<booking_id>:<clientRequestId>`
 *
 * Same booking + same clientRequestId ⇒ same key ⇒ attach_operations
 * short-circuits the second call and returns the cached result (no
 * duplicate rows). **No actor in the key** per F-CRIT-2 / plan-C1
 * (dispatch RPC): clientRequestId is the deduplication boundary. No
 * scope/op discriminator — attach is a single operation kind per booking;
 * the pair (bookingId, clientRequestId) is the natural retry boundary.
 */
export function buildAttachServicesIdempotencyKey(
  bookingId: string,
  clientRequestId: string,
): string {
  return `${ATTACH_SERVICES_IDEMPOTENCY_KEY_PREFIX}:${bookingId}:${clientRequestId}`;
}

/**
 * The three recurrence scopes the cancel RPC dispatches on. Mirrors the
 * `RecurrenceScope` union in
 * `apps/api/src/modules/reservations/dto/types.ts:378` (kept structurally
 * identical; redeclared here so `@prequest/shared` has no app dependency).
 */
export type RecurrenceCancelScope = 'this' | 'this_and_following' | 'series';
