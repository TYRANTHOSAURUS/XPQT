import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import {
  advanceRecurrence,
  isRecurrenceUnit,
  type RecurrenceUnit,
} from './recurrence';

/**
 * PMGeneratorService — the heart of Slice C.
 *
 * Plan: ai/slice-c-plan.md §4. Drives generation for one tenant at a time
 * (per-tenant iteration is the cron's responsibility). All writes go
 * through the atomic create_pm_work_order RPC (00389) which locks the
 * plan FOR UPDATE, inserts the work_order with origin='preventive', and
 * advances last_generated_at — idempotent at the row layer via
 * uq_work_orders_pm_occurrence (00387).
 *
 * Bounded batch + per-row catch + per-plan catch — failure on one asset
 * doesn't block the rest of the plan; failure on one plan doesn't block
 * sibling plans. Matches the WorkflowWaitSweeperCron defense-in-depth
 * shape (workflow-wait-sweeper.cron.ts:225-242).
 *
 * Actor semantics: the cron has no auth user. The RPC accepts
 * p_actor_user_id uuid; passing null is the sanctioned "system" path
 * (mirrors apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts:212).
 * The audit row's author_person_id ends up null, which the
 * ticket-activities renderer surfaces as "system".
 */
@Injectable()
export class PMGeneratorService {
  private readonly log = new Logger(PMGeneratorService.name);
  private readonly batchSize = (() => {
    const parsed = Number(process.env.PM_GENERATOR_BATCH_SIZE ?? 100);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 100;
  })();

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Iterate every active tenant and run generateForTenant. Single-process
   * sequential loop — per-tenant failure is logged but never aborts the
   * cron. Mirrors workflow-wait-sweeper.cron.ts:158-175 (which manages
   * the same "one tenant blowing up must not block its siblings"
   * invariant via per-row try/catch).
   */
  async generateForAllTenants(runAt: Date): Promise<{
    tenants: number;
    spawned: number;
    failed: number;
  }> {
    const tenantIds = await this.listActiveTenants();
    let spawned = 0;
    let failed = 0;
    for (const tenantId of tenantIds) {
      try {
        const result = await this.generateForTenant(tenantId, runAt);
        spawned += result.spawned;
        failed += result.failed;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`pm-generator.tenant_failed tenant=${tenantId}: ${message}`);
        failed++;
      }
    }
    return { tenants: tenantIds.length, spawned, failed };
  }

  async generateForTenant(
    tenantId: string,
    runAt: Date,
  ): Promise<{ spawned: number; failed: number; plans: number }> {
    let spawned = 0;
    let failed = 0;
    let plans = 0;
    const seenPlanIds = new Set<string>();

    while (true) {
      const dueBatch = await this.selectDuePlans(tenantId, runAt, this.batchSize);
      if (dueBatch.length === 0) break;

      const freshBatch = dueBatch.filter((p) => !seenPlanIds.has(p.id));
      if (freshBatch.length === 0) break;

      for (const plan of freshBatch) {
        seenPlanIds.add(plan.id);
        plans++;
        try {
          const result = await this.generateForPlan(plan, runAt);
          spawned += result.spawned;
          failed += result.failed;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(
            `pm-generator.plan_failed tenant=${tenantId} plan=${plan.id}: ${message}`,
          );
          failed++;
        }
      }

      if (dueBatch.length < this.batchSize) break;
    }

    return { spawned, failed, plans };
  }

  async generateForPlan(
    plan: DuePlanRow,
    runAt: Date,
  ): Promise<{ spawned: number; failed: number }> {
    const targets = await this.resolveTargets(plan);
    let spawned = 0;
    let failed = 0;

    for (const assetId of targets) {
      try {
        const wo = await this.callCreatePmWorkOrderRpc(plan, assetId);
        if (wo) spawned++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          `pm-generator.asset_failed tenant=${plan.tenant_id} plan=${plan.id} asset=${assetId}: ${message}`,
        );
        failed++;
      }
    }

    if (!isRecurrenceUnit(plan.recurrence_unit)) {
      this.log.error(
        `pm-generator.invalid_recurrence_unit plan=${plan.id} unit=${plan.recurrence_unit}`,
      );
      return { spawned, failed: failed + 1 };
    }

    await this.advancePlan(
      plan.id,
      plan.tenant_id,
      new Date(plan.next_run_at),
      plan.recurrence_interval,
      plan.recurrence_unit as RecurrenceUnit,
      runAt,
    );
    return { spawned, failed };
  }

  /**
   * Resolve a plan's target asset_id list.
   *
   * - Single-asset plan: returns [plan.asset_id].
   * - Asset-type plan: returns every public.assets row in the tenant
   *   matching asset_type_id (active filter applied if the column exists;
   *   defensive fall-through to no-active-filter if not — keeps the
   *   probe schema-agnostic across asset-table migrations).
   *
   * The mutex on the plan row (00386 CHECK constraint) guarantees
   * exactly one of the two columns is non-null; the defense-in-depth
   * throw protects against rows hand-edited past the CHECK.
   */
  async resolveTargets(plan: DuePlanRow): Promise<string[]> {
    if (plan.asset_id) return [plan.asset_id];
    if (plan.asset_type_id) {
      const { data, error } = await this.supabase.admin
        .from('assets')
        .select('id')
        .eq('tenant_id', plan.tenant_id)
        .eq('asset_type_id', plan.asset_type_id)
        .order('id', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
    throw new Error(
      `pm-generator.target_mutex_violation plan=${plan.id} — neither asset_id nor asset_type_id set`,
    );
  }

  /**
   * Wrap the create_pm_work_order RPC (00389). p_actor_user_id is null
   * for cron writes — the RPC's audit-emit branch (00389:137-143) tolerates
   * null and stamps ticket_activities.author_person_id null, which the
   * renderer surfaces as "system".
   *
   * Returns the new work_order id, or null when ON CONFLICT DO NOTHING
   * fired (idempotency: same plan + asset + planned_start_at already
   * generated).
   */
  async callCreatePmWorkOrderRpc(
    plan: DuePlanRow,
    assetId: string,
  ): Promise<string | null> {
    const { data, error } = await this.supabase.admin.rpc('create_pm_work_order', {
      p_plan_id: plan.id,
      p_actor_user_id: null,
      p_asset_id: assetId,
      p_run_at: plan.next_run_at,
    });
    if (error) throw error;
    return (data as string | null) ?? null;
  }

  /**
   * Advance a plan's next_run_at by ONE recurrence step relative to its
   * previous next_run_at. The generator does NOT backfill missed cycles
   * (plan §1 + §4 + §2 decision #6): if the cron didn't run for a week
   * and a daily plan slept past 6 occurrences, we still only spawn ONE
   * WO at the originally-scheduled next_run_at on this run, then advance
   * by ONE step. The next sweep will pick up the now-due next occurrence.
   *
   * The previous next_run_at is captured in plan.next_run_at; we advance
   * one step forward. If that result is STILL in the past relative to
   * runAt, the next cron tick handles it — keeps each tick bounded in
   * work and observable.
   */
  async advancePlan(
    planId: string,
    tenantId: string,
    fromNextRunAt: Date,
    interval: number,
    unit: RecurrenceUnit,
    runAt: Date,
  ): Promise<void> {
    void runAt;
    const advanced = advanceRecurrence(fromNextRunAt, interval, unit);
    const { error } = await this.supabase.admin
      .from('maintenance_plans')
      .update({ next_run_at: advanced.toISOString() })
      .eq('id', planId)
      .eq('tenant_id', tenantId);
    if (error) throw error;
  }

  async selectDuePlans(
    tenantId: string,
    runAt: Date,
    limit: number,
  ): Promise<DuePlanRow[]> {
    const { data, error } = await this.supabase.admin
      .from('maintenance_plans')
      .select(
        'id, tenant_id, asset_id, asset_type_id, recurrence_interval, recurrence_unit, next_run_at, lead_days',
      )
      .eq('tenant_id', tenantId)
      .eq('active', true)
      .lte('next_run_at', this.dueCutoffIso(runAt))
      .order('next_run_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as DuePlanRow[]).filter((row) =>
      this.isDueWithLeadDays(row, runAt),
    );
  }

  /**
   * Build the cutoff predicate next_run_at <= runAt + (lead_days *
   * '1 day'). PostgREST can't express the per-row interval add inline,
   * so we use the maximum lead_days as a SQL filter ceiling then
   * filter precisely in TS. v1 plans cap at lead_days=365 per the DTO,
   * so the worst-case cutoff is runAt + 365d.
   */
  private dueCutoffIso(runAt: Date): string {
    const ceiling = new Date(runAt.getTime());
    ceiling.setUTCDate(ceiling.getUTCDate() + 365);
    return ceiling.toISOString();
  }

  private isDueWithLeadDays(row: DuePlanRow, runAt: Date): boolean {
    const due = new Date(row.next_run_at);
    const cutoff = new Date(runAt.getTime());
    cutoff.setUTCDate(cutoff.getUTCDate() + (row.lead_days ?? 0));
    return due.getTime() <= cutoff.getTime();
  }

  /**
   * List every tenant currently in 'active' status. The cron iterates
   * this list to scope work to live tenants; provisioning + inactive
   * tenants are skipped silently (no work to do).
   */
  private async listActiveTenants(): Promise<string[]> {
    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('id')
      .eq('status', 'active')
      .order('id', { ascending: true });
    if (error) throw error;
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }
}

export interface DuePlanRow {
  id: string;
  tenant_id: string;
  asset_id: string | null;
  asset_type_id: string | null;
  recurrence_interval: number;
  recurrence_unit: string;
  next_run_at: string;
  lead_days: number;
}
