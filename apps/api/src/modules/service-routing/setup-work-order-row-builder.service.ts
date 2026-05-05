import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import type { OutboxEvent } from '../outbox/outbox.types';

/**
 * SetupWorkOrderRowBuilder — TS-side row-data assembly for the
 * `setup_work_order.create_required` outbox handler. Spec §7.7 (v7) of
 * docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
 *
 * Why this exists. Pre-v7 the outbox handler called
 * `SetupWorkOrderTriggerService.triggerStrict`, which inserted the
 * work_orders row via supabase-js (one HTTP call → one tx) AND then
 * inserted the dedup row in `setup_work_order_emissions` via a SECOND
 * HTTP call (a second tx). Crash between commits → duplicate WO on
 * replay. v7 introduces `create_setup_work_order_from_event` (RPC) which
 * inserts the WO + dedup row + audit row atomically inside one Postgres
 * transaction. The TS handler's responsibility shrinks to "build the row
 * payload, hand to the RPC".
 *
 * **This is a pure builder.** It calls `resolve_setup_routing` (an RPC
 * that returns matrix routing — team, lead-time, SLA policy) and
 * computes the lead-time math, but it never INSERTs. The atomic write is
 * the RPC's job.
 *
 * Failure posture:
 *   - `kind: 'wo_data'` — all inputs valid, hand to the RPC.
 *   - `kind: 'no_op_terminal'` — terminal misconfiguration (no routing
 *     row, invalid window, config disabled). Outbox handler treats this
 *     as "processed, do nothing"; admin reconfigures + a future replay
 *     re-evaluates.
 *   - THROWS on transient errors (RPC error, NaN math fault). Outbox
 *     worker treats throws as transient and retries with backoff (§4.4).
 *
 * v8.1 invariant: `requester_person_id` MUST be NULL on the row data —
 * setup WOs are operational tasks, not requester-facing artifacts.
 * Surfacing them in the requester portal "My Requests" view is a
 * cross-tenant leak risk because `persons.id` is tenant-owned. The
 * `validate_setup_wo_fks` helper (B.0.A.4) enforces this on the SQL
 * side; the row-builder here also defends by hard-coding `null`.
 */

/** Outcome of `build()` — either ready-to-RPC row data, or terminal no-op. */
export type SetupWorkOrderRowBuildResult =
  | { kind: 'wo_data'; row: SetupWorkOrderRowData }
  | { kind: 'no_op_terminal'; reason: 'no_routing_match' | 'invalid_window' | 'config_disabled' };

/**
 * Row-data shape consumed by the `create_setup_work_order_from_event`
 * RPC. Mirrors the `insertRow` at `ticket.service.ts:1875-1900` so the
 * RPC body can pass-through to a `work_orders` INSERT without
 * per-column rename discipline. The RPC also writes audit rows from
 * `audit_metadata`.
 *
 * Spec §7.7 + §7.8.2 (v8 — derives identity from outbox.events row, not
 * from this jsonb).
 */
export interface SetupWorkOrderRowData {
  parent_kind: 'booking';
  parent_ticket_id: null;
  booking_id: string;
  linked_order_line_item_id: string;
  title: string;
  description: string | null;
  priority: string;
  interaction_mode: 'internal';
  status: 'new';
  status_category: 'new' | 'assigned';
  /**
   * MUST be null — operational task, not requester-facing. Spec §7.8.2
   * v8.1 + `validate_setup_wo_fks`. Forging a `persons.id` here would
   * leak the WO into a cross-tenant requester portal.
   */
  requester_person_id: null;
  location_id: string | null;
  assigned_team_id: string | null;
  assigned_user_id: null;
  assigned_vendor_id: null;
  sla_id: string | null;
  sla_resolution_due_at: string | null;
  source_channel: 'system';
  audit_metadata: {
    triggered_by_rule_ids: string[];
    lead_time_minutes: number;
    service_window_start_at: string;
    service_category: string;
    sla_policy_id: string | null;
    origin: string;
  };
}

/** Outbox payload shape for `setup_work_order.create_required` events. */
export interface SetupWorkOrderPayload {
  booking_id: string;
  oli_id: string;
  service_category: string;
  service_window_start_at: string;
  location_id: string | null;
  rule_ids: string[];
  lead_time_override_minutes: number | null;
  origin_surface: 'bundle' | 'order';
  /**
   * Defense-in-depth: the producer (combined RPC) gates emission on
   * `any_pending_approval=false`, but the handler reads this anyway and
   * skips if true so a misbehaving producer can't bypass.
   */
  requires_approval: boolean;
}

