export type FulfillmentShape = 'asset' | 'location' | 'fixed' | 'auto';

export type AssignmentTarget =
  | { kind: 'team'; team_id: string }
  | { kind: 'user'; user_id: string }
  | { kind: 'vendor'; vendor_id: string };

export type ChosenBy =
  | 'rule'
  | 'asset_override'
  | 'asset_type_default'
  | 'location_team'
  | 'parent_location_team'
  | 'space_group_team'
  | 'domain_fallback'
  | 'request_type_default'
  // Routing v2 values (Artifact A.4). Stored in routing_decisions.chosen_by
  // (text column, no check constraint) once the v2 engine serves traffic.
  | 'policy_row'
  | 'policy_default'
  | 'unassigned';

export interface ResolverContext {
  tenant_id: string;
  ticket_id: string;
  request_type_id: string | null;
  domain: string | null;
  priority: string | null;
  asset_id: string | null;
  location_id: string | null;
  /** Rule ids to skip during the pre-step. Used by the simulator's "disable rule" affordance. */
  excluded_rule_ids?: string[];
  loaded?: {
    request_type?: LoadedRequestType | null;
    asset?: LoadedAsset | null;
    location_chain?: string[];
    domain_chain?: string[];
  };
}

export interface LoadedRequestType {
  id: string;
  domain: string | null;
  fulfillment_strategy: FulfillmentShape;
  default_team_id: string | null;
  default_vendor_id: string | null;
  asset_type_filter: string[];
}

export interface LoadedAsset {
  id: string;
  asset_type_id: string;
  assigned_space_id: string | null;
  override_team_id: string | null;
  override_vendor_id: string | null;
  type: {
    id: string;
    default_team_id: string | null;
    default_vendor_id: string | null;
  };
}

export interface RoutingRuleRecord {
  id: string;
  name: string;
  priority: number;
  conditions: Array<{ field: string; operator: string; value: unknown }>;
  action_assign_team_id: string | null;
  action_assign_user_id: string | null;
}

export interface LocationTeamHit {
  team_id: string | null;
  vendor_id: string | null;
}

export interface TraceEntry {
  step: ChosenBy;
  matched: boolean;
  reason: string;
  target: AssignmentTarget | null;
}

export interface ResolverDecision {
  target: AssignmentTarget | null;
  chosen_by: ChosenBy;
  strategy: FulfillmentShape | 'rule';
  rule_id?: string | null;
  rule_name?: string | null;
  trace: TraceEntry[];
}
