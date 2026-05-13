import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import type { ApprovalConfig } from '../room-booking-rules/dto';

/**
 * ApprovalConfigCompilerService — pure-TS compiler from `room_booking_rules
 * .approval_config jsonb` to a `workflow_definitions.graph_definition jsonb`.
 *
 * **Compile-only.** No DB writes, no `ensureForRule()`, no FK flip. v4 BLOCKER 1
 * closure (see `docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md`
 * §0 changelog) moves all persistence into the PL/pgSQL RPC
 * `public.ensure_room_booking_rule_workflow_definition` that ships in
 * migration 00399 (sub-step 6.B). This service produces the `graphDefinition`
 * jsonb that the RPC consumes; concurrent admin edits race on the row lock at
 * the rule, not on a TS-side `SELECT MAX(version)`.
 *
 * The compiled graph shape is byte-identical to the assembly performed by
 * 00399's per-rule backfill block (§3.2 block E). Unit-tested parity at
 * compile-time; integration parity (TS-side compile vs SQL-side backfill)
 * lands in 6.B's smoke probe.
 *
 * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
 *   §3.3 (recipe — compiled graph shape), §6.A.X (this sub-step).
 */

/**
 * One node in the compiled graph. Mirrors the on-disk shape consumed by
 * `WorkflowEngineService.executeNode` — see workflow-engine.service.ts:99-114
 * for the canonical `WorkflowNode` / `WorkflowEdge` / `WorkflowGraph` types
 * (private to the engine; replicated here to avoid a cross-module import on
 * a type that needs to be exported as part of the compiler's surface).
 *
 * Per §3.3, Phase 1.5's compiler emits FOUR node types: `trigger`, `approval`,
 * `end`. The `approval` node carries the full approver list + threshold in
 * `config.required_approvers` / `config.threshold` — the engine's `approval`
 * executor (workflow-engine.service.ts:1283-1352, extended in sub-step 6.A)
 * loops over `required_approvers` and inserts N approvals rows.
 */
export interface CompiledWorkflowNode {
  id: string;
  type: 'trigger' | 'approval' | 'end';
  config: Record<string, unknown>;
}

export interface CompiledWorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface WorkflowGraphDefinition {
  nodes: CompiledWorkflowNode[];
  edges: CompiledWorkflowEdge[];
}

/**
 * Rule type discriminator. v1 only emits `'room_booking'`-shaped graphs
 * (which happen to be identical for both rule types in Phase 1.5); the
 * discriminator exists so the sibling `service_rules.approval_config`
 * migration (Phase 1.5 §0.3 OUT-of-scope item) can reuse this compiler
 * without forking. The value is threaded into `approval_main.config.rule_type`
 * so downstream consumers can route on it.
 */
export type ApprovalRuleType = 'room_booking' | 'service';

export interface CompileOptions {
  /** Rule name — surfaced into the workflow_definitions.name column. */
  ruleName: string;
  /** Defaults to `'room_booking'`. See {@link ApprovalRuleType}. */
  ruleType?: ApprovalRuleType;
}

export interface CompileResult {
  graphDefinition: WorkflowGraphDefinition;
  name: string;
}

