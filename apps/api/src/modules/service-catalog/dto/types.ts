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
}

/** Re-export the context shape so consumers don't need to deep-import. */
export type { ServiceEvaluationContext };