/** Builder input — canonicalises the outbox event payload + tenant. */
export interface SetupWorkOrderBuildArgs {
  tenant_id: string;
  booking_id: string;
  oli_id: string;
  service_category: string;
  service_window_start_at: string;
  location_id: string | null;
  rule_ids: string[];
  lead_time_override_minutes: number | null;
  origin_surface: 'bundle' | 'order';
}

@Injectable()
export class SetupWorkOrderRowBuilder {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Pure builder: routing matrix lookup + lead-time math + row payload
   * assembly. No INSERTs.
   *
   * Call sites:
   *   - `SetupWorkOrderHandler.handle` — production path.
   *   - `SetupWorkOrderHandler.dryRun` — Phase A shadow comparison
   *     (compares to the inline-path's actual outcome via
   *     `outbox_shadow_results`).
   */
  async build(args: SetupWorkOrderBuildArgs): Promise<SetupWorkOrderRowBuildResult> {
    // 1. Routing matrix lookup. RPC error → throw (transient, retry).
    //    Empty / unconfigured row → terminal no-op.
    const { data: routing, error: routingErr } = await this.supabase.admin.rpc(
      'resolve_setup_routing',
      {
        p_tenant_id: args.tenant_id,
        p_location_id: args.location_id,
        p_service_category: args.service_category,
      },
    );
    if (routingErr) {
      throw new Error(`resolve_setup_routing: ${routingErr.message}`);
    }
    const row = (routing as Array<{
      internal_team_id: string | null;
      default_lead_time_minutes: number;
      sla_policy_id: string | null;
    }> | null)?.[0];
    if (!row || !row.internal_team_id) {
      return { kind: 'no_op_terminal', reason: 'no_routing_match' };
    }

    // 2. Lead-time math. Invalid window is a terminal data fault — we
    //    can't make a WO with a NaN due_at and retrying won't help.
    const leadTime = args.lead_time_override_minutes ?? row.default_lead_time_minutes;
    const startMs = new Date(args.service_window_start_at).getTime();
    if (!Number.isFinite(startMs)) {
      return { kind: 'no_op_terminal', reason: 'invalid_window' };
    }
    const targetDueAt = new Date(startMs - leadTime * 60_000).toISOString();

    // 3. Build the row payload. requester_person_id is hard-coded NULL
    //    per §7.8.2 v8.1 + validate_setup_wo_fks.
    return {
      kind: 'wo_data',
      row: {
        parent_kind: 'booking',
        parent_ticket_id: null,
        booking_id: args.booking_id,
        linked_order_line_item_id: args.oli_id,
        title: `Internal setup — ${args.service_category}`,
        description: null,
        priority: 'medium',
        interaction_mode: 'internal',
        status: 'new',
        status_category: 'assigned',
        requester_person_id: null,
        location_id: args.location_id,
        assigned_team_id: row.internal_team_id,
        assigned_user_id: null,
        assigned_vendor_id: null,
        sla_id: row.sla_policy_id,
        sla_resolution_due_at: targetDueAt,
        source_channel: 'system',
        audit_metadata: {
          triggered_by_rule_ids: args.rule_ids,
          lead_time_minutes: leadTime,
          service_window_start_at: args.service_window_start_at,
          service_category: args.service_category,
          sla_policy_id: row.sla_policy_id,
          origin: args.origin_surface,
        },
      },
    };
  }

  /**
   * Convenience for outbox handlers — extracts the canonical args from an
   * `OutboxEvent<SetupWorkOrderPayload>`. The handler still owns
   * tenant-mismatch defense + the read-side dedup; this only builds the
   * row payload from the payload + tenant.
   */
  buildFromEvent(
    event: OutboxEvent<SetupWorkOrderPayload>,
  ): Promise<SetupWorkOrderRowBuildResult> {
    return this.build({
      tenant_id: event.tenant_id,
      booking_id: event.payload.booking_id,
      oli_id: event.payload.oli_id,
      service_category: event.payload.service_category,
      service_window_start_at: event.payload.service_window_start_at,
      location_id: event.payload.location_id,
      rule_ids: event.payload.rule_ids,
      lead_time_override_minutes: event.payload.lead_time_override_minutes,
      origin_surface: event.payload.origin_surface,
    });
  }
}
