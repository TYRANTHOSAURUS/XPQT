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
