/**
 * B.4 step 2D-C — pure helpers consumed by `AssembleEditPlanService`
 * (the TS-side EditPlan builder for the `edit_booking` RPC).
 *
 * Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.3 + §3.6.5.
 * RPC contract this feeds: supabase/migrations/00364_edit_booking_rpc_v4.sql
 *   - `approval` block shape: 00364:13-33 + :276-308.
 *   - `cost_amount_snapshot` semantics: 00364:198 (nullable numeric(10,2)
 *     stored on `bookings`; mirrors `bookings.cost_amount_snapshot` at
 *     00277:62 and the create-time computation at booking-flow.service.ts
 *     :1248-1253).
 *   - approver `{type, id}` enum: 00364:21-22 + booking-flow.service.ts:1268.
 *   - `parallel_group` convention: 00364:589-596 + booking-flow.service.ts
 *     :1273 (`threshold='all'` → `parallel-<bookingId>`; `'any'` → `null`).
 *
 * These helpers are intentionally split from the orchestrator (Commit C2)
 * so the unit-testable surface is small and dependency-free. They take
 * primitive inputs + return primitive outputs — no SupabaseService /
 * TenantContext dependencies except where the helper IS a DB read
 * (`loadCurrentApprovalChain`).
 */

import { createHash } from 'node:crypto';
import type { SupabaseService } from '../../common/supabase/supabase.service';
import type { ApprovalConfig, RuleEffect } from '../room-booking-rules/dto';
import type { ResolveOutcome } from '../room-booking-rules/rule-resolver.service';

// ─────────────────────────────────────────────────────────────────────────
// 1. Cost helper — pure
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pure variant of `BookingFlowService.computeCost` (booking-flow.service.ts
 * :1248-1253) that takes the inputs the helper actually needs (cost rate +
 * window) instead of the full `CreateReservationInput` shape. Lets the edit
 * pipeline compute cost without manufacturing a fake `CreateReservationInput`.
 *
 * Behaviour mirrors create exactly: `null` when the room has no rate, else
 * `(rate × minutes) / 60` rounded to 2 dp via `.toFixed(2)`. NUMERIC(10,2)
 * round-trip is preserved by returning a string (matches the
 * `bookings.cost_amount_snapshot` storage type at 00277:62).
 *
 * `start`/`end` are ISO strings (the wire format on every booking patch).
 */
