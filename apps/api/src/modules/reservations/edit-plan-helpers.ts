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
import { AppErrors } from '../../common/errors';
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
 * Semantics (NIT N-CODE-1 — null vs [] clarification):
 *   - `null === null`           → equal (no chain at either side; e.g.
 *                                 allow on both old + new outcomes).
 *   - `null` vs non-null        → different (chain appearing or vanishing).
 *                                 Also true when one side is non-null with
 *                                 `required_approvers=[]`: a non-null
 *                                 ApprovalConfig is structurally distinct
 *                                 from `null`, even if its approver list
 *                                 is empty. Empty-approvers + non-null is
 *                                 a config-shape bug we want to surface as
 *                                 "changed" rather than silently equal.
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
 * Read the most-recent LIVE approval chain attached to this booking and
 * project it into the `ApprovalConfig` shape so it can be compared
 * structurally against the rule-resolver outcome's chain.
 *
 * "Live" means at least one row in `('pending', 'delegated', 'approved')`
 * status. Per spec §3.6.5 chain-state classification (00364:48-57),
 * `terminal_approved` (all-approved) is still considered active for
 * reconciliation purposes — Row 4 (require_approval → allow,
 * terminal_approved) explicitly preserves the approved chain rather than
 * expiring it. Rows with status='expired' or 'rejected' are NOT live;
 * including them as "current" was the CRITICAL C2 bug — after a Row 3
 * reconciliation flips a chain to `expired`, a subsequent edit would have
 * picked the expired chain and falsely set `old_outcome='require_approval'`
 * when the booking is now `confirmed` with no live chain.
 *
 * Reads `approvals` (00012:1-19) for `target_entity_type='booking' AND
 * target_entity_id=bookingId AND tenant_id=tenantId AND status IN (live)`,
 * picks the `approval_chain_id` with the largest MAX(created_at) (the
 * newest chain), and aggregates rows from THAT chain into:
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
 * Returns `null` when no LIVE rows exist for this booking (`v_approval_state
 * = 'none'` at 00364:476-477, OR every prior chain is expired/rejected) —
 * i.e. the booking was created with `final='allow'` and no chain was ever
 * inserted, the booking is brand new, or every prior chain has been
 * expired/rejected by the §3.6.5 reconciliation. The caller maps `null` →
 * `old_outcome='allow'`.
 *
 * NOTE on rows with NULL `approval_chain_id` (CRITICAL C3 — corrected):
 * verified at booking-flow.service.ts:1275-1296 (`createApprovalRows`) and
 * supabase/migrations/00309_create_booking_with_attach_plan_rpc.sql, every
 * approval row inserted via the booking-CREATE path carries
 * `approval_chain_id IS NULL`. Only edit-driven chains (00364) emit a
 * non-null chain_id. So the NULL bucket is the DOMINANT case for
 * approve-on-create bookings, not a "legacy rows" edge case. The bucket
 * grouping still works because edit-driven chains are inserted with a
 * larger MAX(created_at), so the newest live chain is selected correctly.
 * A future migration should backfill chain_id on create-time inserts so
 * the bucket key is uniformly canonical (tracked in
 * docs/follow-ups/b4-followups.md "create-time approvals — backfill
 * approval_chain_id").
 *
 * Tenant boundary: `tenant_id` is filtered explicitly even though the
 * SupabaseService.admin client bypasses RLS — defensive per the
 * `feedback_tenant_id_ultimate_rule` memory.
 *
 * Race window (CODE-I-PLAN-2 — accepted, see followups): this read happens
 * BEFORE the RPC's row lock. An admin grant_booking_approval landing
 * between the TS read and the RPC's FOR UPDATE could leave
 * `chain_config_changed` stale. Decision: ACCEPT. Single-edit serialisation
 * (the RPC's `pg_advisory_xact_lock` per booking) is the primary defense;
 * a concurrent admin grant during edit-build is rare. Future hardening:
 * have the RPC re-read approvals inside its row lock and recompute
 * `chain_config_changed` from `new_chain_config` + live state.
 *
 * Throws (CODE-I2): `approval.read_failed` (500 server) when supabase
 * returns an error. Previously swallowed → null, which lied about chain
 * presence and let the caller derive `old_outcome='allow'` on a transient
 * DB blip.
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

  // CODE-I-CODE-1: explicit ordering (created_at DESC, then chain_id DESC)
  // makes the bucket selection deterministic on tied created_at — without
  // it, two chains created in the same instant would pick non-deterministically.
  // The ordering is also content-stable (lexicographic uuid tiebreaker) so
  // tests that pin a fixture to a specific bucket don't flake.
  // CODE-C2: status IN (pending, delegated, approved) — exclude expired
  // and rejected chains. See docstring "Live" definition above.
  const { data, error } = await supabase.admin
    .from('approvals')
    .select(
      'approval_chain_id, parallel_group, approver_person_id, approver_team_id, created_at, status',
    )
    .eq('tenant_id', tenantId)
    .eq('target_entity_type', 'booking')
    .eq('target_entity_id', bookingId)
    .in('status', ['pending', 'delegated', 'approved'])
    .order('created_at', { ascending: false })
    .order('approval_chain_id', { ascending: false, nullsFirst: false });

  if (error) {
    // CODE-I2: throw, never swallow. 500 server-class — DB transient
    // failures during plan assembly are not a payload problem; the user
    // sees "Try again in a moment" + a traceId.
    throw AppErrors.server('approval.read_failed', {
      detail: 'Could not read booking approvals during edit-plan assembly.',
      cause: error,
    });
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