@Injectable()
export class ApprovalConfigCompilerService {
  /**
   * Compile an `ApprovalConfig` to a `WorkflowGraphDefinition`.
   *
   * Validation:
   *   - `required_approvers` MUST be present and non-empty.
   *   - Each approver MUST have `type ∈ {'person','team'}` AND a non-empty `id`.
   *     UUID format is NOT validated here — the DB FK (approvals.approver_person_id
   *     → persons.id / approver_team_id → teams.id) catches malformed ids.
   *   - `threshold`, when present, MUST be `'all'` or `'any'`. When absent,
   *     defaults to `'all'` (matches `coalesce(r.approval_config->>'threshold', 'all')`
   *     in 00399 backfill — plan §3.2 block E).
   *
   * Failure mode: throws `AppError` with code `workflow_definition.compilation_failed`
   * (422). Defense-in-depth: the migration 00399 backfill also RAISES on the
   * same shape so a malformed config can't reach steady-state.
   *
   * @param config  The rule's `approval_config` JSONB (already parsed).
   * @param opts    `{ ruleName, ruleType }`.
   * @returns       `{ graphDefinition, name }`. `name = "<ruleName> approval workflow"`.
   */
  compile(config: ApprovalConfig, opts: CompileOptions): CompileResult {
    const ruleType: ApprovalRuleType = opts.ruleType ?? 'room_booking';

    // Validation block — fail-closed before producing any graph output.
    // Per plan §3.3 edge cases, "Empty approver list" must throw at compile
    // time so the migration backfill (which also RAISES) never lands a bad
    // definition.
    const approvers = config.required_approvers;
    if (approvers === undefined || approvers === null) {
      throw new AppError('workflow_definition.compilation_failed', 422, {
        detail:
          'approval_config.required_approvers is required and must be a non-empty array.',
      });
    }
    if (!Array.isArray(approvers)) {
      throw new AppError('workflow_definition.compilation_failed', 422, {
        detail:
          'approval_config.required_approvers must be an array of {type, id} entries.',
      });
    }
    if (approvers.length === 0) {
      throw new AppError('workflow_definition.compilation_failed', 422, {
        detail: 'approval_config.required_approvers must not be empty.',
      });
    }

    for (let i = 0; i < approvers.length; i++) {
      const a = approvers[i] as unknown;
      if (a === null || typeof a !== 'object') {
        throw new AppError('workflow_definition.compilation_failed', 422, {
          detail: `approval_config.required_approvers[${i}] must be an object with {type, id}.`,
        });
      }
      const entry = a as { type?: unknown; id?: unknown };
      if (entry.type !== 'person' && entry.type !== 'team') {
        throw new AppError('workflow_definition.compilation_failed', 422, {
          detail: `approval_config.required_approvers[${i}].type must be 'person' or 'team'.`,
        });
      }
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new AppError('workflow_definition.compilation_failed', 422, {
          detail: `approval_config.required_approvers[${i}].id must be a non-empty string.`,
        });
      }
    }

    // Threshold default mirrors the SQL coalesce at plan §3.2 block E
    // (line 926 of the plan) so TS-compile and SQL-backfill agree on the
    // graph shape for legacy rules with an omitted threshold.
    const threshold = config.threshold ?? 'all';
    if (threshold !== 'all' && threshold !== 'any') {
      throw new AppError('workflow_definition.compilation_failed', 422, {
        detail:
          "approval_config.threshold must be 'all' or 'any' (or omitted, defaulting to 'all').",
      });
    }

    // Preserve input array order verbatim. The migration 00399 backfill
    // assembles the same jsonb_agg without reordering, so byte-identical
    // jsonb equality holds (the §3.3 example block at plan line 1009-1026
    // is the canonical reference shape).
    const requiredApprovers = approvers.map((a) => ({
      type: (a as { type: 'person' | 'team' }).type,
      id: (a as { id: string }).id,
    }));

    const graphDefinition: WorkflowGraphDefinition = {
      nodes: [
        { id: 'trigger', type: 'trigger', config: {} },
        {
          id: 'approval_main',
          type: 'approval',
          config: {
            required_approvers: requiredApprovers,
            threshold,
            // rule_type is threaded through for the sibling service_rules
            // spec (plan §0.3 OUT-of-scope item) — Phase 1.5 emits it but
            // doesn't branch on it.
            rule_type: ruleType,
          },
        },
        { id: 'end_success', type: 'end', config: { outcome: 'approved' } },
        { id: 'end_failure', type: 'end', config: { outcome: 'rejected' } },
      ],
      edges: [
        { from: 'trigger', to: 'approval_main' },
        { from: 'approval_main', to: 'end_success', condition: 'approved' },
        { from: 'approval_main', to: 'end_failure', condition: 'rejected' },
      ],
    };

    return {
      graphDefinition,
      name: `${opts.ruleName} approval workflow`,
    };
  }
}
