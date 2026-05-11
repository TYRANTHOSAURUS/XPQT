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
