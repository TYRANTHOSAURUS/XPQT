import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DbService } from '../../common/db/db.service';

/**
 * Cross-spec audit emitter. Producers call `emit()` (or `emitTx()` inside a
 * transaction) to enqueue an audit event; the AuditOutboxWorker drains rows
 * into `audit_events` asynchronously. This decouples business-transaction
 * latency from durability of the audit trail.
 *
 * Pattern reference: cross-spec-dependency-map.md §3.2.
 */
@Injectable()
export class AuditOutboxService {
  private readonly log = new Logger(AuditOutboxService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Emit an audit event outside any caller transaction. Use this from the
   * default service-method path. Failures are logged but never thrown —
   * losing an audit emission must not break the user's request.
   */
  async emit(input: AuditEventInput): Promise<void> {
    try {
      await this.db.query(
        `insert into audit_outbox
           (tenant_id, event_type, entity_type, entity_id,
            actor_user_id, details, ip_address, occurred_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, coalesce($8, now()))`,
        [
          input.tenantId,
          input.eventType,
          input.entityType ?? null,
          input.entityId ?? null,
          input.actorUserId ?? null,
          JSON.stringify(input.details ?? {}),
          input.ipAddressHash ?? null,
          input.occurredAt ?? null,
        ],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `audit emit failed (event=${input.eventType} tenant=${input.tenantId}): ${message}`,
      );
    }
  }

  /**
   * Emit inside an existing transaction. Use when the audit row must be
   * durable iff the surrounding business write commits. Throws on failure
   * — caller's transaction will roll back, which is the correct behavior
   * for "audit must commit with the change" semantics.
   */
  async emitTx(client: PoolClient, input: AuditEventInput): Promise<void> {
    await client.query(
      `insert into audit_outbox
         (tenant_id, event_type, entity_type, entity_id,
          actor_user_id, details, ip_address, occurred_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, coalesce($8, now()))`,
      [
        input.tenantId,
        input.eventType,
        input.entityType ?? null,
        input.entityId ?? null,
        input.actorUserId ?? null,
        JSON.stringify(input.details ?? {}),
        input.ipAddressHash ?? null,
        input.occurredAt ?? null,
      ],
    );
  }

  /**
   * Pre-hash an IP before emitting. Per gdpr-baseline-design.md §18 we never
   * store raw IPs; SHA-256 + per-tenant salt gives forensic value (linkability
   * within a tenant) without exposing raw IPs across the table.
   *
   * Tenant salt fallback (`tenant_id`) keeps things working for callers that
   * haven't loaded the per-tenant salt yet; rotate to a real per-tenant secret
   * stored in `tenant_secrets` when that table lands (Sprint 5 hardening).
   */
  hashIp(ip: string | null | undefined, tenantId: string): string | null {
    if (!ip) return null;
    return createHash('sha256').update(`${tenantId}:${ip}`).digest('hex');
  }
}

export interface AuditEventInput {
  tenantId: string;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  actorUserId?: string | null;
  details?: Record<string, unknown>;
  /** Caller-provided pre-hashed IP. Use AuditOutboxService.hashIp() if you have a raw IP. */
  ipAddressHash?: string | null;
  /** Override timestamp. Defaults to now(). */
  occurredAt?: Date | string | null;
}
