import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ResolverService } from './resolver.service';
import { RoutingEvaluatorService, RoutingHook } from './routing-evaluator.service';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  ResolverContext,
  TraceEntry,
} from './resolver.types';

export interface SimulatorInput {
  request_type_id: string;
  location_id?: string | null;             // LEGACY: pre-portal-scope. Maps to acting_for_location_id.
  asset_id?: string | null;
  priority?: string | null;
  disabled_rule_ids?: string[];
  /** When true, also run the v2 engines (both hooks) and return in .v2 */
  include_v2?: boolean;

  // Portal-scope extension (docs/portal-scope-slice.md §5.6).
  /** When set, evaluate portal availability for this person as a prefix to routing. */
  simulate_as_person_id?: string | null;
  /** Where the requester is. Recorded in the trace for "Ali at Amsterdam raising for Dubai" diagnosis. */
  current_location_id?: string | null;
  /** Where the request is for (drives routing). Falls back to legacy `location_id` when both are unset. */
  acting_for_location_id?: string | null;
}

export interface PortalAvailabilityTraceView {
  authorized: boolean;
  has_any_scope: boolean;
  effective_location_id: string | null;
  matched_root_id: string | null;
  matched_root_source: 'default' | 'grant' | null;
  grant_id: string | null;
  visible: boolean;
  location_required: boolean;
  granularity: string | null;
  granularity_ok: boolean;
  overall_valid: boolean;
  failure_reason: string | null;
}

export interface PortalAvailabilityView {
  person_id: string;
  current_location_id: string | null;
  acting_for_location_id: string | null;
  trace: PortalAvailabilityTraceView;
  authorized_locations_summary: Array<{
    id: string;
    name: string;
    type: string;
    source: 'default' | 'grant';
    grant_id: string | null;
  }>;
}

interface DecisionView {
  chosen_by: ChosenBy;
  strategy: FulfillmentShape | 'rule';
  rule_id: string | null;
  rule_name: string | null;
  target_kind: 'team' | 'user' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
}

interface V2DecisionView {
  hook: RoutingHook;
  chosen_by: ChosenBy | null;
  target_kind: 'team' | 'user' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
  trace: TraceEntry[];
  error: string | null;
  matches_legacy_target: boolean;
}

export interface SimulatorResult {
  decision: DecisionView;
  effects: {
    sla_policy_id: string | null;
    sla_policy_name: string | null;
    workflow_definition_id: string | null;
    workflow_definition_name: string | null;
    fulfillment_strategy: FulfillmentShape;
    domain: string | null;
  };
  trace: TraceEntry[];
  /**
   * v2 engine preview — runs regardless of routing_v2_mode. `null` means the
   * simulator was not asked to preview v2 (default). When present, both hooks
   * ('case_owner' and 'child_dispatch') are evaluated so admins can see both
   * divergences in a single pane.
   */
  v2: V2DecisionView[] | null;
  context_snapshot: {
    tenant_id: string;
    request_type_id: string;
    domain: string | null;
    priority: string;
    location_id: string | null;
    asset_id: string | null;
    excluded_rule_ids: string[];
  };
  /**
   * Portal availability trace — present only when simulate_as_person_id is supplied.
   * Uses the same portal_availability_trace() RPC as POST /portal/tickets validation,
   * guaranteeing the simulator and the submit path see identical availability logic.
   */
  portal_availability?: PortalAvailabilityView;
  duration_ms: number;
}

/**
 * Admin-only dry-run of the resolver. Reuses ResolverService without persisting anything:
 * no routing_decisions row, no SLA timer, no ticket insert.
 *
 * Performance note: each simulate run issues the same DB queries a real ticket creation
 * would (~5-50 queries depending on location chain depth and domain chain length). The
 * endpoint is admin-only and the UI debounces; if this ever becomes a hot path we can
 * add a per-user token bucket in this service. For now we log duration so we can tell.
 */
@Injectable()
export class RoutingSimulatorService {
  private readonly logger = new Logger(RoutingSimulatorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ResolverService,
    private readonly evaluator: RoutingEvaluatorService,
  ) {}

