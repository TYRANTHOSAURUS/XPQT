import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface RoutingContext {
  ticket_type_id?: string;
  domain?: string;
  location_id?: string;
  priority?: string;
  [key: string]: unknown;
}

interface RoutingResult {
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  rule_id: string | null;
  rule_name: string | null;
}

@Injectable()
export class RoutingService {
  constructor(private readonly supabase: SupabaseService) {}

  async evaluate(context: RoutingContext): Promise<RoutingResult> {
    const tenant = TenantContext.current();

    // Load active routing rules, ordered by priority (highest first)
    const { data: rules, error } = await this.supabase.admin
      .from('routing_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('priority', { ascending: false });

    if (error) throw error;

    // Evaluate rules in priority order — first match wins
    for (const rule of rules ?? []) {
      if (this.matchesConditions(rule.conditions as Array<{ field: string; operator: string; value: unknown }>, context)) {
        return {
          assigned_team_id: rule.action_assign_team_id,
          assigned_user_id: rule.action_assign_user_id,
          rule_id: rule.id,
          rule_name: rule.name,
        };
      }
    }

    // No rule matched
    return { assigned_team_id: null, assigned_user_id: null, rule_id: null, rule_name: null };
  }

  private matchesConditions(
    conditions: Array<{ field: string; operator: string; value: unknown }>,
    context: RoutingContext,
  ): boolean {
    if (!conditions || conditions.length === 0) return true;

    return conditions.every((condition) => {
      const actual = context[condition.field];
      switch (condition.operator) {
        case 'equals':
          return actual === condition.value;
        case 'not_equals':
          return actual !== condition.value;
        case 'in':
          return Array.isArray(condition.value) && condition.value.includes(actual);
        case 'not_in':
          return Array.isArray(condition.value) && !condition.value.includes(actual);
        case 'exists':
          return actual !== null && actual !== undefined;
        default:
          return false;
      }
    });
  }
}
