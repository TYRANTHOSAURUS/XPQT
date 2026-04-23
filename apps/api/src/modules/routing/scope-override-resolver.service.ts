import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Effective request_type_scope_override for a (tenant, request_type, intake)
 * triple, resolved with live-doc §6.3 precedence:
 *
 *   exact_space → ancestor_space (inherit) → space_group → tenant
 *
 * Returns null when no override applies. The row is then consumed by four
 * call sites — see docs/assignments-routing-fulfillment.md §24:
 *
 *   - ResolverService: handler_kind (team/vendor/none) replaces the normal
 *     routing chain. 'none' is an explicit unassignment and is terminal.
 *   - TicketService.runPostCreateAutomation: workflow_definition_id +
 *     case_sla_policy_id replace request_types.workflow_definition_id /
 *     sla_policy_id at case creation.
 *   - DispatchService.resolveChildSla: executor_sla_policy_id slots in
 *     between explicit DTO sla_id and vendor/team defaults.
 *   - RoutingEvaluatorService v2 hooks: case_owner_policy_entity_id /
 *     child_dispatch_policy_entity_id replace the request-type-level policy
 *     entity ids.
 *
 * handler_kind null means "override non-handler fields only" — callers consume
 * workflow/SLA/policy ids but leave the resolver chain alone for routing.
 *
 * Effective-location derivation is centralized here so every consumer sees
 * the same rule: explicit location_id when set, else the asset's
 * assigned_space_id, else null. Direct callers never compute this themselves.
 */
export interface EffectiveScopeOverride {
  id: string;
  scope_kind: 'tenant' | 'space' | 'space_group';
  space_id: string | null;
  space_group_id: string | null;
  inherit_to_descendants: boolean;
  starts_at: string | null;
  ends_at: string | null;
  handler_kind: 'team' | 'vendor' | 'none' | null;
  handler_team_id: string | null;
  handler_vendor_id: string | null;
  workflow_definition_id: string | null;
  case_sla_policy_id: string | null;
  case_owner_policy_entity_id: string | null;
  child_dispatch_policy_entity_id: string | null;
  executor_sla_policy_id: string | null;
  precedence: 'exact_space' | 'ancestor_space' | 'space_group' | 'tenant';
}

/**
 * Intake shape the four consumers pass in. `locationId` is the explicit
 * user-picked / row-provided space; `assetId` is the asset attached to the
 * ticket. The service derives effective location with the same fallback rule
 * as portal submit: explicit location wins, asset's assigned space is the
 * fallback, and null means "no location — only tenant-scope overrides apply".
 */
export interface ScopeOverrideIntake {
  locationId: string | null;
  assetId: string | null;
}

@Injectable()
export class ScopeOverrideResolverService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Resolve the effective override for a request_type at the given intake.
   * Computes effective location (explicit → asset → null), then queries the
   * shared precedence function.
   */
  async resolve(
    tenantId: string,
    requestTypeId: string,
    intake: ScopeOverrideIntake,
  ): Promise<EffectiveScopeOverride | null> {
    const effectiveLocation = await this.deriveEffectiveLocation(tenantId, intake);
    return this.resolveForLocation(tenantId, requestTypeId, effectiveLocation);
  }

  /**
   * Same as resolve(), but takes a pre-computed space id. Used by callers
   * that already have the effective location in hand (e.g. the portal trace
   * RPC resolves it server-side) and want to avoid the asset round trip.
   * Most callers should prefer resolve() so effective-location logic lives
   * in exactly one place.
   */
  async resolveForLocation(
    tenantId: string,
    requestTypeId: string,
    selectedSpaceId: string | null,
  ): Promise<EffectiveScopeOverride | null> {
    const { data, error } = await this.supabase.admin.rpc(
      'request_type_effective_scope_override',
      {
        p_tenant_id: tenantId,
        p_request_type_id: requestTypeId,
        p_selected_space_id: selectedSpaceId,
      },
    );
    if (error) throw error;
    if (!data) return null;
    return data as EffectiveScopeOverride;
  }

  /**
   * Effective-location = explicit location → asset.assigned_space_id → null.
   * Keeps the fallback logic in one place so the resolver, ticket, dispatch,
   * and v2 evaluator consumers all see the same effective location for the
   * same (location_id, asset_id) intake.
   */
  async deriveEffectiveLocation(
    tenantId: string,
    { locationId, assetId }: ScopeOverrideIntake,
  ): Promise<string | null> {
    if (locationId) return locationId;
    if (!assetId) return null;
    const { data, error } = await this.supabase.admin
      .from('assets')
      .select('assigned_space_id')
      .eq('id', assetId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) return null;
    return ((data as { assigned_space_id: string | null } | null)?.assigned_space_id) ?? null;
  }
}
