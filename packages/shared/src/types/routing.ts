// Workstream 0 contracts for the Routing Studio redesign.
// Source of truth for types shared between apps/api and apps/web.
// See docs/routing-studio-improvement-plan-2026-04-21.md §"Workstream 0 Artifacts".

// ─── Primitives ──────────────────────────────────────────────────────────────
// AssignmentTarget/TraceEntry also live in apps/api/src/modules/routing/resolver.types.ts
// for the legacy resolver. Shapes are kept compatible so a future consolidation is
// a move, not a rewrite.

export type AssignmentTarget =
  | { kind: 'team'; team_id: string }
  | { kind: 'user'; user_id: string }
  | { kind: 'vendor'; vendor_id: string };

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export type ScopeSource =
  | 'requester_home'
  | 'selected'
  | 'asset_location'
  | 'business_unit'
  | 'legal_entity'
  | 'manual';

export type ChosenBy =
  | 'policy_row'
  | 'policy_default'
  | 'asset_override'
  | 'asset_type_default'
  | 'location_team'
  | 'parent_location_team'
  | 'space_group_team'
  | 'domain_fallback'
  | 'rule'
  | 'unassigned';

export interface TraceEntry {
  step: ChosenBy;
  matched: boolean;
  reason: string;
  target: AssignmentTarget | null;
}

// ─── Contract 1. Intake scoping ──────────────────────────────────────────────

export interface IntakeContext {
  tenant_id: string;
  request_type_id: string;
  requester_person_id: string | null;
  selected_location_id: string | null;
  asset_id: string | null;
  priority: Priority;
  evaluated_at: string; // ISO8601
}

export interface NormalizedRoutingContext {
  tenant_id: string;
  request_type_id: string;
  /**
   * Domain registry id (see Artifact D). Nullable during dual-run: a tenant
   * that hasn't backfilled the `domains` table yet will surface null here
   * and engines must fall back to operational-scope-only matching. After
   * Artifact D step 9 cutover this becomes non-null in practice.
   */
  domain_id: string | null;
  priority: Priority;
  location_id: string | null;
  asset_id: string | null;
  scope_source: ScopeSource;
  operational_scope_id: string | null;
  operational_scope_chain: string[]; // [self, parent, …] up to root
  evaluated_at: string;
  active_support_window_id: string | null;
}

// ─── Contract 2. Case ownership ──────────────────────────────────────────────

export interface CaseOwnerPolicyDefinition {
  schema_version: 1;
  request_type_id: string;
  scope_source: ScopeSource;
  rows: Array<{
    id: string; // stable UUID for trace
    match: {
      operational_scope_ids?: string[]; // any-of
      domain_ids?: string[]; // any-of (usually 1)
      support_window_id?: string | null; // 'business_hours' | 'after_hours' | …
    };
    target: { kind: 'team'; team_id: string };
    ordering_hint: number; // most-specific first
  }>;
  default_target: { kind: 'team'; team_id: string };
}

export interface OwnerDecision {
  target: AssignmentTarget;
  matched_row_id: string | 'default';
  trace: TraceEntry[];
  evaluated_at: string;
}

// ─── Contract 3. Split / orchestration ───────────────────────────────────────

export type DispatchMode = 'none' | 'optional' | 'always' | 'multi_template';
export type SplitStrategy = 'single' | 'per_location' | 'per_asset' | 'per_vendor_service';
export type ExecutionRoutingKind =
  | 'fixed'
  | 'by_asset'
  | 'by_location'
  | 'by_asset_then_location'
  | 'workflow';

export interface ChildDispatchPolicyDefinition {
  schema_version: 1;
  request_type_id: string;
  dispatch_mode: DispatchMode;
  split_strategy: SplitStrategy;
  execution_routing: ExecutionRoutingKind;
  fixed_target?: { kind: 'team' | 'vendor'; id: string };
  fallback_target?: { kind: 'team' | 'vendor'; id: string };
}

// Emitted in-memory; NOT persisted. Split audit lives in ticket_activities on the
// parent case (system_event: 'children_planned', { plan_ids, scopes }).
export interface ChildPlan {
  plan_id: string;
  derived_scope:
    | { kind: 'location'; location_id: string }
    | { kind: 'asset'; asset_id: string }
    | { kind: 'vendor_service'; vendor_id: string; service_area_id: string | null };
  title_hint: string;
  execution_context: NormalizedRoutingContext;
  visibility_hints: VisibilityHints;
}