export function computeCostFromHours(
  costPerHour: string | null,
  startIso: string,
  endIso: string,
): string | null {
  if (!costPerHour) return null;
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  const minutes = (endMs - startMs) / 60_000;
  const cost = (Number(costPerHour) * minutes) / 60;
  return cost.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Approver-set canonical sort
// ─────────────────────────────────────────────────────────────────────────

export type Approver = { type: 'person' | 'team'; id: string };

/**
 * Canonical-sort the approver list so order-only differences don't flip
 * `chain_config_changed`. Spec §3.6.5 (penultimate paragraph): TS plan-
 * builder MUST canonical-sort approver IDs (e.g. lexicographic on
 * `(type, id)`) before structural comparison.
 *
 * 'person' < 'team' lexicographically by JS default string compare; we
 * make that explicit to defend against future enum extensions.
 *
 * Returns a NEW array (never mutates input).
 */
export function canonicalApproverSort(approvers: ReadonlyArray<Approver>): Approver[] {
  return [...approvers].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Chain-config equality
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compare two approval-chain configs after canonical sort. Drives
 * `EditPlan.approval.chain_config_changed` (00364:21 + §3.6.5 row 6 vs
 * row 7).
 *
 * Semantics:
 *   - `null === null`           → equal (no chain at either side).
 *   - `null` vs non-null        → different (chain appearing or vanishing).
 *   - non-null vs non-null      → equal IFF threshold matches AND the
 *                                 canonically-sorted approver lists are
 *                                 element-wise equal on `(type, id)`.
 *
 * Threshold defaults to `'all'` if absent, mirroring 00364:584
 * (`coalesce(v_new_chain_config->>'threshold', 'all')`).
 */
export function chainConfigsEqual(
  a: ApprovalConfig | null,
  b: ApprovalConfig | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  const thresholdA = a.threshold ?? 'all';
  const thresholdB = b.threshold ?? 'all';
  if (thresholdA !== thresholdB) return false;

  const sortedA = canonicalApproverSort(a.required_approvers ?? []);
  const sortedB = canonicalApproverSort(b.required_approvers ?? []);
  if (sortedA.length !== sortedB.length) return false;

  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i].type !== sortedB[i].type) return false;
    if (sortedA[i].id !== sortedB[i].id) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Load current approval chain
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read the most-recent approval chain attached to this booking and
 * project it into the `ApprovalConfig` shape so it can be compared
 * structurally against the rule-resolver outcome's chain.
 *
 * Reads `approvals` (00012:1-19) for `target_entity_type='booking' AND
 * target_entity_id=bookingId AND tenant_id=tenantId`, picks the
 * `approval_chain_id` with the largest MAX(created_at) (the newest
 * chain — older chains are kept in the audit log as `'expired'` by
 * the §3.6.5 reconciliation), and aggregates rows from THAT chain into:
 *
 *   - `required_approvers` : list of `{type:'person'|'team', id}` derived
 *                            from `approver_person_id` / `approver_team_id`
 *                            (mutually exclusive per the booking-flow
 *                            create-time INSERT shape at booking-flow.service
 *                            .ts:1275-1283).
 *   - `threshold`          : `'all'` if any row's `parallel_group` matches
 *                            the convention `parallel-<bookingId>` (00364
 *                            :593 + booking-flow.service.ts:1273); else
 *                            `'any'`.
 *
 * Returns `null` when no rows exist for this booking (`v_approval_state =
 * 'none'` at 00364:476-477) — i.e. the booking was created with
 * `final='allow'` and no chain was ever inserted, or the booking is brand
 * new. The caller maps `null` → `old_outcome='allow'`.
 *
 * NOTE on rows with NULL `approval_chain_id`: legacy single-step rows
 * inserted before chain-id became canonical may have a NULL chain. We
 * treat NULL as a single implicit chain bucket and aggregate them as one
 * chain dated by their max `created_at`. New chains (post-00364) always
 * carry a chain_id, so the NULL bucket will only appear for legacy rows.
 *
 * Tenant boundary: `tenant_id` is filtered explicitly even though the
 * SupabaseService.admin client bypasses RLS — defensive per the
 * `feedback_tenant_id_ultimate_rule` memory.
 */
export async function loadCurrentApprovalChain(
  supabase: SupabaseService,
  bookingId: string,
  tenantId: string,
): Promise<ApprovalConfig | null> {
  type Row = {
    approval_chain_id: string | null;
    parallel_group: string | null;
    approver_person_id: string | null;
    approver_team_id: string | null;
    created_at: string;
    status: string;
  };

  const { data, error } = await supabase.admin
    .from('approvals')
    .select(
      'approval_chain_id, parallel_group, approver_person_id, approver_team_id, created_at, status',
    )
    .eq('tenant_id', tenantId)
    .eq('target_entity_type', 'booking')
    .eq('target_entity_id', bookingId);

  if (error) {
    // Surface as null — caller treats null as `old_outcome='allow'` which
    // is the safe default (no chain to preserve). The orchestrator owns
    // any retry / failure semantics.
    return null;
  }

  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return null;

  // Group by approval_chain_id (NULL-bucket allowed for legacy rows).
  // Pick the bucket whose MAX(created_at) is greatest — that's the
  // newest chain (the one §3.6.5 considers "live"). Older chains live in
  // the audit log as `'expired'` and are not part of the equality
  // comparison.
  const bucketKeyFor = (r: Row): string => r.approval_chain_id ?? '__null__';
  const buckets = new Map<string, { rows: Row[]; maxCreatedAt: number }>();
  for (const r of rows) {
    const key = bucketKeyFor(r);
    const ts = new Date(r.created_at).getTime();
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { rows: [r], maxCreatedAt: Number.isFinite(ts) ? ts : 0 });
    } else {
      bucket.rows.push(r);
      if (Number.isFinite(ts) && ts > bucket.maxCreatedAt) bucket.maxCreatedAt = ts;
    }
  }

  let newest: { rows: Row[]; maxCreatedAt: number } | null = null;
  for (const bucket of buckets.values()) {
    if (newest === null || bucket.maxCreatedAt > newest.maxCreatedAt) {
      newest = bucket;
    }
  }
  if (newest === null || newest.rows.length === 0) return null;

  const chainRows = newest.rows;

  // Threshold derivation: any row with `parallel_group` matching
  // `parallel-<bookingId>` → 'all' (parallel chain — every approver must
  // say yes per booking-flow.service.ts:1273). Otherwise 'any'.
  const parallelMarker = `parallel-${bookingId}`;
  const threshold: 'all' | 'any' = chainRows.some(
    (r) => r.parallel_group === parallelMarker,
  )
    ? 'all'
    : 'any';

  const required_approvers: Approver[] = [];
  for (const r of chainRows) {
    if (r.approver_person_id) {
      required_approvers.push({ type: 'person', id: r.approver_person_id });
    } else if (r.approver_team_id) {
      required_approvers.push({ type: 'team', id: r.approver_team_id });
    }
    // Rows with neither set are skipped — they violate the create-time
    // INSERT contract (booking-flow.service.ts:1280-1281 always sets
    // exactly one) and shouldn't influence equality.
  }

  if (required_approvers.length === 0) return null;

  return {
    required_approvers,
    threshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Rule-outcome fingerprint
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sha-256 hex digest of the canonical projection of a `ResolveOutcome`
 * (rule-resolver.service.ts:64-75). Used by the TS edit pipeline's
 * stale-resolution retry loop (spec §3.4 step 5):
 *
 *   1. Build plan A → fingerprint A.
 *   2. RPC raises `automation_plan.stale_resolution`.
 *   3. Re-resolve → fingerprint B.
 *   4. If A === B → safe to retry (rules changed but our outcome didn't).
 *      If A !== B → 422 `automation_plan.semantic_mismatch` — operator must
 *      review the new outcome before retrying.
 *
 * Canonicalisation rules:
 *   - `final` is included as-is.
 *   - `matched_rule_ids` is the rule ids only (effects + denial messages
 *     change for irrelevant reasons; only ID set matters for "did the
 *     resolver match the same rules?"), sorted lexicographically.
 *   - `approvalConfig` is null OR `{required_approvers (canonical-sorted),
 *     threshold (default 'all')}` — same shape used by `chainConfigsEqual`.
 *   - `effects` is INCLUDED as a sorted set so a rule that flipped from
 *     `warn` to `deny` (without changing the matched-rule id) flips the
 *     fingerprint.
 *
 * Returns hex digest (64 chars).
 */
export function computeRuleOutcomeFingerprint(outcome: ResolveOutcome): string {
  const canonicalApproval =
    outcome.approvalConfig === null
      ? null
      : {
          required_approvers: canonicalApproverSort(
            outcome.approvalConfig.required_approvers ?? [],
          ),
          threshold: outcome.approvalConfig.threshold ?? 'all',
        };

  const matchedRuleIds = outcome.matchedRules.map((r) => r.id).sort();
  const effects = [...new Set<RuleEffect>(outcome.effects)].sort();

  const projection = {
    final: outcome.final,
    matched_rule_ids: matchedRuleIds,
    effects,
    approval: canonicalApproval,
  };

  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}
