import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PMGeneratorService } from './pm-generator.service';

/**
 * PMGeneratorCron — nightly PM generator driver.
 *
 * Plan: ai/slice-c-plan.md §4. Fires at 03:00 daily by tenant local-clock
 * approximation; the cron timezone defaults to the host process tz (UTC
 * in production) — calendar adjustment for business hours is explicitly
 * deferred (plan §1 "out of scope"). The generator is idempotent at the
 * row layer (uq_work_orders_pm_occurrence) so a re-fire is safe.
 *
 * Concurrency model:
 *   - The cron serialises itself via `this.running` (mirrors
 *     workflow-wait-sweeper.cron.ts:160-162 + outbox.worker.ts:55-79).
 *     A second fire while the previous run is still draining is a no-op.
 *   - Per-tenant try/catch + per-plan try/catch + per-asset try/catch
 *     inside PMGeneratorService mean transient failures never abort
 *     the whole sweep.
 *
 * Configuration:
 *   - PM_GENERATOR_ENABLED (default 'true') — set to 'false' to disable
 *     the cron entirely. Same pattern as WORKFLOW_WAIT_SWEEPER_ENABLED.
 *   - PM_GENERATOR_BATCH_SIZE — overrides PMGeneratorService batch
 *     ceiling.
 */
@Injectable()
export class PMGeneratorCron {
  private readonly log = new Logger(PMGeneratorCron.name);
  private readonly enabled = process.env.PM_GENERATOR_ENABLED !== 'false';
  private running = false;

  constructor(private readonly generator: PMGeneratorService) {}

  @Cron('0 3 * * *')
  async runDaily(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) {
      this.log.debug('pm-generator: previous run still active; skipping tick');
      return;
    }
    this.running = true;
    const startedAt = new Date();
    try {
      const result = await this.generator.generateForAllTenants(startedAt);
      this.log.log(
        `pm-generator: tenants=${result.tenants} spawned=${result.spawned} failed=${result.failed} duration_ms=${Date.now() - startedAt.getTime()}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`pm-generator.run_failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