// ─── Contract 4. Assignment resolver ─────────────────────────────────────────

export type RoutingPolicy =
  | { kind: 'case_owner'; policy: CaseOwnerPolicyDefinition }
  | { kind: 'child_dispatch'; policy: ChildDispatchPolicyDefinition };

export interface ResolverInput {
  context: NormalizedRoutingContext;
  policy: RoutingPolicy;
  time_window?: { calendar_id: string; is_business_hours: boolean };
}

export interface ResolverOutput {
  target: AssignmentTarget | null;
  chosen_by: ChosenBy;
  matched_row_id?: string;
  trace: TraceEntry[];
  evaluated_at: string;
  active_time_window_id?: string;
}

// ─── Contract 5. Visibility integration ──────────────────────────────────────
// Routing-owned visibility flags only. Actual checks still go through
// public.ticket_visibility_ids() + TicketVisibilityService.

export interface VisibilityHints {
  parent_owner_sees_children: boolean; // default true
  vendor_children_visibility: 'vendor_only' | 'vendor_and_parent_owner';
  cross_location_overlays: string[]; // role_ids that get overlay visibility
}

// ─── Contract 6. Config storage ──────────────────────────────────────────────
// Policies live on config_entities + config_versions — no new policy table.
// New config_type values: 'case_owner_policy' | 'child_dispatch_policy'
//                       | 'domain_registry'   | 'space_levels'
// The canonical union type is `RoutingStudioConfigType` in ./validators/routing.ts —
// it is derived from the schema dispatch map and cannot drift.

// ─── Contract 7. Studio API (Simulator + Map) ────────────────────────────────

export interface SimulateRequest extends IntakeContext {
  simulate_as: 'parent_case' | 'child_work_order';
  override_time?: string; // simulate at this ISO timestamp
  disabled_override_ids?: string[]; // existing "disable a rule" UX
}

export interface SimulateWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface SimulateResponse {
  intake: NormalizedRoutingContext;
  owner_decision: OwnerDecision;
  split_decision: { plans: ChildPlan[] };
  child_execution_decisions: Array<{ plan_id: string; resolver_output: ResolverOutput }>;
  visibility_explanation: string[];
  warnings: SimulateWarning[];
  duration_ms: number;
}

export type MapScopeLevel = 'country' | 'campus' | 'building' | 'location_group';

export interface MapQuery {
  scope_level?: MapScopeLevel;
  scope_root_id?: string;
  domain_ids?: string[];
}

export interface MapCell {
  scope_id: string;
  domain_id: string;
  owner_summary: {
    target_name: string | null;
    source: 'direct' | 'inherited' | 'default';
  };
  dispatch_summary: {
    mode: DispatchMode;
    split: SplitStrategy;
    target_name: string | null;
  };
  warnings: string[];
}

export interface MapResponse {
  scopes: Array<{
    id: string;
    name: string;
    level: string;
    path: string[];
    depth: number;
  }>;
  domains: Array<{ id: string; key: string; display_name: string }>;
  cells: MapCell[];
  truncated: boolean;
}

// ─── Artifact B. Space levels config ─────────────────────────────────────────
// Stored on config_versions.definition for config_type = 'space_levels'.
// One entity per tenant. Drives which depths in the spaces tree are eligible
// as operational-scope rows in the Routing Map.

export interface SpaceLevelsDefinition {
  schema_version: 1;
  levels: Array<{
    depth: number; // 0 = root
    key: string; // 'country' | 'campus' | 'building' | 'floor' | 'room' | custom
    display_name: string;
    is_operational_scope: boolean;
  }>;
}

// ─── Artifact E. Dual-run feature flag ───────────────────────────────────────
// Stored on tenants.feature_flags.routing_v2_mode. Missing key = 'off'.

export type RoutingV2Mode = 'off' | 'dualrun' | 'shadow' | 'v2_only';

export interface RoutingDualRunDiff {
  tenant_id: string;
  hook: 'case_owner' | 'child_dispatch';
  mode: RoutingV2Mode;
  legacy_chosen_by: string | null;
  v2_chosen_by: ChosenBy | null;
  target_match: boolean;
  chosen_by_match: boolean;
}
