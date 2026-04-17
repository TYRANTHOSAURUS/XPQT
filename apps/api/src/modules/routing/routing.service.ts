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
    const decision = await this.resolver.resolve(context);
    return {
      target: decision.target,
      chosen_by: decision.chosen_by,
      rule_id: decision.rule_id ?? null,
      rule_name: decision.rule_name ?? null,
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
}
