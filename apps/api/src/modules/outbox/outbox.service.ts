import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import type { OutboxEventInput } from './outbox.types';

/**
 * TS-side outbox helpers.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.2.
 *
 * Two methods, two semantics:
 *
 *   1. `emit()` — fire-and-forget. NOT transactional. Failures logged, never
 *      thrown. Use ONLY for best-effort post-commit operations (notifications,
 *      webhook delivery hints). Anything where loss of the event corrupts
 *      state belongs in a row-trigger or in an RPC body that calls
 *      `outbox.emit` directly (spec §1).
 *
 *   2. `markConsumed()` — lease consumption. THROWS on RPC error. The success
 *      path NEEDS this to succeed or a watchdog handler fires a false-positive
 *      ~30s later. Used by RPC-emitting producers to ack the lease.
 */
@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Fire-and-forget emit (spec §3.2). Failures are logged but never thrown —
   * losing this emission must not break the user's request.
   *
   * Idempotency key is constructed deterministically as
   * `<eventType>:<aggregateId>:<operationId>`. Same input produces same key
   * → same-payload re-emit is a no-op silent success in the SQL helper;
   * same-key/different-payload raises 23505 (caught and logged here).
   */
  async emit(input: OutboxEventInput): Promise<void> {
    const idempotencyKey = `${input.eventType}:${input.aggregateId}:${input.operationId}`;
    try {
      const { error } = await this.supabase.admin.rpc('outbox_emit_via_rpc', {
        p_tenant_id: input.tenantId,
        p_event_type: input.eventType,
        p_aggregate_type: input.aggregateType,
        p_aggregate_id: input.aggregateId,
        p_payload: input.payload ?? {},
        p_idempotency_key: idempotencyKey,
        p_event_version: input.eventVersion ?? 1,
      });
      if (error) {
        this.log.error(
          `outbox emit failed (${input.eventType}, key=${idempotencyKey}): ${error.message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `outbox emit threw (${input.eventType}, key=${idempotencyKey}): ${message}`,
      );
    }
  }

  /**
   * Marks a lease event consumed (spec §2.5). THROWS on RPC error — the
   * caller's success-path semantics require this round-trip to succeed.
   * Returns true when a row was updated, false on idempotent re-call.
   */
  async markConsumed(input: {
    tenantId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<boolean> {
    const { data, error } = await this.supabase.admin.rpc(
      'outbox_mark_consumed_via_rpc',
      {
        p_tenant_id: input.tenantId,
        p_idempotency_key: input.idempotencyKey,
        p_reason: input.reason,
      },
    );
    if (error) throw error;
    return Boolean(data);
  }
}
