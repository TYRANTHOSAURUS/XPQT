import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService, RuleRow } from './rule-resolver.service';
import type { BookingScenario, SaveScenarioDto, SimulateDto } from './dto';

/**
 * Two responsibilities:
 *   1. Saved-scenario CRUD (`room_booking_simulation_scenarios`).
 *   2. Dry-run a scenario against the live tenant rules (or a draft set) and
 *      return a per-rule breakdown plus the final outcome.
 *
 * Used by the admin rule editor: "Test against scenario" and "Save scenario."
 */

export interface RuleEvaluation {
  rule_id: string | null; // null for draft rules that haven't been saved yet
  rule_name: string;
  effect: string;
  fired: boolean;
  reason: string | null;
  specificity: number | null;
}

export interface SimulationResult {
  rule_evaluations: RuleEvaluation[];
  final_outcome: 'allow' | 'deny' | 'require_approval';
  explain_text: string;
  warnings: string[];
  denial_messages: string[];
}

@Injectable()
export class SimulationService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: RuleResolverService,
  ) {}

  async run(dto: SimulateDto): Promise<SimulationResult> {
    if (dto.draft_rules && dto.draft_rules.length > 0) {
      // Mix saved + draft rules. We fetch all saved rules for the tenant
      // (active=true) and union with the drafts. The resolver path expects
      // RuleRow shape — synthesize with placeholder ids for drafts.
      const saved = await this.fetchActiveRulesAsRows();
      const drafts: RuleRow[] = dto.draft_rules.map((d, idx) => ({
        id: `draft-${idx}`,
        tenant_id: TenantContext.current().id,
        name: d.name ?? `Draft ${idx + 1}`,
        target_scope: d.target_scope,
        target_id: d.target_id ?? null,
        applies_when: d.applies_when,
        effect: d.effect,
        approval_config: null,
        denial_message: d.denial_message ?? null,
        priority: d.priority ?? 100,
        active: true,
        template_id: d.template_id ?? null,
      }));
      const outcome = await this.resolver.evaluateAdHoc(
        [...saved, ...drafts],
        dto.scenario,
      );
      return this.formatResult(outcome);
    }

    const outcome = await this.resolver.resolve(dto.scenario);
    return this.formatResult(outcome);
  }

  async listScenarios() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_simulation_scenarios')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async createScenario(dto: SaveScenarioDto, actorUserId: string | null) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_simulation_scenarios')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        scenario: dto.scenario,
        created_by: actorUserId,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async runSavedScenario(scenarioId: string): Promise<SimulationResult> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_simulation_scenarios')
      .select('*')
      .eq('id', scenarioId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException(`Scenario ${scenarioId} not found`);

    const result = await this.run({
      scenario: (data as { scenario: BookingScenario }).scenario,
    });

    // Persist the most recent run.
    await this.supabase.admin
      .from('room_booking_simulation_scenarios')
      .update({
        last_run_at: new Date().toISOString(),
        last_run_result: result,
      })
      .eq('id', scenarioId)
      .eq('tenant_id', tenant.id);

    return result;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async fetchActiveRulesAsRows(): Promise<RuleRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true);
    if (error) throw error;
    return (data ?? []) as RuleRow[];
  }

  private formatResult(outcome: Awaited<ReturnType<RuleResolverService['resolve']>>): SimulationResult {
    const rule_evaluations: RuleEvaluation[] = outcome.matchedRules.map((r) => ({
      rule_id: r.id.startsWith('draft-') ? null : r.id,
      rule_name: r.name,
      effect: r.effect,
      fired: true,
      reason: r.denial_message ?? null,
      specificity: r.specificity,
    }));

    let explain: string;
    if (outcome.final === 'deny') {
      explain =
        outcome.denialMessages.length > 0
          ? `Booking would be denied: ${outcome.denialMessages.join(' / ')}`
          : 'Booking would be denied by one or more rules.';
    } else if (outcome.final === 'require_approval') {
      explain = 'Booking would require approval before confirmation.';
    } else if (outcome.warnings.length > 0) {
      explain = `Booking allowed with warnings: ${outcome.warnings.join(' / ')}`;
    } else {
      explain = 'Booking would be allowed with no rule effects.';
    }
    if (outcome.overridable && outcome.final === 'deny') {
      explain += ' Service desk can override with reason.';
    }

    return {
      rule_evaluations,
      final_outcome: outcome.final,
      explain_text: explain,
      warnings: outcome.warnings,
      denial_messages: outcome.denialMessages,
    };
  }
}
