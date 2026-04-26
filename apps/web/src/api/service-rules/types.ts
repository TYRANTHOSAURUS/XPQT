export type ServiceRuleEffect = 'deny' | 'require_approval' | 'allow_override' | 'warn' | 'allow';
export type ServiceRuleTargetKind = 'catalog_item' | 'menu' | 'catalog_category' | 'tenant';

export interface ServiceRule {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  target_kind: ServiceRuleTargetKind;
  target_id: string | null;
  applies_when: Record<string, unknown>;
  effect: ServiceRuleEffect;
  approval_config: Record<string, unknown> | null;
  denial_message: string | null;
  priority: number;
  active: boolean;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceRuleTemplate {
  id: string;
  template_key: string;
  name: string;
  description: string;
  category: 'approval' | 'availability' | 'capacity';
  effect_default: ServiceRuleEffect;
  applies_when_template: Record<string, unknown>;
  param_specs: Array<{
    key: string;
    label: string;
    type: 'number' | 'string' | 'boolean' | 'days_of_week' | 'catalog_item' | 'role';
    default?: unknown;
  }>;
  approval_config_template: Record<string, unknown> | null;
  active: boolean;
}
