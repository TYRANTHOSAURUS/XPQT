import { Injectable, Logger } from '@nestjs/common';
import type {
  CaseOwnerPolicyDefinition,
  IntakeContext,
  OwnerDecision,
  RoutingV2Mode,
} from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { CaseOwnerEngineService } from './case-owner-engine.service';
import { IntakeScopingService } from './intake-scoping.service';
import { PolicyStoreService } from './policy-store.service';
import { ResolverService } from './resolver.service';
import {
  AssignmentTarget,
  ChosenBy,
  ResolverContext,
  ResolverDecision,
} from './resolver.types';

/**
 * Workstream 0 / Artifact E: dual-run hook point.
 *
 * Wraps the legacy {@link ResolverService} and a (not-yet-implemented) v2 engine.
 * Reads `tenants.feature_flags.routing_v2_mode` per tenant and fans out:
 *
 *   - `off`     → legacy only. Default. Zero v2 load.
 *   - `dualrun` → legacy + v2 both evaluated, legacy served, diff logged.
 *   - `shadow`  → same as dualrun — ops actively monitors v2 before cutover.
 *   - `v2_only` → v2 served, legacy not run.
 *
 * This service is intentionally NOT wired into TicketService yet. The call-site
 * swap lives with Workstream B/D. Registering it here freezes the contract so
 * downstream workstreams have a stable seam.
 */

export type RoutingHook = 'case_owner' | 'child_dispatch';

export class RoutingV2NotImplementedError extends Error {
  constructor(hook: RoutingHook) {
    super(`Routing v2 engine for hook "${hook}" is not implemented yet (Workstream B/C/D).`);
    this.name = 'RoutingV2NotImplementedError';
  }
}

interface FlagCacheEntry {
  mode: RoutingV2Mode;
  expires_at: number;
}

const FLAG_CACHE_TTL_MS = 30_000;

@Injectable()
export class RoutingEvaluatorService {
  private readonly logger = new Logger(RoutingEvaluatorService.name);
  private readonly flagCache = new Map<string, FlagCacheEntry>();

  constructor(
    private readonly legacyResolver: ResolverService,
    private readonly supabase: SupabaseService,
    private readonly intakeScoping: IntakeScopingService,
    private readonly policyStore: PolicyStoreService,
    private readonly caseOwnerEngine: CaseOwnerEngineService,
  ) {}

  /**
   * Evaluate parent case ownership. In W0 the v2 engine is a stub — only the
   * plumbing is live. `off` mode is a pure pass-through.
   */
  async evaluateCaseOwner(context: ResolverContext): Promise<ResolverDecision> {
    return this.evaluate('case_owner', context);
  }

  /**
   * Evaluate child work-order dispatch. Same v2-stub caveat as above.
   */
  async evaluateChildDispatch(context: ResolverContext): Promise<ResolverDecision> {
    return this.evaluate('child_dispatch', context);
  }

  private async evaluate(
    hook: RoutingHook,
    context: ResolverContext,
  ): Promise<ResolverDecision> {
    const mode = await this.getMode(context.tenant_id);

    // Fast path: flag off → zero v2 overhead. This is the default.
    if (mode === 'off') {
      return this.legacyResolver.resolve(context);
    }

    // Legacy is always computed unless we're in v2_only — we need it for the
    // diff log, and it's what the ticket actually uses up to `shadow`.
    const legacy = mode === 'v2_only' ? null : await this.legacyResolver.resolve(context);

    let v2: ResolverDecision | null = null;
    let v2Error: string | null = null;
    try {
      v2 = await this.evaluateV2(hook, context);
    } catch (err) {
      v2Error = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `v2 evaluation failed for tenant ${context.tenant_id} hook ${hook}: ${v2Error}`,
      );
    }

    await this.recordDualRunDiff(hook, mode, context, legacy, v2, v2Error);

    if (mode === 'v2_only') {
      if (!v2) {
        throw new Error(
          `routing_v2_mode=v2_only for tenant ${context.tenant_id} but v2 evaluation failed: ${v2Error ?? 'unknown'}`,
        );
      }
      return v2;
    }

