import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import type { OutboxEventInput } from './outbox.types';

/**
 * TS-side outbox helpers.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.2.
 *
 * @deprecated B.0 cutover — `markConsumed()` and the v3/v4 lease semantics
 * it documents are obsolete. The new producer surface is `outbox.emit()`
 * called directly from inside RPC bodies (combined RPC, grant_booking
 * _approval, approve_booking_setup_trigger, create_setup_work_order_from
 * _event). `OutboxService.emit()` survives as a fire-and-forget producer
 * for future best-effort emissions but currently has zero callers; spec
 * §11 open question 4 keeps it for now. Scheduled for cleanup per
 * spec §16.1: delete `markConsumed`, prune the lease-era prose, narrow
 * the file to the fire-and-forget emit only. Tracked in
 * `docs/follow-ups/b0-legacy-cleanup.md`.
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
   * Marks a lease event consumed (spec §2.5).
   *
   * @deprecated B.0 cutover retired the lease-based watchdog flow that
   * required a separate consumer-side ack. Producer RPCs now write the
   * outbox row in the same tx as their domain mutation, so there's no
   * lease to consume. This method has zero call sites in non-test code
   * (verified 2026-05-04). Scheduled for deletion per spec §16.1
   * step 1; tracked in `docs/follow-ups/b0-legacy-cleanup.md`. Do NOT
   * add new callers — write your producer as a combined RPC instead.
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
