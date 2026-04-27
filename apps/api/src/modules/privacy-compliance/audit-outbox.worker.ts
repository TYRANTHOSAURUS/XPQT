import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { DbService } from '../../common/db/db.service';

/**
 * Drains audit_outbox into audit_events. Runs every 30 seconds; claims a
 * batch via a per-worker UUID token + advisory cleanup of stale claims.
 *
 * Idempotency: a stale claim (worker died mid-batch) becomes visible to the
 * next sweep after STALE_CLAIM_AFTER_MS. The destination insert into
 * audit_events uses the outbox row's id as a deterministic anchor, so a
 * retry that double-inserts is detected by the unique constraint and skipped.
 *
 * Configuration knobs (env-driven; defaults sane for v1):
 *   AUDIT_OUTBOX_BATCH_SIZE       — rows claimed per pass (default 500).
 *   AUDIT_OUTBOX_STALE_CLAIM_MS   — ms before a claim is considered abandoned (default 5min).
 *   AUDIT_OUTBOX_PURGE_AFTER_DAYS — drop processed rows older than this (default 7).
 */
@Injectable()
export class AuditOutboxWorker {
  private readonly log = new Logger(AuditOutboxWorker.name);

  private readonly batchSize       = Number(process.env.AUDIT_OUTBOX_BATCH_SIZE ?? 500);
  private readonly staleClaimMs    = Number(process.env.AUDIT_OUTBOX_STALE_CLAIM_MS ?? 5 * 60 * 1000);
  private readonly purgeAfterDays  = Number(process.env.AUDIT_OUTBOX_PURGE_AFTER_DAYS ?? 7);
  private readonly maxAttempts     = Number(process.env.AUDIT_OUTBOX_MAX_ATTEMPTS ?? 8);
  private readonly enabled         = process.env.AUDIT_OUTBOX_WORKER_ENABLED !== 'false';

  private running = false;

  constructor(private readonly db: DbService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async drain(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;          // serialize self — prevents overlap if a sweep takes longer than 30s

    this.running = true;
    try {
      const drained = await this.drainOnce();
      if (drained > 0) this.log.debug(`drained ${drained} audit rows`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`audit outbox drain failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Single drain pass. Public so we can call it from a manual trigger or
   * test. Returns the number of rows successfully written to audit_events.
   */
  async drainOnce(): Promise<number> {
    // Step 1: reclaim stale claims so dropped claim_tokens don't strand rows.
    await this.db.query(
      `update audit_outbox
          set claim_token = null, claimed_at = null
        where processed_at is null
          and claimed_at is not null
          and claimed_at < now() - ($1 || ' milliseconds')::interval`,
      [this.staleClaimMs.toString()],
    );

    // Step 2: claim a batch atomically. SKIP LOCKED lets multiple worker
    // instances coexist without blocking each other. Skip rows past
    // maxAttempts — they're broken (poison-pill payload, schema drift, etc.)
    // and need ops attention rather than continued retry.
    const claimToken = randomUUID();
    const claimed = await this.db.query<{ id: string }>(
      `with cte as (
         select id from audit_outbox
          where processed_at is null
            and claim_token is null
            and attempts < $3
          order by enqueued_at
          limit $1
          for update skip locked
       )
       update audit_outbox o
          set claim_token = $2, claimed_at = now(), attempts = o.attempts + 1
         from cte
        where o.id = cte.id
        returning o.id`,
      [this.batchSize, claimToken, this.maxAttempts],
    );

    if (claimed.rowCount === 0) {
      await this.purgeProcessed();
      await this.warnOnDeadLetter();
      return 0;
    }

    // Step 3: copy claimed rows into audit_events.
    // Re-running the same id is a no-op via the unique-id collision; if a
    // worker died between INSERT and the UPDATE-processed step, the next pass
    // will reclaim the row, attempt the insert (collision = skip), and mark
    // it processed.
    const result = await this.db.query<{ written: number }>(
      `with claimed as (
         select id, tenant_id, event_type, entity_type, entity_id,
                actor_user_id, details, ip_address, occurred_at
           from audit_outbox
          where claim_token = $1 and processed_at is null
       ), inserted as (
         insert into audit_events
           (id, tenant_id, event_type, entity_type, entity_id,
            actor_user_id, details, ip_address, created_at)
         select id, tenant_id, event_type, entity_type, entity_id,
                actor_user_id, details, ip_address, occurred_at
           from claimed
         on conflict (id) do nothing
         returning id
       )
       select count(*)::int as written from inserted`,
      [claimToken],
    );

    // Step 4: mark all claimed rows processed (whether the insert wrote a
    // new row or hit the unique-id no-op — both mean the event reached
    // audit_events).
    await this.db.query(
      `update audit_outbox
          set processed_at = now()
        where claim_token = $1 and processed_at is null`,
      [claimToken],
    );

    return result.rows[0]?.written ?? 0;
  }

  /**
   * Drop rows fully processed more than purgeAfterDays ago. Audit durability
   * lives in audit_events; outbox is just the staging area.
   */
  private async purgeProcessed(): Promise<void> {
    await this.db.query(
      `delete from audit_outbox
        where processed_at is not null
          and processed_at < now() - ($1 || ' days')::interval`,
      [this.purgeAfterDays.toString()],
    );
  }

  /**
   * Surface dead-letter rows (attempts hit the cap, never processed) so ops
   * can investigate. Cheap query — only runs when the worker has nothing
   * else to do, and only logs when there's something to report.
   */
  private async warnOnDeadLetter(): Promise<void> {
    const r = await this.db.queryOne<{ count: string }>(
      `select count(*)::text as count from audit_outbox
        where processed_at is null and attempts >= $1`,
      [this.maxAttempts],
    );
    const n = Number(r?.count ?? '0');
    if (n > 0) {
      this.log.warn(
        `audit_outbox dead-letter: ${n} rows past max_attempts=${this.maxAttempts}; ` +
        `select id, event_type, last_error, attempts from audit_outbox ` +
        `where processed_at is null and attempts >= ${this.maxAttempts};`,
      );
    }
  }
}
