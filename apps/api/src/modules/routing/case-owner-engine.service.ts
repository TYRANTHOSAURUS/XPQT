import { Injectable } from '@nestjs/common';
import type {
  CaseOwnerPolicyDefinition,
  NormalizedRoutingContext,
  OwnerDecision,
  TraceEntry,
} from '@prequest/shared';

/**
 * Workstream B / task WB-2: Case ownership decision engine (Contract 2).
 *
 * Pure function. No IO. Given a normalized context and a published
 * `case_owner_policy` definition, picks the parent case owner team and
 * returns a trace explaining how.
 *
 * Matching rules (per plan §2, Target Operating Model):
 * - Rows are evaluated ordered by `ordering_hint` ASC (most-specific first).
 * - A row matches when *every* populated `match.*` clause is satisfied:
 *     - operational_scope_ids — context's operational_scope_chain intersects
 *     - domain_ids — context's domain_id is in the list
 *     - support_window_id — context's active_support_window_id === row's
 * - An empty `match` object matches everything (effectively a "tenant default
 *   that's more specific than default_target"). Admins shouldn't author that,
 *   but we don't reject it — the ordering_hint gives them precedence control.
 * - First match wins. Otherwise default_target.
 *
 * Vendor targets are refused by the zod schema upstream, so we don't need to
 * guard against them here — parent cases can only route to teams.
 */

@Injectable()
export class CaseOwnerEngineService {
  evaluate(
    context: NormalizedRoutingContext,
    policy: CaseOwnerPolicyDefinition,
  ): OwnerDecision {
    const trace: TraceEntry[] = [];

    const sortedRows = [...policy.rows].sort((a, b) => a.ordering_hint - b.ordering_hint);

    for (const row of sortedRows) {
      const matchResult = matchRow(row.match, context);
      if (matchResult.matched) {
        trace.push({
          step: 'policy_row',
          matched: true,
          reason: matchResult.reason,
          target: row.target,
        });
        return {
          target: row.target,
          matched_row_id: row.id,
          trace,
          evaluated_at: context.evaluated_at,
        };
      }
      trace.push({
        step: 'policy_row',
        matched: false,
        reason: matchResult.reason,
        target: null,
      });
    }

    trace.push({
      step: 'policy_default',
      matched: true,
      reason: 'no policy row matched — using default_target',
      target: policy.default_target,
    });

    return {
      target: policy.default_target,
      matched_row_id: 'default',
      trace,
      evaluated_at: context.evaluated_at,
    };
  }
}

interface MatchResult {
  matched: boolean;
  reason: string;
}

function matchRow(
  match: CaseOwnerPolicyDefinition['rows'][number]['match'],
  context: NormalizedRoutingContext,
): MatchResult {
  const clauses: string[] = [];

  if (match.operational_scope_ids && match.operational_scope_ids.length > 0) {
    const chain = context.operational_scope_chain;
    const hit = match.operational_scope_ids.some((id) => chain.includes(id));
    if (!hit) {
      return {
        matched: false,
        reason: `operational_scope_ids [${match.operational_scope_ids.join(', ')}] not in chain [${chain.join(', ')}]`,
      };
    }
    clauses.push(`scope in [${match.operational_scope_ids.join(', ')}]`);
  }

  if (match.domain_ids && match.domain_ids.length > 0) {
    if (!context.domain_id || !match.domain_ids.includes(context.domain_id)) {
      return {
        matched: false,
        reason: `domain_ids [${match.domain_ids.join(', ')}] ≠ context.domain_id ${context.domain_id ?? 'null'}`,
      };
    }
    clauses.push(`domain = ${context.domain_id}`);
  }

  if (match.support_window_id !== undefined && match.support_window_id !== null) {
    if (context.active_support_window_id !== match.support_window_id) {
      return {
        matched: false,
        reason: `support_window_id ${match.support_window_id} ≠ context.active_support_window_id ${context.active_support_window_id ?? 'null'}`,
      };
    }
    clauses.push(`support_window = ${match.support_window_id}`);
  }

  return {
    matched: true,
    reason: clauses.length > 0 ? `matched: ${clauses.join(' AND ')}` : 'matched: empty clause',
  };
}
