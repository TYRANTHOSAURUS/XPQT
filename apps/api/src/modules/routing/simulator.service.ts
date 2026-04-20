import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ResolverService } from './resolver.service';
import {
  AssignmentTarget,
  ChosenBy,
  FulfillmentShape,
  ResolverContext,
  TraceEntry,
} from './resolver.types';

export interface SimulatorInput {
  request_type_id: string;
  location_id?: string | null;
  asset_id?: string | null;
  priority?: string | null;
  disabled_rule_ids?: string[];
}

export interface SimulatorResult {
  decision: {
    chosen_by: ChosenBy;
    strategy: FulfillmentShape | 'rule';
    rule_id: string | null;
    rule_name: string | null;
    target_kind: 'team' | 'user' | 'vendor' | null;
    target_id: string | null;
    target_name: string | null;
  };
  effects: {
    sla_policy_id: string | null;
    sla_policy_name: string | null;
    workflow_definition_id: string | null;
    workflow_definition_name: string | null;
    fulfillment_strategy: FulfillmentShape;
    domain: string | null;
  };
  trace: TraceEntry[];
  context_snapshot: {
    tenant_id: string;
    request_type_id: string;
    domain: string | null;
    priority: string;
    location_id: string | null;
    asset_id: string | null;
    excluded_rule_ids: string[];
  };
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
  ) {}

  async simulate(input: SimulatorInput): Promise<SimulatorResult> {
    const started = Date.now();
    const tenant = TenantContext.current();

    const requestType = await this.loadRequestTypeMeta(input.request_type_id, tenant.id);
    if (!requestType) throw new NotFoundException('Request type not found');

    const context: ResolverContext = {
      tenant_id: tenant.id,
      ticket_id: 'simulation',
      request_type_id: input.request_type_id,
      domain: requestType.domain,
      priority: input.priority ?? 'normal',
      asset_id: input.asset_id ?? null,
      location_id: input.location_id ?? null,
      excluded_rule_ids: input.disabled_rule_ids,
    };

    const decision = await this.resolver.resolve(context);
    const targetName = await this.resolveTargetName(decision.target);
    const duration_ms = Date.now() - started;

    this.logger.log(
      `simulate tenant=${tenant.id} rt=${input.request_type_id} ` +
        `chosen_by=${decision.chosen_by} duration=${duration_ms}ms`,
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
      context_snapshot: {
        tenant_id: tenant.id,
        request_type_id: input.request_type_id,
        domain: requestType.domain,
        priority: context.priority ?? 'normal',
        location_id: input.location_id ?? null,
        asset_id: input.asset_id ?? null,
        excluded_rule_ids: input.disabled_rule_ids ?? [],
      },
      duration_ms,
    };
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
