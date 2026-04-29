import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PredicateEngineService } from '../room-booking-rules/predicate-engine.service';
import type { ServiceEvaluationContext } from './service-evaluation-context';
import type {
  ApproverTarget,
  MatchedServiceRule,
  ServiceRuleEffect,
  ServiceRuleOutcome,
  ServiceRuleRow,
} from './dto/types';

/**
 * Resolves which service rules apply to a given service line in a given
 * evaluation context, then aggregates effects.
 *
 * Specificity (lowest is most specific):
 *   1. catalog_item     (target_id = line.catalog_item_id)
 *   2. menu             (target_id = line.menu_id)
 *   3. catalog_category (target_id = catalog_items.category for the line)
 *   4. tenant
 *
 * Within a specificity bucket, higher `priority` wins. Aggregation follows
 * the same any-wins ladder as room rules (deny > require_approval > warn >
 * allow_override > allow).
 */

export interface ResolveServiceRulesArgs {
  lines: Array<{
    /** Stable key the caller uses to map outcomes back to inputs. */
    lineKey: string;
    catalog_item_id: string;
    catalog_item_category: string | null;
    menu_id: string | null;
  }>;
  contextFor: (lineKey: string) => ServiceEvaluationContext;
}

@Injectable()
export class ServiceRuleResolverService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: PredicateEngineService,
  ) {}

  /**
   * Bulk resolution path used by `BundleService.attachServicesToReservation`
   * and the standalone-order pipeline. Loads every active service rule once,
   * then filters per-line by specificity.
   */
  async resolveBulk(args: ResolveServiceRulesArgs): Promise<Map<string, ServiceRuleOutcome>> {
    const out = new Map<string, ServiceRuleOutcome>();
    if (args.lines.length === 0) return out;

    const allRules = await this.fetchAllRules();
    if (allRules.length === 0) {
      for (const line of args.lines) out.set(line.lineKey, this.allowOutcome());
      return out;
    }

    for (const line of args.lines) {
      const ctx = args.contextFor(line.lineKey);
      const matched = await this.matchAndEvaluate(allRules, line, ctx);
      out.set(line.lineKey, this.aggregate(matched));
    }
    return out;
  }

  /** Single-line path used by simulation. */
  async resolveOne(
    line: ResolveServiceRulesArgs['lines'][number],
    ctx: ServiceEvaluationContext,
  ): Promise<ServiceRuleOutcome> {
    const allRules = await this.fetchAllRules();
    const matched = await this.matchAndEvaluate(allRules, line, ctx);
    return this.aggregate(matched);
  }

  /**
   * Used by SimulationService — evaluate a draft set of rules against an
   * arbitrary context. Skips the DB load.
   */
  async evaluateAdHoc(
    rules: ServiceRuleRow[],
    line: ResolveServiceRulesArgs['lines'][number],
    ctx: ServiceEvaluationContext,
  ): Promise<ServiceRuleOutcome> {
    const matched = await this.matchAndEvaluate(rules, line, ctx);
    return this.aggregate(matched);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async fetchAllRules(): Promise<ServiceRuleRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true);
    if (error) throw error;
    return (data ?? []) as ServiceRuleRow[];
  }

  private async matchAndEvaluate(
    rules: ServiceRuleRow[],
    line: ResolveServiceRulesArgs['lines'][number],
    ctx: ServiceEvaluationContext,
  ): Promise<MatchedServiceRule[]> {
    const candidates = bucketRulesBySpecificity(rules, line);
    // Iterate buckets most-specific-first (1 = catalog_item, 4 = tenant).
    // Map.entries() preserves insertion order, which depends on DB return
    // order, so sort by specificity ascending here for deterministic
    // ordering. Within a bucket, higher priority wins.
    const sortedBuckets = Array.from(candidates.entries()).sort(
      ([a], [b]) => a - b,
    );
    const orderedRules: MatchedServiceRule[] = [];
    for (const [specificity, bucket] of sortedBuckets) {
      bucket.sort((a, b) => b.priority - a.priority);
      for (const r of bucket) orderedRules.push({ ...r, specificity });
    }
    if (orderedRules.length === 0) return [];

    const predicates = orderedRules.map((r) => r.applies_when);
    await this.engine.hydrateContextHelpers(predicates as unknown as never[], ctx);

    const matched: MatchedServiceRule[] = [];
    for (const rule of orderedRules) {
      let fired: boolean;
      try {
        fired = this.engine.evaluate(rule.applies_when as unknown as never, ctx);
      } catch (err) {
        // Same posture as room rules: malformed predicate = no match, admin
        // fixes in the editor. Surface for drift detection.
        console.warn(
          `[service-rules] rule ${rule.id} predicate eval failed:`,
          (err as Error).message,
        );
        fired = false;
      }
      if (fired) matched.push(rule);
    }
    return matched;
  }

  private aggregate(matched: MatchedServiceRule[]): ServiceRuleOutcome {
    if (matched.length === 0) return this.allowOutcome();

    // Effect aggregation — deny dominates everything.
    let effect: ServiceRuleEffect = 'allow';
    const denials: string[] = [];
    const warnings: string[] = [];
    const approverTargets: ServiceRuleOutcome['approver_targets'] = [];

    // Setup-flag aggregation is independent of effect: any rule with the
    // flag set wins (OR), and lead-time uses MAX (be conservative — if
    // any rule asked for 60min, give it 60min).
    let requiresInternalSetup = false;
    let internalSetupLeadTimeMinutes: number | null = null;

    for (const rule of matched) {
      switch (rule.effect) {
        case 'deny':
          effect = 'deny';
          if (rule.denial_message) denials.push(rule.denial_message);
          break;
        case 'require_approval':
          if (effect !== 'deny') effect = 'require_approval';
          approverTargets.push(...this.extractApproverTargets(rule));
          if (rule.denial_message) denials.push(rule.denial_message);
          break;
        case 'allow_override':
          if (effect === 'allow') effect = 'allow_override';
          break;
        case 'warn':
          if (rule.denial_message) warnings.push(rule.denial_message);
          break;
        case 'allow':
          // explicit allow — no effect change
          break;
      }

      if (rule.requires_internal_setup) {
        requiresInternalSetup = true;
        if (rule.internal_setup_lead_time_minutes != null) {
          internalSetupLeadTimeMinutes = Math.max(
            internalSetupLeadTimeMinutes ?? 0,
            rule.internal_setup_lead_time_minutes,
          );
        }
      }
    }

    return {
      effect,
      matched_rule_ids: matched.map((r) => r.id),
      denial_messages: denials,
      warning_messages: warnings,
      approver_targets: approverTargets,
      requires_internal_setup: requiresInternalSetup,
      internal_setup_lead_time_minutes: internalSetupLeadTimeMinutes,
    };
  }

  private extractApproverTargets(
    rule: MatchedServiceRule,
  ): Array<{ rule_id: string; target: ApproverTarget }> {
    const cfg = rule.approval_config;
    if (!cfg || !cfg.approver_target) return [];
    const t = cfg.approver_target;
    if (t === 'person' && cfg.person_id) {
      return [{ rule_id: rule.id, target: { kind: 'person', person_id: cfg.person_id } }];
    }
    if (t === 'role' && cfg.role_id) {
      return [{ rule_id: rule.id, target: { kind: 'role', role_id: cfg.role_id } }];
    }
    if (t === 'derived' && cfg.expr) {
      return [{ rule_id: rule.id, target: { kind: 'derived', expr: cfg.expr } }];
    }
    if (t === 'cost_center.default_approver') {
      return [
        { rule_id: rule.id, target: { kind: 'derived', expr: 'cost_center.default_approver' } },
      ];
    }
    return [];
  }

  private allowOutcome(): ServiceRuleOutcome {
    return {
      effect: 'allow',
      matched_rule_ids: [],
      denial_messages: [],
      warning_messages: [],
      approver_targets: [],
      requires_internal_setup: false,
      internal_setup_lead_time_minutes: null,
    };
  }
}

// ── Specificity helper (exported for testing) ─────────────────────────────

export function bucketRulesBySpecificity(
  rules: ServiceRuleRow[],
  line: { catalog_item_id: string; catalog_item_category: string | null; menu_id: string | null },
): Map<number, ServiceRuleRow[]> {
  const buckets = new Map<number, ServiceRuleRow[]>();
  for (const rule of rules) {
    if (!rule.active) continue;
    let specificity: number | null = null;
    switch (rule.target_kind) {
      case 'catalog_item':
        if (rule.target_id === line.catalog_item_id) specificity = 1;
        break;
      case 'menu':
        if (rule.target_id && line.menu_id && rule.target_id === line.menu_id) specificity = 2;
        break;
      case 'catalog_category':
        if (rule.target_id && line.catalog_item_category && rule.target_id === line.catalog_item_category) {
          specificity = 3;
        }
        break;
      case 'tenant':
        specificity = 4;
        break;
    }
    if (specificity != null) {
      const list = buckets.get(specificity) ?? [];
      list.push(rule);
      buckets.set(specificity, list);
    }
  }
  return buckets;
}
