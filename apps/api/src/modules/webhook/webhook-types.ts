export type FulfillmentStrategy = 'fixed' | 'asset' | 'location' | 'auto';

export interface RequestTypeRuleCondition {
  path: string;
  operator: 'equals' | 'in' | 'exists';
  value?: unknown;
}

export interface RequestTypeRule {
  when: RequestTypeRuleCondition[];
  request_type_id: string;
}

export interface RequesterLookup {
  path: string;
  strategy: 'exact_email' | 'none';
}

export interface WebhookRow {
  id: string;
  tenant_id: string;
  workflow_id: string | null;
  name: string;
  api_key_hash: string;
  active: boolean;
  ticket_defaults: Record<string, unknown>;
  field_mapping: Record<string, string>;
  default_request_type_id: string | null;
  request_type_rules: RequestTypeRule[];
  default_requester_person_id: string | null;
  requester_lookup: RequesterLookup | null;
  allowed_cidrs: string[];
  rate_limit_per_minute: number;
  last_used_at: string | null;
  created_at: string;
}

export interface ValidationProblem {
  severity: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: ValidationProblem[];
}
