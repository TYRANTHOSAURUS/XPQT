import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../common/db/db.service';
import { RetentionService } from './retention.service';
import { DataCategoryRegistry } from './data-category-registry.service';
import { AuditOutboxService } from './audit-outbox.service';
import { GdprEventType } from './event-types';

/**
 * Nightly retention worker. Walks every tenant × every registered category
 * and applies the per-tenant retention setting.
 *
 * Per gdpr-baseline-design.md §4:
 *   - Idempotent (adapters set anonymized_at/hard_deleted_at flags so re-runs skip).
 *   - Chunked (RetentionService.applyRetention chunks via the adapter).
 *   - Per-tenant per-category advisory lock prevents double-processing if
 *     two worker instances schedule concurrently.
 *   - Drift detection: surface anomalies (skipped runs, large batches).
 *
 * Sprint 1 ships the worker with no live adapters registered yet; it iterates,
 * skips empty categories, and emits run-completed audits — exercises the
 * full surface so Sprint 2 adapters drop in cleanly.
 */
@Injectable()
export class RetentionWorker {
  private readonly log = new Logger(RetentionWorker.name);

  // Lock key namespace for pg_advisory_xact_lock — first int is per-subsystem.
  private static readonly LOCK_NS_RETENTION = 0x4744_5052; // 'GDPR' as 4 ASCII bytes

  private readonly enabled = process.env.GDPR_RETENTION_WORKER_ENABLED !== 'false';
  // Soft cap on records anonymized in a single run per category — alert if exceeded.
  private readonly anomalyThreshold = Number(process.env.GDPR_RETENTION_ANOMALY_THRESHOLD ?? 1000);

  constructor(
    private readonly db: DbService,
    private readonly retention: RetentionService,
    private readonly registry: DataCategoryRegistry,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  /**
   * 03:30 every night, after the audit outbox has had ample time to drain
   * the previous day's events. Cron timezone follows the API container's TZ;
   * for EU-resident deployments we default to UTC.
   */
  @Cron('0 30 3 * * *')
  async runNightly(): Promise<void> {
    if (!this.enabled) return;
    if (this.registry.all().length === 0) {
      this.log.debug('retention worker: no adapters registered yet, skipping run');
      return;
    }

    const startedAt = Date.now();
    const tenants = await this.retention.listActiveTenantIds();
    const adapters = this.registry.all();

    let processedTenants = 0;
    let totalApplied = 0;

    for (const tenantId of tenants) {
      for (const adapter of adapters) {
        const ok = await this.runOneWithLock(tenantId, adapter.category);
        if (ok?.applied) totalApplied += ok.applied;
        if (ok?.applied && ok.applied >= this.anomalyThreshold) {
          this.log.warn(
            `retention anomaly: tenant=${tenantId} category=${adapter.category} applied=${ok.applied} (threshold=${this.anomalyThreshold})`,
          );
        }
      }
      processedTenants += 1;
    }

    const elapsedMs = Date.now() - startedAt;
    this.log.log(
      `retention nightly complete: tenants=${processedTenants} applied=${totalApplied} elapsed_ms=${elapsedMs}`,
    );
  }

  /**
   * Monthly partition maintenance for personal_data_access_logs. Creates
   * the next two months ahead so writes never miss a partition. Drops
   * partitions older than the longest cap (730d) — per-tenant retention is
   * shorter but we keep partitions until the longest cap to allow late
   * tenants extending their setting.
   */
  @Cron('0 0 4 * * *')
  async maintainPdalPartitions(): Promise<void> {
    if (!this.enabled) return;
    try {
      // Ensure next 2 months exist.
      for (const offset of [1, 2]) {
        await this.db.query(
          `select public.ensure_pdal_partition((date_trunc('month', current_date) + ($1 || ' months')::interval)::date)`,
          [offset.toString()],
        );
      }

      // Drop partitions older than 730 days (the cap). The drop is best-effort;
      // a failure here just means a stale partition lingers — not data loss.
      const stale = await this.db.queryMany<{ tablename: string }>(
        `select tablename
           from pg_tables
          where schemaname = 'public'
            and tablename like 'personal_data_access_logs_%'
            and tablename < 'personal_data_access_logs_' ||
                            to_char(current_date - interval '730 days', 'YYYY_MM')`,
      );
      for (const { tablename } of stale) {
        try {
          await this.db.query(`drop table if exists public.${tablename}`);
          this.log.log(`pdal partition dropped: ${tablename}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(`pdal partition drop failed (${tablename}): ${message}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`pdal partition maintenance failed: ${message}`);
    }
  }

  /**
   * Hard-purge expired anonymization_audit rows past their 7-day window.
   */
  @Cron('0 15 4 * * *')
  async purgeAnonymizationAudit(): Promise<void> {
    if (!this.enabled) return;
    try {
      const r = await this.db.query(
        `delete from anonymization_audit
          where restored_at is null and expires_at < now()`,
      );
      if (r.rowCount && r.rowCount > 0) {
        this.log.log(`anonymization_audit purged: ${r.rowCount} rows`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`anonymization_audit purge failed: ${message}`);
    }
  }

  /**
   * Wrap a single (tenant, category) apply in a session-scoped advisory lock.
   * Two worker instances running concurrently will skip the second attempt
   * cleanly. Lock is released when the function returns.
   */
  private async runOneWithLock(
    tenantId: string,
    category: string,
  ): Promise<{ applied: number } | null> {
    const lockKey = this.lockKeyFor(tenantId, category);

    return this.db.tx(async (client) => {
      const got = await client.query<{ locked: boolean }>(
        `select pg_try_advisory_xact_lock($1, $2) as locked`,
        [RetentionWorker.LOCK_NS_RETENTION, lockKey],
      );
      if (!got.rows[0]?.locked) {
        this.log.debug(`retention skipped (lock contended): tenant=${tenantId} category=${category}`);
        return null;
      }

      try {
        const result = await this.retention.applyRetention(tenantId, category, { dryRun: false });
        return { applied: result.anonymized + result.hardDeleted };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`retention failed: tenant=${tenantId} category=${category}: ${message}`);
        await this.auditOutbox.emit({
          tenantId,
          eventType: GdprEventType.RetentionRunFailed,
          details: { data_category: category, error: message.slice(0, 500) },
        });
        return null;
      }
    });
  }

  /**
   * Hash (tenantId, category) into a stable 32-bit lock key so we don't
   * have to keep a DB-side mapping. Collisions are tolerable — at worst,
   * two unrelated runs serialize.
   */
  private lockKeyFor(tenantId: string, category: string): number {
    let h = 0;
    const s = `${tenantId}:${category}`;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return h;
  }
}
