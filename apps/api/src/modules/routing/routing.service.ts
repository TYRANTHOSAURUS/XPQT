import { Injectable } from '@nestjs/common';
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

export interface RoutingEvaluation {
  target: AssignmentTarget | null;
  chosen_by: ChosenBy;
  rule_id: string | null;
  rule_name: string | null;
  strategy: FulfillmentShape | 'rule';
  trace: TraceEntry[];
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ResolverService,
  ) {}

  async evaluate(context: ResolverContext): Promise<RoutingEvaluation> {
    const tenant = TenantContext.current();

    const { data: rules, error } = await this.supabase.admin
      .from('routing_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('priority', { ascending: false });

    if (error) throw error;

    const ruleContext: Record<string, unknown> = {
      ticket_type_id: context.request_type_id,
      domain: context.domain,
      location_id: context.location_id,
      priority: context.priority,
      asset_id: context.asset_id,
    };

    for (const rule of rules ?? []) {
      if (this.matchesConditions(rule.conditions, ruleContext)) {
        const target: AssignmentTarget | null = rule.action_assign_team_id
          ? { kind: 'team', team_id: rule.action_assign_team_id }
          : rule.action_assign_user_id
          ? { kind: 'user', user_id: rule.action_assign_user_id }
          : null;
        return {
          target,
          chosen_by: 'rule',
          rule_id: rule.id,
          rule_name: rule.name,
          strategy: 'rule',
          trace: [{ step: 'rule', matched: true, reason: `rule ${rule.name}`, target }],
        };
      }
    }

    const decision = await this.resolver.resolve(context);
    return {
      target: decision.target,
      chosen_by: decision.chosen_by,
      rule_id: null,
      rule_name: null,
      strategy: decision.strategy,
      trace: decision.trace,
    };
  }

  async recordDecision(ticketId: string, context: ResolverContext, evaluation: RoutingEvaluation) {
    const tenant = TenantContext.current();
    await this.supabase.admin.from('routing_decisions').insert({
      tenant_id: tenant.id,
      ticket_id: ticketId,
      strategy: evaluation.strategy,
      chosen_team_id: evaluation.target?.kind === 'team' ? evaluation.target.team_id : null,
      chosen_user_id: evaluation.target?.kind === 'user' ? evaluation.target.user_id : null,
      chosen_vendor_id: evaluation.target?.kind === 'vendor' ? evaluation.target.vendor_id : null,
      chosen_by: evaluation.chosen_by,
      rule_id: evaluation.rule_id,
      trace: evaluation.trace,
      context: {
        request_type_id: context.request_type_id,
        domain: context.domain,
        priority: context.priority,
        asset_id: context.asset_id,
        location_id: context.location_id,
      },
    });
  }

  private matchesConditions(
    conditions: Array<{ field: string; operator: string; value: unknown }>,
    context: Record<string, unknown>,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;
    return conditions.every((c) => {
      const actual = context[c.field];
      switch (c.operator) {
        case 'equals':
          return actual === c.value;
        case 'not_equals':
          return actual !== c.value;
        case 'in':
          return Array.isArray(c.value) && c.value.includes(actual);
        case 'not_in':
          return Array.isArray(c.value) && !c.value.includes(actual);
        case 'exists':
          return actual !== null && actual !== undefined;
        default:
          return false;
      }
    });
  }
}