  async simulate(input: SimulatorInput): Promise<SimulatorResult> {
    const started = Date.now();
    const tenant = TenantContext.current();

    const requestType = await this.loadRequestTypeMeta(input.request_type_id, tenant.id);
    if (!requestType) throw new NotFoundException('Request type not found');

    // Portal-scope: acting_for_location drives routing; current_location is diagnostic.
    // Fallback order when acting_for is unset: legacy `location_id` → `current_location_id`.
    // The current-location-only case lets admins answer "what would Ali get if they
    // raised this from Amsterdam HQ without drilling deeper?" without repeating inputs.
    let actingForLocation: string | null;
    if (input.acting_for_location_id !== undefined && input.acting_for_location_id !== null) {
      actingForLocation = input.acting_for_location_id;
    } else if (input.location_id !== undefined && input.location_id !== null) {
      actingForLocation = input.location_id;
    } else {
      actingForLocation = input.current_location_id ?? null;
    }

    const context: ResolverContext = {
      tenant_id: tenant.id,
      ticket_id: 'simulation',
      request_type_id: input.request_type_id,
      domain: requestType.domain,
      priority: input.priority ?? 'normal',
      asset_id: input.asset_id ?? null,
      location_id: actingForLocation,
      excluded_rule_ids: input.disabled_rule_ids,
    };

    const decision = await this.resolver.resolve(context);
    const targetName = await this.resolveTargetName(decision.target);

    const v2 = input.include_v2 ? await this.runV2Preview(context, decision.target) : null;

    const portal_availability = input.simulate_as_person_id
      ? await this.evaluatePortalAvailability(
          input.simulate_as_person_id,
          input.current_location_id ?? null,
          actingForLocation,
          input.request_type_id,
          tenant.id,
        )
      : undefined;

    const duration_ms = Date.now() - started;

    this.logger.log(
      `simulate tenant=${tenant.id} rt=${input.request_type_id} ` +
        `chosen_by=${decision.chosen_by} duration=${duration_ms}ms include_v2=${Boolean(input.include_v2)}`,
    );

    return {
      decision: {
        chosen_by: decision.chosen_by,
        strategy: decision.strategy,
        rule_id: decision.rule_id ?? null,
        rule_name: decision.rule_name ?? null,
        target_kind: decision.target?.kind ?? null,
        target_id: targetKindId(decision.target),
        target_name: targetName,
      },
      effects: {
        sla_policy_id: requestType.sla_policy_id,
        sla_policy_name: requestType.sla_policy_name,
        workflow_definition_id: requestType.workflow_definition_id,
        workflow_definition_name: requestType.workflow_definition_name,
        fulfillment_strategy: requestType.fulfillment_strategy,
        domain: requestType.domain,
      },
      trace: decision.trace,
      v2,
      context_snapshot: {
        tenant_id: tenant.id,
        request_type_id: input.request_type_id,
        domain: requestType.domain,
        priority: context.priority ?? 'normal',
        location_id: actingForLocation,
        asset_id: input.asset_id ?? null,
        excluded_rule_ids: input.disabled_rule_ids ?? [],
      },
      portal_availability,
      duration_ms,
    };
  }

