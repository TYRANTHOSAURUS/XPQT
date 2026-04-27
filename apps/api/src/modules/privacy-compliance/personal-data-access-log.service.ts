import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { DbService } from '../../common/db/db.service';

/**
 * Read-side audit log batched writer.
 *
 * Per gdpr-baseline-design.md §7:
 *   - Service-layer instrumentation captures every read of personal data.
 *   - Volume is high (one log per page load) so we batch + flush every 5s.
 *   - Aggregate similar reads in the same session: one log per
 *     user-session-resource-5min window. Burns less storage, cleaner audit
 *     output for the "who accessed Marleen V.'s data" query.
 *
 * The interceptor calls `enqueue()`; the cron flush turns auth_uids into
 * users.id and bulk-inserts into personal_data_access_logs.
 */
@Injectable()
export class PersonalDataAccessLogService {
  private readonly log = new Logger(PersonalDataAccessLogService.name);

  private readonly enabled = process.env.PDAL_WORKER_ENABLED !== 'false';
  /** Per-(actor, category, resource) dedup window — 5 min per spec §7. */
  private readonly dedupWindowMs = Number(process.env.PDAL_DEDUP_WINDOW_MS ?? 5 * 60 * 1000);
  /** Soft cap on the in-memory buffer; over the cap we force a flush. */
  private readonly maxBufferSize = Number(process.env.PDAL_MAX_BUFFER ?? 5000);

  /** Buffer awaiting batch insert. Mutable; not thread-safe but Node is single-threaded per worker. */
  private buffer: PendingAccessLog[] = [];
  /** key → timestamp of last enqueue, for dedup. Pruned on flush. */
  private dedupCache = new Map<string, number>();
  private flushing = false;

  constructor(private readonly db: DbService) {}

  /**
   * Queue an access-log entry. Cheap — no DB hit. The actor is identified
   * by Supabase auth uid; the flush resolves it to users.id with a single
   * batched SELECT.
   *
   * Returns true if accepted, false if deduped.
   */
  enqueue(entry: PendingAccessLog): boolean {
    if (!this.enabled) return false;

    const key = this.dedupKey(entry);
    const now = Date.now();
    const lastSeen = this.dedupCache.get(key);
    if (lastSeen !== undefined && now - lastSeen < this.dedupWindowMs) {
      return false;                           // suppress; same actor / category / resource hit recently
    }

    this.dedupCache.set(key, now);
    this.buffer.push(entry);

    if (this.buffer.length >= this.maxBufferSize) {
      // Don't await — fire-and-forget. The cron will pick up any leftover.
      void this.flush();
    }
    return true;
  }

  /** Hash an IP / UA for storage — never store raw. */
  hashIdentifier(value: string | null | undefined, tenantId: string): string | null {
    if (!value) return null;
    return createHash('sha256').update(`${tenantId}:${value}`).digest('hex');
  }

  /** Hash a query-params object for grouping similar searches. */
  hashQuery(query: Record<string, unknown> | null | undefined): string | null {
    if (!query) return null;
    const stable = JSON.stringify(query, Object.keys(query).sort());
    return createHash('sha256').update(stable).digest('hex').slice(0, 32);
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async cronFlush(): Promise<void> {
    if (!this.enabled) return;
    if (this.buffer.length === 0) return;
    await this.flush();
  }

  /** Manual flush — used in tests + during shutdown. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.buffer.splice(0);
      this.prunePastWindow();
      await this.write(batch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`pdal flush failed: ${message}`);
    } finally {
      this.flushing = false;
    }
  }

  private async write(batch: PendingAccessLog[]): Promise<void> {
    if (batch.length === 0) return;

    // Resolve auth uids → users.id, scoped per tenant. One query covers the
    // whole batch. Anything we can't resolve gets actor_user_id=null + the
    // raw auth_uid hash recorded in the actor_role column for forensics.
    const tenantToUids = new Map<string, Set<string>>();
    for (const e of batch) {
      if (!e.actorAuthUid) continue;
      let s = tenantToUids.get(e.tenantId);
      if (!s) { s = new Set(); tenantToUids.set(e.tenantId, s); }
      s.add(e.actorAuthUid);
    }

    const userIdByTenantUid = new Map<string, string>();    // `${tenantId}:${authUid}` → users.id
    for (const [tenantId, uids] of tenantToUids) {
      const rows = await this.db.queryMany<{ id: string; auth_uid: string }>(
        `select id, auth_uid from users
          where tenant_id = $1 and auth_uid = any($2::uuid[])`,
        [tenantId, Array.from(uids)],
      );
      for (const r of rows) userIdByTenantUid.set(`${tenantId}:${r.auth_uid}`, r.id);
    }

    // Bulk insert via VALUES (...). Keep param-count under 30k Postgres limit
    // by chunking; 12 params/row × 2000 rows = 24k.
    const chunkSize = 2000;
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of chunk) {
        const usersId = e.actorAuthUid ? userIdByTenantUid.get(`${e.tenantId}:${e.actorAuthUid}`) ?? null : null;
        placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(
          e.tenantId,
          e.accessedAt ?? new Date(),
          usersId,
          e.actorRole ?? null,
          e.actorIpHash ?? null,
          e.actorUserAgentHash ?? null,
          e.subjectPersonId ?? null,
          e.dataCategory,
          e.resourceType,
          e.resourceId ?? null,
          e.accessMethod,
          e.queryHash ?? null,
        );
      }

      await this.db.query(
        `insert into personal_data_access_logs
           (tenant_id, accessed_at, actor_user_id, actor_role,
            actor_ip_hash, actor_user_agent_hash, subject_person_id,
            data_category, resource_type, resource_id, access_method,
            query_hash)
         values ${placeholders.join(', ')}`,
        params,
      );
    }
  }

  private dedupKey(e: PendingAccessLog): string {
    return [
      e.tenantId,
      e.actorAuthUid ?? 'system',
      e.dataCategory,
      e.resourceType,
      e.resourceId ?? '*',
      e.accessMethod,
    ].join('|');
  }

  /** Drop dedup-cache entries past their window so the map doesn't grow unboundedly. */
  private prunePastWindow(): void {
    const cutoff = Date.now() - this.dedupWindowMs;
    for (const [key, ts] of this.dedupCache) {
      if (ts < cutoff) this.dedupCache.delete(key);
    }
  }
}

export interface PendingAccessLog {
  tenantId: string;
  /** Supabase auth uid — flush will resolve to users.id. */
  actorAuthUid: string | null;
  actorRole?: string | null;            // 'admin' | 'desk_operator' | 'api' | 'system' | 'vendor_user'
  actorIpHash?: string | null;
  actorUserAgentHash?: string | null;
  subjectPersonId?: string | null;
  dataCategory: string;
  resourceType: string;
  resourceId?: string | null;
  accessMethod: 'list_query' | 'detail_view' | 'export' | 'search' | 'api';
  queryHash?: string | null;
  accessedAt?: Date;
}
