import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { DbService } from '../../common/db/db.service';
import { TenantContext, type TenantInfo } from '../../common/tenant-context';
import { DeadLetterError } from './dead-letter.error';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import type { DeadLetterReason, OutboxEvent } from './outbox.types';

/**
 * OutboxWorker — drains outbox.events.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §4 (drain),
 *       §4.2 (state machine), §4.3 (tenant context), §4.4 (backoff),
 *       §13.1 (purge cadence).
 *
 * Three crons:
 *   - drain (every 30s): claim a batch, dispatch through registered handler,
 *     transition each row through one of four §4.2 states.
 *   - stale-claim recovery (every 5m): clear claim_token on rows whose
 *     claimed_at is older than OUTBOX_STALE_CLAIM_MS. Does NOT increment
 *     attempts (§4.2.4 — worker crashes between claim+handler shouldn't burn
 *     attempts of pure infrastructure flakiness).
 *   - purge (every 1h): delete rows processed > OUTBOX_PURGE_AFTER_DAYS ago.
 */
@Injectable()
export class OutboxWorker {
  private readonly log = new Logger(OutboxWorker.name);

  // Configuration knobs (spec §4 / §13.1)
  private readonly enabled        = process.env.OUTBOX_WORKER_ENABLED !== 'false';
  private readonly batchSize      = Number(process.env.OUTBOX_BATCH_SIZE ?? 100);
  private readonly maxAttempts    = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5);
  private readonly staleClaimMs   = Number(process.env.OUTBOX_STALE_CLAIM_MS ?? 5 * 60 * 1000);
  private readonly purgeAfterDays = Number(process.env.OUTBOX_PURGE_AFTER_DAYS ?? 7);

  // Backoff schedule (ms) per spec §4.4. attempts=1 → first retry uses
  // backoffMs[0]; attempts=2 → backoffMs[1]; ...; attempts >= maxAttempts
  // dead-letters instead of using the table.
  private readonly backoffMs: number[] = (() => {
    const env = process.env.OUTBOX_BACKOFF_MS;
    if (env) {
      const parsed = env.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (parsed.length > 0) return parsed;
    }
    // Defaults: 30s, 2m, 10m, 1h.
    return [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
  })();

  // Tenant cache (spec §4.3, N2 fold). 30s TTL bounds staleness; tenant
  // hard-deletes are rare and the worker isn't request-latency-sensitive.
  private readonly tenantCacheTtlMs = 30_000;
  private readonly tenantCache = new Map<string, { value: TenantInfo | null; expiresAt: number }>();

  private draining = false;

  constructor(
    private readonly db: DbService,
    private readonly registry: OutboxHandlerRegistry,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // Cron entry points
  // ─────────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_30_SECONDS)
  async drain(): Promise<void> {
    if (!this.enabled) return;
    if (this.draining) return; // serialize self
    this.draining = true;
    try {
      const handled = await this.drainOnce();
      if (handled > 0) this.log.debug(`outbox drain processed ${handled} event(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`outbox drain failed: ${message}`);
    } finally {
      this.draining = false;
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepStaleClaims(): Promise<void> {
    if (!this.enabled) return;
    try {
      // Spec §4.2.4 — clear claim_token on stale rows; do NOT increment
      // attempts (a worker crash between claim and handler call is
      // infrastructure flakiness, not a handler outcome).
      const result = await this.db.query(
        `update outbox.events
            set claim_token = null, claimed_at = null
          where processed_at is null
            and dead_lettered_at is null
            and claimed_at is not null
            and claimed_at < now() - ($1 || ' milliseconds')::interval`,
        [this.staleClaimMs.toString()],
      );
      if (result.rowCount && result.rowCount > 0) {
        this.log.warn(`outbox stale-claim sweep released ${result.rowCount} row(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`outbox stale-claim sweep failed: ${message}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async purgeProcessed(): Promise<void> {
    if (!this.enabled) return;
    try {
      // Spec §13.1 — purge cadence is its own cron (decoupled from drain).
      const result = await this.db.query(
        `delete from outbox.events
          where processed_at is not null
            and processed_at < now() - ($1 || ' days')::interval`,
        [this.purgeAfterDays.toString()],
      );
      if (result.rowCount && result.rowCount > 0) {
        this.log.debug(`outbox purge removed ${result.rowCount} processed row(s)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`outbox purge failed: ${message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Drain (single pass)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Single drain pass. Public so tests can drive it deterministically.
   * Returns the number of events for which a §4.2 transition fired (i.e.
   * everything that had a handler, including dead-letters).
   */
  async drainOnce(): Promise<number> {
    const claimToken = randomUUID();

    // Spec §4.1 — claim a batch atomically. SKIP LOCKED lets multiple worker
    // instances coexist. The drain index covers this filter exactly:
    //   idx_outbox_events_drainable (available_at, enqueued_at)
    //   WHERE processed_at IS NULL AND claim_token IS NULL AND dead_lettered_at IS NULL
    //
    // Note: claim does NOT increment attempts. attempts only moves on
    // observed handler outcomes (§4.2 / I1).
    const claimed = await this.db.query<OutboxEvent>(
      `with cte as (
         select id from outbox.events
          where processed_at is null
            and dead_lettered_at is null
            and claim_token is null
            and available_at <= now()
            and attempts < $3
          order by available_at, enqueued_at
          limit $1
          for update skip locked
       )
       update outbox.events o
          set claim_token = $2, claimed_at = now()
         from cte
        where o.id = cte.id
        returning o.id, o.tenant_id, o.event_type, o.event_version,
                  o.aggregate_type, o.aggregate_id, o.payload, o.payload_hash,
                  o.idempotency_key, o.enqueued_at, o.available_at,
                  o.processed_at, o.processed_reason, o.claim_token,
                  o.claimed_at, o.attempts, o.last_error, o.dead_lettered_at`,
      [this.batchSize, claimToken, this.maxAttempts],
    );

    if (claimed.rowCount === 0) return 0;

    let handled = 0;
    for (const event of claimed.rows) {
      try {
        await this.dispatchOne(event, claimToken);
      } catch (err) {
        // dispatchOne is supposed to handle every error → if we land here,
        // it's a bug in the dispatcher itself. Log and leave the row claimed
        // so the stale-claim sweep can recover it.
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          `outbox dispatchOne unexpectedly threw for event ${event.id}: ${message}`,
        );
      }
      handled++;
    }
    return handled;
  }

  /**
   * Dispatch a single claimed event through the §4.2 state machine.
   * Always fires exactly one transition (Success / Retry / Dead-letter).
   *
   * Tenant context wrapping per §4.3:
   *  - Resolve tenant via 30s-TTL cache.
   *  - If unknown → dead-letter immediately with reason='tenant_not_found'.
   *  - Otherwise wrap handler.handle in TenantContext.run so any service-
   *    scoped helper called from the handler still sees the tenant.
   */
  private async dispatchOne(event: OutboxEvent, claimToken: string): Promise<void> {
    const handler = this.registry.get(event.event_type, event.event_version);
    if (!handler) {
      // Spec §10.2 #3 — explicit dead-letter, never silent skip.
      await this.deadLetter(event, claimToken, 'no_handler_registered',
        `no handler registered for ${event.event_type}@v${event.event_version}`);
      return;
    }

    const tenant = await this.loadTenant(event.tenant_id);
    if (!tenant) {
      await this.deadLetter(event, claimToken, 'tenant_not_found',
        `tenant ${event.tenant_id} not found in tenants registry`);
      return;
    }

    try {
      await TenantContext.run(tenant, () => handler.handle(event));
      await this.markSuccess(event, claimToken);
    } catch (err) {
      if (err instanceof DeadLetterError) {
        // Spec §4.5 — handler-driven dead-letter (e.g. tenant mismatch
        // detected after loading the aggregate). Bypass retry.
        await this.deadLetter(event, claimToken, 'dead_letter_error', err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // attempts on the row is the count BEFORE this run. After this run
      // we'd be at attempts+1; if that hits maxAttempts it's a dead-letter.
      const wouldBeAttempts = event.attempts + 1;
      if (wouldBeAttempts >= this.maxAttempts) {
        await this.deadLetter(event, claimToken, 'max_attempts', message);
      } else {
        await this.markRetry(event, claimToken, wouldBeAttempts, message);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // §4.2 state-machine transitions
  // ─────────────────────────────────────────────────────────────────────

  /** Transition (1) — handler succeeded. */
  private async markSuccess(event: OutboxEvent, claimToken: string): Promise<void> {
    // Spec §4.2.1 — attempts IS incremented on success. A clean first run
    // is attempts=1 when read; processed_reason='handler_ok' AND attempts>1
    // is the "succeeded after retries" cohort.
    await this.db.query(
      `update outbox.events
          set processed_at = now(), processed_reason = 'handler_ok',
              claim_token = null, last_error = null, attempts = attempts + 1
        where id = $1 and claim_token = $2`,
      [event.id, claimToken],
    );
  }

  /** Transition (2) — transient failure, schedule retry. */
  private async markRetry(
    event: OutboxEvent,
    claimToken: string,
    nextAttempts: number,
    error: string,
  ): Promise<void> {
    const delayMs = this.backoffForAttempt(nextAttempts);
    // Spec §4.2.2 — increment attempts, set last_error, push available_at.
    await this.db.query(
      `update outbox.events
          set claim_token = null,
              last_error = $3,
              attempts = $4,
              available_at = now() + ($5 || ' milliseconds')::interval
        where id = $1 and claim_token = $2`,
      [event.id, claimToken, error, nextAttempts, delayMs.toString()],
    );
  }

  /** Transition (3) — dead-letter. Single transaction: copy + flag. */
  private async deadLetter(
    event: OutboxEvent,
    claimToken: string,
    reason: DeadLetterReason,
    error: string,
  ): Promise<void> {
    // Spec §4.2.3 — copy to outbox.events_dead_letter, set dead_lettered_at
    // on the live row in the same tx so the drain index excludes it.
    // INSERT uses ON CONFLICT DO NOTHING on (tenant_id, idempotency_key) to
    // make a stale-claim retry-safe — if a previous worker already moved
    // the row but crashed before clearing claim_token, we re-acquire and
    // see the DL row already exists. The outbox row update still applies.
    await this.db.tx(async (client) => {
      await client.query(
        `insert into outbox.events_dead_letter
           (id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
            payload, payload_hash, idempotency_key, enqueued_at, attempts,
            last_error, dead_lettered_at, dead_letter_reason)
         select id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
                payload, payload_hash, idempotency_key, enqueued_at, attempts + 1,
                $3, now(), $4
           from outbox.events
          where id = $1 and claim_token = $2
         on conflict (tenant_id, idempotency_key) do nothing`,
        [event.id, claimToken, error, reason],
      );
      await client.query(
        `update outbox.events
            set claim_token = null,
                attempts = attempts + 1,
                last_error = $3,
                dead_lettered_at = now()
          where id = $1 and claim_token = $2`,
        [event.id, claimToken, error],
      );
    });
    this.log.error(
      `outbox dead-letter: ${event.event_type}@v${event.event_version} (event=${event.id}, reason=${reason}): ${error}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  private backoffForAttempt(attempt: number): number {
    // Spec §4.4 — pick the (attempt-1)th element of the table; clamp to
    // the last entry for over-shoots; apply ±33% jitter so cohorts don't
    // hammer the DB synchronously after a transient outage.
    const idx = Math.max(0, Math.min(attempt - 1, this.backoffMs.length - 1));
    const base = this.backoffMs[idx];
    const jitter = Math.floor(base * (Math.random() - 0.5) * 0.66); // ±33%
    return Math.max(1_000, base + jitter);
  }

  private async loadTenant(tenantId: string): Promise<TenantInfo | null> {
    const cached = this.tenantCache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const row = await this.db.queryOne<{ id: string; slug: string; tier: string }>(
      `select id, slug, tier from public.tenants where id = $1`,
      [tenantId],
    );
    let value: TenantInfo | null = null;
    if (row) {
      value = {
        id: row.id,
        slug: row.slug,
        tier: row.tier === 'enterprise' ? 'enterprise' : 'standard',
      };
    }
    this.tenantCache.set(tenantId, { value, expiresAt: now + this.tenantCacheTtlMs });
    return value;
  }

  /**
   * Test-only — flush the tenant cache so tests can simulate a tenant
   * being added/removed mid-run without waiting 30s.
   */
  clearTenantCacheForTest(): void {
    this.tenantCache.clear();
  }
}