  private async evaluatePortalAvailability(
    personId: string,
    currentLocationId: string | null,
    actingForLocationId: string | null,
    requestTypeId: string,
    tenantId: string,
  ): Promise<PortalAvailabilityView> {
    // Uses the same RPC that POST /portal/tickets validation calls — single source of truth.
    const { data: traceData, error: traceError } = await this.supabase.admin.rpc(
      'portal_availability_trace',
      {
        p_person_id: personId,
        p_effective_space_id: actingForLocationId,
        p_request_type_id: requestTypeId,
        p_tenant_id: tenantId,
      },
    );
    if (traceError) throw traceError;
    const trace = traceData as unknown as PortalAvailabilityTraceView;

    // Load the authorized-roots summary so admin can see what IS available when auth fails.
    const { data: rootRows } = await this.supabase.admin.rpc('portal_authorized_root_matches', {
      p_person_id: personId,
      p_tenant_id: tenantId,
    });
    const rows =
      ((rootRows ?? []) as Array<{ root_id: string; source: 'default' | 'grant'; grant_id: string | null }>) ?? [];

    let authorized_locations_summary: PortalAvailabilityView['authorized_locations_summary'] = [];
    if (rows.length > 0) {
      const ids = rows.map((r) => r.root_id);
      const { data: spaceRows } = await this.supabase.admin
        .from('spaces')
        .select('id, name, type')
        .in('id', ids)
        .eq('tenant_id', tenantId);
      const spaceMap = new Map(
        ((spaceRows ?? []) as Array<{ id: string; name: string; type: string }>).map((s) => [s.id, s]),
      );
      authorized_locations_summary = rows
        .map((r) => {
          const s = spaceMap.get(r.root_id);
          if (!s) return null;
          return { id: s.id, name: s.name, type: s.type, source: r.source, grant_id: r.grant_id };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    }

    return {
      person_id: personId,
      current_location_id: currentLocationId,
      acting_for_location_id: actingForLocationId,
      trace,
      authorized_locations_summary,
    };
  }

  private async runV2Preview(
    context: ResolverContext,
    legacyTarget: AssignmentTarget | null,
  ): Promise<V2DecisionView[]> {
    const hooks: RoutingHook[] = ['case_owner', 'child_dispatch'];
    const results: V2DecisionView[] = [];
    for (const hook of hooks) {
      const { decision, error } = await this.evaluator.simulateV2(hook, context);
      const target = decision?.target ?? null;
      const name = await this.resolveTargetName(target);
      results.push({
        hook,
        chosen_by: decision?.chosen_by ?? null,
        target_kind: target?.kind ?? null,
        target_id: targetKindId(target),
        target_name: name,
        trace: decision?.trace ?? [],
        error,
        matches_legacy_target: targetsEqual(target, legacyTarget),
      });
    }
    return results;
  }

  private async loadRequestTypeMeta(requestTypeId: string, tenantId: string) {
    // Single query joining sla_policies + workflow_definitions so we avoid N+1 for labels.
    const { data, error } = await this.supabase.admin
      .from('request_types')
      .select(`
        id,
        domain,
        fulfillment_strategy,
        sla_policy_id,
        workflow_definition_id,
        sla_policies:sla_policy_id(name),
        workflow_definitions:workflow_definition_id(name)
      `)
      .eq('id', requestTypeId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const raw = data as Record<string, unknown>;
    const sla = Array.isArray(raw.sla_policies) ? raw.sla_policies[0] : raw.sla_policies;
    const wf = Array.isArray(raw.workflow_definitions)
      ? raw.workflow_definitions[0]
      : raw.workflow_definitions;

    return {
      id: raw.id as string,
      domain: (raw.domain as string | null) ?? null,
      fulfillment_strategy: (raw.fulfillment_strategy as FulfillmentShape) ?? 'fixed',
      sla_policy_id: (raw.sla_policy_id as string | null) ?? null,
      sla_policy_name: (sla as { name?: string } | null)?.name ?? null,
      workflow_definition_id: (raw.workflow_definition_id as string | null) ?? null,
      workflow_definition_name: (wf as { name?: string } | null)?.name ?? null,
    };
  }

  private async resolveTargetName(target: AssignmentTarget | null): Promise<string | null> {
    if (!target) return null;
    if (target.kind === 'team') {
      const { data } = await this.supabase.admin
        .from('teams')
        .select('name')
        .eq('id', target.team_id)
        .maybeSingle();
      return (data as { name?: string } | null)?.name ?? null;
    }
    if (target.kind === 'vendor') {
      const { data } = await this.supabase.admin
        .from('vendors')
        .select('name')
        .eq('id', target.vendor_id)
        .maybeSingle();
      return (data as { name?: string } | null)?.name ?? null;
    }
    // user — fall back to email since display_name lives on persons
    const { data } = await this.supabase.admin
      .from('users')
      .select('email')
      .eq('id', target.user_id)
      .maybeSingle();
    return (data as { email?: string } | null)?.email ?? null;
  }
}

function targetKindId(target: AssignmentTarget | null): string | null {
  if (!target) return null;
  if (target.kind === 'team') return target.team_id;
  if (target.kind === 'vendor') return target.vendor_id;
  return target.user_id;
}

function targetsEqual(a: AssignmentTarget | null, b: AssignmentTarget | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'team' && b.kind === 'team') return a.team_id === b.team_id;
  if (a.kind === 'user' && b.kind === 'user') return a.user_id === b.user_id;
  if (a.kind === 'vendor' && b.kind === 'vendor') return a.vendor_id === b.vendor_id;
  return false;
}
