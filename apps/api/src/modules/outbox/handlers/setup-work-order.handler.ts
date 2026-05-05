import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import {
  SetupWorkOrderRowBuilder,
  type SetupWorkOrderPayload,
} from '../../service-routing/setup-work-order-row-builder.service';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * SetupWorkOrderHandler — drains
 * `setup_work_order.create_required` outbox events.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md
 *       §7.7 (row-builder), §7.8 / §7.8.2 (this handler + RPC contract),
 *       §4.5 (DeadLetterError shape), §3.3 (idempotency key construction).
 *
 * Pre-v7 the outbox handler called `SetupWorkOrderTriggerService.triggerStrict`,
 * which inserted the work_orders row via supabase-js (one HTTP call → one tx)
 * AND then inserted the dedup row in `setup_work_order_emissions` via a SECOND
 * HTTP call (a second tx). Crash between commits → duplicate WO on replay.
 *
 * v7 introduced `create_setup_work_order_from_event` (RPC) which inserts the
 * WO + dedup row + audit row atomically inside one Postgres transaction. v8.1
 * extended the RPC to derive identity from the `outbox.events` row itself
 * (not from the row JSON) and to validate every tenant-owned FK via
 * `validate_setup_wo_fks`.
 *
 * The TS handler's responsibility shrinks to:
 *   1. Build the WO row payload via `SetupWorkOrderRowBuilder.build` (routing
 *      matrix + lead-time math + audit metadata).
 *   2. Hand the row to the RPC.
 *   3. Map the RPC outcome onto outbox state-machine transitions:
 *        - success / already_created / already_handled_tombstone → return void
 *          (worker marks `processed_at`).
 *        - terminal RPC errors (P0001 / P0002 codes from §7.8.2) → throw
 *          `DeadLetterError` (worker dead-letters with reason='dead_letter_error').
 *        - terminal builder outcome (no_op_terminal) → audit + return void
 *          (a future replay after admin reconfigures the routing matrix may
 *          re-evaluate; capture the outcome on `audit_events` for triage).
 *        - transient (RPC connection error, NaN math, etc.) → throw a plain
 *          `Error` (worker retries per §4.4 with backoff).
 *
 * The legacy `SetupWorkOrderTriggerService` STAYS callable from non-outbox
 * paths during the cutover window — it's documented as deprecated but not
 * yet deleted (see §16.1 cleanup commit).
 */
