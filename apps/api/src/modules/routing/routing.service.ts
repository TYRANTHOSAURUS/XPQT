import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingEvaluatorService, RoutingHook } from './routing-evaluator.service';
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
    private readonly evaluator: RoutingEvaluatorService,
  ) {}

  /**
   * Evaluate routing for a ticket. The evaluator wraps both the legacy
   * ResolverService and the v2 engines under `routing_v2_mode` — this method
   * transparently dispatches to whichever path the tenant's flag selects.
   *
   * Callers pass `hook` to distinguish the parent-case owner decision from
   * the child-work-order dispatch decision. TicketService (parent create +
   * reassignment) passes `'case_owner'`; DispatchService passes
   * `'child_dispatch'`. Default is `'case_owner'` for historical callers.
   */
  async evaluate(context: ResolverContext, hook: RoutingHook = 'case_owner'): Promise<RoutingEvaluation> {
    const decision =
      hook === 'child_dispatch'
        ? await this.evaluator.evaluateChildDispatch(context)
        : await this.evaluator.evaluateCaseOwner(context);
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