    // dualrun + shadow → serve legacy. Legacy is non-null here because mode !== v2_only.
    return legacy!;
  }

  /**
   * v2 engine dispatch. `case_owner` is wired in Workstream B; `child_dispatch`
   * still throws until Workstream C lands.
   */
  private async evaluateV2(hook: RoutingHook, context: ResolverContext): Promise<ResolverDecision> {
    if (hook === 'case_owner') return this.evaluateCaseOwnerV2(context);
    throw new RoutingV2NotImplementedError(hook);
  }

  /**
   * Workstream B wiring: intake → published case_owner_policy → engine → ResolverDecision.
   *
   * Tenants whose request_type has no `case_owner_policy_entity_id` attached yet
   * still want v2 dual-run to be non-fatal — we return `unassigned` with a trace
   * instead of throwing, so the diff log captures "v2 has no policy" as data.
   */
  private async evaluateCaseOwnerV2(context: ResolverContext): Promise<ResolverDecision> {
    const policyEntityId = await this.loadCaseOwnerPolicyEntityId(
      context.tenant_id,
      context.request_type_id,
    );
    if (!policyEntityId) {
      return unassignedDecision('v2: request_type has no case_owner_policy_entity_id attached');
    }

    const published = await this.policyStore.getPublishedDefinition<'case_owner_policy'>(
      context.tenant_id,
      policyEntityId,
    );
    if (!published) {
      return unassignedDecision(
        `v2: case_owner_policy ${policyEntityId} has no published version`,
      );
    }

    const intake: IntakeContext = {
      tenant_id: context.tenant_id,
      request_type_id: context.request_type_id ?? '',
      requester_person_id: null,
      selected_location_id: context.location_id,
      asset_id: context.asset_id,
      priority: normalizePriority(context.priority),
      evaluated_at: new Date().toISOString(),
    };
    const normalized = await this.intakeScoping.normalize(intake);
    const decision = this.caseOwnerEngine.evaluate(
      normalized,
      published.definition as CaseOwnerPolicyDefinition,
    );

    return adaptOwnerDecisionToResolver(decision);
  }

  private async loadCaseOwnerPolicyEntityId(
    tenant_id: string,
    request_type_id: string | null,
  ): Promise<string | null> {
    if (!request_type_id) return null;
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .select('case_owner_policy_entity_id')
      .eq('tenant_id', tenant_id)
      .eq('id', request_type_id)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `Failed to load case_owner_policy_entity_id for request_type ${request_type_id}: ${error.message}`,
      );
      return null;
    }
    return (data?.case_owner_policy_entity_id as string | null) ?? null;
  }

  private async getMode(tenantId: string): Promise<RoutingV2Mode> {
    const cached = this.flagCache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expires_at > now) return cached.mode;

    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('feature_flags')
      .eq('id', tenantId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`Failed to read feature_flags for tenant ${tenantId}: ${error.message}`);
      return 'off';
    }

    const mode = parseRoutingV2Mode((data?.feature_flags ?? {}) as Record<string, unknown>);
    this.flagCache.set(tenantId, { mode, expires_at: now + FLAG_CACHE_TTL_MS });
    return mode;
  }

  private async recordDualRunDiff(
    hook: RoutingHook,
    mode: RoutingV2Mode,
    context: ResolverContext,
    legacy: ResolverDecision | null,
    v2: ResolverDecision | null,
    v2Error: string | null,
  ): Promise<void> {
    try {
      const target_match = legacy && v2 ? targetsEqual(legacy.target, v2.target) : null;
      const chosen_by_match = legacy && v2 ? legacy.chosen_by === v2.chosen_by : null;

      const { error } = await this.supabase.admin.from('routing_dualrun_logs').insert({
        tenant_id: context.tenant_id,
        mode,
        hook,
        ticket_id: context.ticket_id,
        request_type_id: context.request_type_id,
        input: context as unknown as Record<string, unknown>,
        legacy_output: legacy as unknown as Record<string, unknown> | null,
        v2_output: v2 as unknown as Record<string, unknown> | null,
        target_match,
        chosen_by_match,
        diff_summary: v2Error ? { v2_error: v2Error } : {},
      });

      if (error) {
        this.logger.warn(`Failed to write routing_dualrun_logs row: ${error.message}`);
      }
    } catch (err) {
      this.logger.warn(
        `recordDualRunDiff threw for tenant ${context.tenant_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function parseRoutingV2Mode(flags: Record<string, unknown>): RoutingV2Mode {
  const raw = flags.routing_v2_mode;
  if (raw === 'dualrun' || raw === 'shadow' || raw === 'v2_only') return raw;
  return 'off';
}

function normalizePriority(raw: string | null): IntakeContext['priority'] {
  if (raw === 'low' || raw === 'high' || raw === 'urgent') return raw;
  return 'normal';
}

function unassignedDecision(reason: string): ResolverDecision {
  return {
    target: null,
    chosen_by: 'unassigned',
    strategy: 'fixed',
    trace: [{ step: 'unassigned', matched: true, reason, target: null }],
  };
}

function adaptOwnerDecisionToResolver(decision: OwnerDecision): ResolverDecision {
  const chosen_by: ChosenBy =
    decision.matched_row_id === 'default' ? 'policy_default' : 'policy_row';
  return {
    target: decision.target as AssignmentTarget,
    chosen_by,
    strategy: 'fixed',
    trace: decision.trace,
  };
}

function targetsEqual(a: ResolverDecision['target'], b: ResolverDecision['target']): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'team' && b.kind === 'team') return a.team_id === b.team_id;
  if (a.kind === 'user' && b.kind === 'user') return a.user_id === b.user_id;
  if (a.kind === 'vendor' && b.kind === 'vendor') return a.vendor_id === b.vendor_id;
  return false;
}
