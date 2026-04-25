/**
 * Plain TS DTOs for the room-booking-rules module. We use class-validator
 * elsewhere in the project but this module follows the lighter pattern used
 * by config-engine — runtime validation lives in the service, types here are
 * just for shape documentation. See criteria-set.service.ts for the canonical
 * pattern.
 */

export type RuleEffect = 'deny' | 'require_approval' | 'allow_override' | 'warn';
export type TargetScope = 'room' | 'room_type' | 'space_subtree' | 'tenant';
export type ChangeType = 'create' | 'update' | 'enable' | 'disable' | 'delete';

/**
 * The applies_when predicate. Composite + leaf nodes; see predicate-engine.service.ts
 * for the full grammar.
 */
export type Predicate =
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  | { fn: string; args: unknown[] }
  | { op: 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; left: unknown; right?: unknown };

export interface ApprovalConfig {
  required_approvers?: Array<{ type: 'team' | 'person'; id: string }>;
  threshold?: 'all' | 'any';
}

export interface CreateRuleDto {
  name: string;
  description?: string | null;
  target_scope: TargetScope;
  target_id?: string | null;
  applies_when: Predicate;
  effect: RuleEffect;
  approval_config?: ApprovalConfig | null;
  denial_message?: string | null;
  priority?: number;
  template_id?: string | null;
  template_params?: Record<string, unknown> | null;
  active?: boolean;
}

export type UpdateRuleDto = Partial<CreateRuleDto>;

export interface FromTemplateDto {
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
  start_at: string; // ISO
  end_at: string; // ISO
  attendee_count?: number | null;
  criteria?: Record<string, unknown>;
}

export interface SimulateDto {
  scenario: BookingScenario;
  draft_rules?: Array<{
    target_scope: TargetScope;
    target_id?: string | null;
    applies_when: Predicate;
    effect: RuleEffect;
    denial_message?: string | null;
    priority?: number;
    template_id?: string | null;
    template_params?: Record<string, unknown> | null;
    name?: string;
  }>;
}

export interface ImpactPreviewDraftDto {
  target_scope: TargetScope;
  target_id?: string | null;
  applies_when: Predicate;
  effect: RuleEffect;
  priority?: number;
}

export interface SaveScenarioDto {
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
