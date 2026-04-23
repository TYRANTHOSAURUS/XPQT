import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Effective request_type_scope_override for a (tenant, request_type, selected_space)
 * tuple, resolved with live-doc §6.3 precedence:
 *
 *   exact_space → ancestor_space (inherit) → space_group → tenant
 *
 * Returns null when no override applies. The row is then consumed by four
 * call sites:
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

@Injectable()
export class ScopeOverrideResolverService {
  constructor(private readonly supabase: SupabaseService) {}

  async resolve(
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
}
