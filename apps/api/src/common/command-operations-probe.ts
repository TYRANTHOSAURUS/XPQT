/**
 * command_operations success-probe — the READ side of the B.2 combined-RPC
 * idempotency contract (audit02 D-A02-4).
 *
 * The B.2 combined RPCs (set_entity_assignment v3 / 00425, etc.) gate
 * idempotency on `command_operations(tenant_id, idempotency_key)` with a
 * payload hash: same key + same hash ⇒ replay cached_result; same key +
 * DIFFERENT hash ⇒ `command_operations.payload_mismatch` (00316:32-42,
 * 00425:152-169).
 *
 * Stable-keyed callers (SLA escalation, the routing-evaluation outbox
 * handler, case/WO reassign) reuse a deterministic idempotency key but
 * recompute `p_payload` from MUTABLE state on every (re)entry. If the
 * canonical write already committed under that key on an earlier
 * tick/delivery — but a post-RPC step failed before the caller's own
 * side-effect gate ran — a later re-entry recomputes a payload that has
 * since drifted (an intervening manual reassign, a routing-config change,
 * a re-resolved assignee). Same key + drifted payload ⇒ `payload_mismatch`
 * ⇒ the caller throws BEFORE its side-effect gate ⇒ the logical op is
 * permanently poisoned (D-A02-4).
 *
 * The fix: BEFORE recomputing the mutable payload / re-calling the RPC,
 * probe `command_operations` for a `success` row under the stable key. If
 * one exists, the canonical write ALREADY committed — short-circuit the
 * recompute+recall and drive the caller's downstream side-effect gate
 * directly. The RPC keeps its own authoritative WRITE-side gate
 * (defense-in-depth); this is purely the READ-side that prevents the
 * wasteful/poisoning recompute.
 *
 * Tenant-scoped by construction (`tenant_id = <tenant>` AND
 * `idempotency_key = <key>` — the table PK; #0 invariant —
 * memory:feedback_tenant_id_ultimate_rule). Only `outcome='success'`
 * short-circuits: `outcome='in_progress'` means a concurrent op holds the
 * key (00316:37 — the v6 outcome enum is exactly ('in_progress',
 * 'success')); callers decide how to treat in_progress per their own
 * concurrency model.
 *
 * Citations:
 *   - supabase/migrations/00316_command_operations_table.sql:32-54
 *     (table shape, PK (tenant_id, idempotency_key), outcome enum,
 *      cached_result non-null on success)
 *   - supabase/migrations/00425_set_entity_assignment_v3_clear_routing_status.sql:152-169
 *     (payload-hash gate + payload_mismatch raise)
 *   - docs/follow-ups/audits/02-tickets-work-orders.md (D-A02-4)
 */
import type { SupabaseService } from './supabase/supabase.service';

/**
 * The committed `command_operations` row when `outcome='success'`.
 * `cached_result` is the verbatim RPC return that was stored on commit
 * (00316:38 — non-null when outcome='success'; for set_entity_assignment
 * v3 the shape is 00425:466-479).
 */
export interface CommandOperationSuccess {
  cached_result: Record<string, unknown> | null;
}

/**
 * Probe `command_operations` for an already-committed (`outcome='success'`)
 * row under a stable idempotency key, tenant-scoped.
 *
 * Returns the success row (carrying `cached_result`) when the canonical
 * write already committed under this key; `null` when there is no row, or
 * the row is still `in_progress` (a concurrent op holds it — NOT a
 * short-circuit signal). A read error throws (the caller maps it through
 * its own AppError/mapRpcError idiom — never a raw `throw new Error` in a
 * gated module).
 *
 * @param supabase  SupabaseService (uses `.admin` — service_role; the table
 *                   is service_role-only by RLS, 00316:50-51).
 * @param tenantId  Tenant scope. MUST be the caller's resolved tenant.
 * @param idempotencyKey  The SAME stable key the caller passes to the RPC.
 */
export async function probeCommandOperationSuccess(
  supabase: SupabaseService,
  tenantId: string,
  idempotencyKey: string,
): Promise<CommandOperationSuccess | null> {
  const { data, error } = await supabase.admin
    .from('command_operations')
    .select('outcome, cached_result')
    .eq('tenant_id', tenantId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) {
    // Surface to the caller — each gated caller wraps this in its own
    // AppError/mapRpcError idiom. Re-throw the PostgrestError verbatim so
    // the caller's existing `if (error) throw …` shape handles it
    // identically to its other supabase reads (no new error class).
    throw error;
  }

  if (!data) return null;
  if ((data as { outcome?: string }).outcome !== 'success') return null;

  return {
    cached_result:
      ((data as { cached_result?: Record<string, unknown> | null })
        .cached_result) ?? null,
  };
}
