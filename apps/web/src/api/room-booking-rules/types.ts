/**
 * Room-booking-rules API types. Mirrors the API DTOs in
 * apps/api/src/modules/room-booking-rules/dto.
 */

export type RuleEffect = 'deny' | 'require_approval' | 'allow_override' | 'warn';
export type TargetScope = 'room' | 'room_type' | 'space_subtree' | 'tenant';
export type ChangeType = 'create' | 'update' | 'enable' | 'disable' | 'delete';

export type RulePredicate =
  | { and: RulePredicate[] }
  | { or: RulePredicate[] }
  | { not: RulePredicate }
  | { fn: string; args: unknown[] }
  | { op: 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; left: unknown; right?: unknown };

export interface ApprovalConfig {
  required_approvers?: Array<{ type: 'team' | 'person'; id: string }>;
  threshold?: 'all' | 'any';
}

export interface RoomBookingRule {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  target_scope: TargetScope;
  target_id: string | null;
  applies_when: RulePredicate;
  effect: RuleEffect;
  approval_config: ApprovalConfig | null;
  denial_message: string | null;
  priority: number;
  template_id: string | null;
  template_params: Record<string, unknown> | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface RuleVersion {
  id: string;
  rule_id: string;
  tenant_id: string;
  version_number: number;
  change_type: ChangeType;
  snapshot: Record<string, unknown>;
  diff: Record<string, { before: unknown; after: unknown }> | null;
  actor_user_id: string | null;
  actor_at: string;
}

export interface RuleTemplateParamSpec {
  key: string;
  type:
    | 'role_ids'
    | 'org_node_id'
    | 'calendar_id'
    | 'interval_minutes'
    | 'attendee_count'
    | 'factor'
    | 'mode'
    | 'approval_config'
    | 'denial_message';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}

export interface RuleTemplate {
  id: string;
  label: string;
  description: string;
  effect_hint: RuleEffect;
  paramSpecs: RuleTemplateParamSpec[];
}

export interface CreateRulePayload {
  name: string;
  description?: string | null;
  target_scope: TargetScope;
  target_id?: string | null;
  applies_when: RulePredicate;
  effect: RuleEffect;
  approval_config?: ApprovalConfig | null;
  denial_message?: string | null;
  priority?: number;
  template_id?: string | null;
  template_params?: Record<string, unknown> | null;
  active?: boolean;
}

export type UpdateRulePayload = Partial<CreateRulePayload>;

export interface FromTemplatePayload {
  template_id: string;
  params: Record<string, unknown>;
  target_scope: TargetScope;
  target_id?: string | null;
  name?: string;
  description?: string | null;
  priority?: number;
  active?: boolean;
}

export interface BookingScenario {
  requester_person_id: string;
  space_id: string;
  start_at: string;
  end_at: string;
  attendee_count?: number | null;
  criteria?: Record<string, unknown>;
}

export interface SimulatePayload {
  scenario: BookingScenario;
  draft_rules?: Array<{
    target_scope: TargetScope;
    target_id?: string | null;
    applies_when: RulePredicate;
    effect: RuleEffect;
    denial_message?: string | null;
    priority?: number;
    template_id?: string | null;
    template_params?: Record<string, unknown> | null;
    name?: string;
  }>;
}

export interface RuleEvaluation {
  rule_id: string | null;
  rule_name: string;
  effect: string;
  fired: boolean;
  reason: string | null;
  specificity: number | null;
}

export interface SimulationResult {
  rule_evaluations: RuleEvaluation[];
  final_outcome: 'allow' | 'deny' | 'require_approval';
  explain_text: string;
  warnings: string[];
  denial_messages: string[];
}

export interface ImpactPreviewDraftPayload {
  target_scope: TargetScope;
  target_id?: string | null;
  applies_when: RulePredicate;
  effect: RuleEffect;
  priority?: number;
}

export interface ImpactBreakdownRow {
  id: string;
  name: string;
  count: number;
}

export interface ImpactPreviewResult {
  affected_count: number;
  denied_count: number;
  approval_required_count: number;
  warned_count: number;
  sample_affected_bookings: Array<{
    reservation_id: string;
    space_id: string;
    requester_person_id: string;
    start_at: string;
    end_at: string;
    effect: 'deny' | 'require_approval' | 'warn';
  }>;
  breakdown_by_room: ImpactBreakdownRow[];
  breakdown_by_requester: ImpactBreakdownRow[];
  truncated: boolean;
}

export interface SimulationScenario {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  scenario: BookingScenario;
  last_run_at: string | null;
  last_run_result: SimulationResult | null;
  created_at: string;
  created_by: string | null;
}

export interface SaveScenarioPayload {
  name: string;
  description?: string | null;
  scenario: BookingScenario;
}

export interface RuleListFilters {
  target_scope?: TargetScope;
  target_id?: string | null;
  active?: boolean;
  effect?: RuleEffect;
}