@Injectable()
@OutboxHandler('setup_work_order.create_required', { version: 1 })
export class SetupWorkOrderHandler
  implements OutboxEventHandler<SetupWorkOrderPayload>
{
  private readonly log = new Logger(SetupWorkOrderHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly rowBuilder: SetupWorkOrderRowBuilder,
  ) {}

  async handle(event: OutboxEvent<SetupWorkOrderPayload>): Promise<void> {
    // ── 1. Tenant smuggling defense (worker §4.3 already asserted the tenant
    //   row exists; this also asserts the aggregate row matches). The OLI
    //   may have been hard-deleted between emit and drain (cancellation
    //   cascade beat us) — that's an idempotent success, not a retry. ──────
    const oliRes = await this.supabase.admin
      .from('order_line_items')
      .select('id, tenant_id, order_id')
      .eq('id', event.aggregate_id)
      .maybeSingle();
    if (oliRes.error) {
      // Read failure (PG connection wobble, etc.) — transient, retry.
      throw new Error(
        `setup_work_order.handler: order_line_items lookup failed: ${oliRes.error.message}`,
      );
    }
    if (!oliRes.data) {
      this.log.log(
        `oli_already_gone oli=${event.aggregate_id} event=${event.id}`,
      );
      return;
    }
    if (oliRes.data.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `tenant_mismatch: event.tenant_id=${event.tenant_id} oli.tenant_id=${oliRes.data.tenant_id}`,
      );
    }

    // ── 2. Approval-pending guard (defense-in-depth — both producer paths
    //   gate emission on any_pending_approval=false). If an event slips
    //   past with requires_approval=true, skip silently — the
    //   `approve_booking_setup_trigger` RPC will re-emit on grant. ─────────
    if (event.payload.requires_approval) {
      this.log.log(
        `requires_approval_skip oli=${event.aggregate_id} event=${event.id}`,
      );
      return;
    }

    // ── 3. Read-side dedup (v6 + v7-I1). Fast path for the common
    //   "worker retried after partial commit" case so we don't pay the
    //   row-build + RPC round trip when we already know the answer. The
    //   write-side dedup is the RPC's INSERT into setup_work_order_emissions
    //   (atomic + advisory-locked); this read is purely for latency. ───────
    const existingRes = await this.supabase.admin
      .from('setup_work_order_emissions')
      .select('work_order_id')
      .eq('tenant_id', event.tenant_id)
      .eq('oli_id', event.aggregate_id)
      .maybeSingle();
    if (existingRes.error) {
      throw new Error(
        `setup_work_order.handler: emissions dedup lookup failed: ${existingRes.error.message}`,
      );
    }
    if (existingRes.data) {
      this.log.log(
        `already_emitted oli=${event.aggregate_id} wo=${existingRes.data.work_order_id ?? 'null(tombstone)'} event=${event.id}`,
      );
      return;
    }

    // ── 4. Build the WO row payload TS-side (routing matrix + lead-time
    //   math). Terminal misconfiguration returns no_op_terminal; transient
    //   errors throw and the worker retries. ──────────────────────────────
    const built = await this.rowBuilder.buildFromEvent(event);

    if (built.kind === 'no_op_terminal') {
      // Terminal: do NOT call the create RPC; do NOT insert dedup. A future
      // replay (e.g. after admin reconfigures the routing matrix) will
      // re-evaluate and may produce a WO. Capture the terminal outcome in
      // audit_events for ops triage.
      const auditRes = await this.supabase.admin.from('audit_events').insert({
        tenant_id: event.tenant_id,
        event_type: `setup_work_order.${built.reason}`,
        entity_type: 'order_line_item',
        entity_id: event.aggregate_id,
        details: {
          event_id: event.id,
          reason: built.reason,
          origin: event.payload.origin_surface,
          service_category: event.payload.service_category,
        },
      });
      if (auditRes.error) {
        // Audit-write failure is best-effort; log + continue. The handler's
        // job (do nothing) is already done — replay will re-audit.
        this.log.warn(
          `setup_work_order.${built.reason} audit insert failed event=${event.id}: ${auditRes.error.message}`,
        );
      }
      this.log.log(
        `no_op_terminal oli=${event.aggregate_id} reason=${built.reason} event=${event.id}`,
      );
      return;
    }

    // ── 5. Atomic write (v8.1): single RPC inserts the WO + dedup row +
    //   audit row in one Postgres tx. The RPC also derives identity from
    //   the `outbox.events` row itself (§7.8.2 v8) and validates every
    //   tenant-owned FK in the row payload (validate_setup_wo_fks). On
    //   crash between this call's response and the worker marking
    //   processed_at, replay re-enters at step 3 above; the read-side
    //   dedup or the RPC's own already_created path produces the same
    //   idempotent success. ─────────────────────────────────────────────
    const rpcRes = await this.supabase.admin.rpc(
      'create_setup_work_order_from_event',
      {
        p_event_id: event.id,
        p_tenant_id: event.tenant_id,
        p_wo_row_data: built.row,
        p_idempotency_key: `setup_work_order:${event.aggregate_id}`,
      },
    );

    if (rpcRes.error) {
      throw this.classifyRpcError(rpcRes.error, event);
    }

    const out = rpcRes.data as
      | {
          kind: 'created' | 'already_created' | 'already_handled_tombstone';
          work_order_id: string | null;
        }
      | null;
    if (!out || typeof out !== 'object' || !('kind' in out)) {
      // The RPC's contract is to return {kind, work_order_id}. A null/empty
      // response is a contract bug, not a transient — but we don't have a
      // P0001/P0002 code to disambiguate, so dead-letter conservatively.
      throw new DeadLetterError(
        `create_setup_work_order_from_event returned malformed response for event=${event.id}: ${JSON.stringify(out)}`,
      );
    }
    this.log.log(
      `${out.kind} oli=${event.aggregate_id} wo=${out.work_order_id ?? 'null(tombstone)'} event=${event.id}`,
    );
  }

  /**
   * Map an `error.message` returned by `create_setup_work_order_from_event`
   * onto either a `DeadLetterError` (terminal — bypass retry, dead-letter
   * immediately) or a plain `Error` (transient — outbox retries with
   * backoff per §4.4).
   *
   * The terminal taxonomy comes from §7.8.2 v8 + v8.1:
   *
   *   - `setup_wo.event_not_found` (P0002) — the outbox row was deleted
   *     between claim and RPC call (e.g. operator purged it). No replay
   *     can fix this.
   *   - `setup_wo.event_missing_aggregate` (P0002) — the outbox row's
   *     aggregate_id is null. Producer bug; replay can't fix.
   *   - `setup_wo.oli_chain_invalid` (P0002) — the OLI / order / booking
   *     chain has a broken link or wrong tenant. Replay can't fix.
   *   - `setup_wo.row_oli_missing` (P0001) — row JSON has no
   *     linked_order_line_item_id. Builder bug; replay can't fix.
   *   - `setup_wo.row_oli_mismatch` (P0001) — row JSON's OLI id doesn't
   *     match the event's aggregate_id. Builder/handler bug; replay can't
   *     fix.
   *   - `setup_wo.row_booking_mismatch` (P0001) — row JSON's booking_id
   *     disagrees with the chain-derived booking_id. Builder bug.
   *   - `setup_wo.requester_person_id_not_allowed` (P0001) — v8.1
   *     defense, row JSON has a non-null requester_person_id. Builder
   *     bug; replay can't fix.
   *   - `setup_wo.fk_invalid: <field> <uuid>` (42501) — a tenant-owned FK
   *     in the row JSON points to an entity that doesn't exist in this
   *     tenant. Builder/data integrity bug; replay can't fix.
   *
   * Anything else (DB connection error, lock timeout, transient PG state)
   * is treated as transient and surfaces as a plain `Error` for retry.
   */
  private classifyRpcError(
    rpcError: { code?: string; message: string; details?: string | null },
    event: OutboxEvent<SetupWorkOrderPayload>,
  ): Error {
    const message = rpcError.message ?? '';
    const TERMINAL_TOKENS = [
      'setup_wo.event_not_found',
      'setup_wo.event_missing_aggregate',
      'setup_wo.oli_chain_invalid',
      'setup_wo.row_oli_missing',
      'setup_wo.row_oli_mismatch',
      'setup_wo.row_booking_mismatch',
      'setup_wo.requester_person_id_not_allowed',
      'setup_wo.fk_invalid',
    ];
    for (const token of TERMINAL_TOKENS) {
      if (message.includes(token)) {
        return new DeadLetterError(
          `create_setup_work_order_from_event terminal error for event=${event.id} oli=${event.aggregate_id}: ${message}`,
        );
      }
    }
    // Transient — worker retries with backoff (§4.4). Includes everything
    // else: 23505 unique_violation that the RPC failed to swallow,
    // connection drops, lock timeouts, etc.
    return new Error(
      `create_setup_work_order_from_event transient error for event=${event.id} oli=${event.aggregate_id}: ${message}`,
    );
  }
}
