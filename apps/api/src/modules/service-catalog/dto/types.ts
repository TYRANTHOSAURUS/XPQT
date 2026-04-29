import type { ServiceEvaluationContext } from '../service-evaluation-context';

export type ServiceRuleEffect = 'deny' | 'require_approval' | 'allow_override' | 'warn' | 'allow';
export type ServiceRuleTargetKind = 'catalog_item' | 'menu' | 'catalog_category' | 'tenant';

export interface ServiceRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  target_kind: ServiceRuleTargetKind;
  target_id: string | null;
  applies_when: Record<string, unknown>;
  effect: ServiceRuleEffect;
  approval_config: ApprovalConfig | null;
  denial_message: string | null;
  priority: number;
  active: boolean;
  template_id: string | null;
  /**
   * When true, an order line that matches this rule triggers auto-creation
   * of an internal setup work order. Routing (team, lead time, SLA policy)
   * is resolved via location_service_routing (00194) at trigger time —
   * keeps "when" (this field) separate from "who" (matrix). See
   * docs/superpowers/plans/2026-04-29-fulfillment-fixes-wave2.md Slice 2.
   */
  requires_internal_setup: boolean;
  /**
   * Optional override for the matrix's default_lead_time_minutes. NULL
   * means "use the matrix default." Useful for high-touch rules that
   * need more setup runway than the building's standard.
   */
  internal_setup_lead_time_minutes: number | null;
}

export type ApproverTarget =
  | { kind: 'person'; person_id: string }
  | { kind: 'role'; role_id: string }
  | { kind: 'derived'; expr: string };

export interface ApprovalConfig {
  approver_target: 'person' | 'role' | 'derived' | 'cost_center.default_approver';
  person_id?: string;
  role_id?: string;
  /** When approver_target is 'derived', this is the expression to evaluate. */
  expr?: string;
  threshold_currency?: number;
  sla_minutes?: number;
}

export interface MatchedServiceRule extends ServiceRuleRow {
  /** 1=catalog_item, 2=menu, 3=catalog_category, 4=tenant. Lower is more specific. */
  specificity: number;
}

export interface ServiceRuleOutcome {
  /** Aggregated final effect — deny > require_approval > warn > allow. */
  effect: ServiceRuleEffect;
  matched_rule_ids: string[];
  denial_messages: string[];
  warning_messages: string[];
  approver_targets: Array<{
    rule_id: string;
    target: ApproverTarget;
  }>;
  /**
   * Aggregated from matched rules (OR — any rule with the flag set wins).
   * Caller looks up location_service_routing to find the team/SLA, then
   * creates a booking-origin work order. Independent of `effect`: a line
   * can be `allow` AND `requires_internal_setup`.
   */
  requires_internal_setup: boolean;
  /**
   * Largest lead time across matched rules whose flag is set; falls back
   * to the matrix default when no rule overrides. NULL means "use the
   * matrix default." Aggregation is MAX (be conservative — if any rule
   * needs 60min, give it 60min even if another said 30).
   */
  internal_setup_lead_time_minutes: number | null;
}

/** Re-export the context shape so consumers don't need to deep-import. */
export type { ServiceEvaluationContext };
