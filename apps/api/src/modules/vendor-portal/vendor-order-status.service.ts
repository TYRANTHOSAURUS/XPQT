import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { VendorPortalEventType } from './event-types';

/**
 * Vendor-facing status transitions on order_line_items.
 *
 * State machine (per spec §6):
 *
 *      ordered ──▶ confirmed ──▶ preparing ──▶ en_route ──▶ delivered
 *         │           │             │            │
 *         └───────────┴─────────────┴────────────┴────▶ cancelled (decline)
 *
 * Forward-only between non-terminal states. Vendor cannot reverse a step
 * (delivered → preparing is admin-only via the desk surface). The decline
 * path can fire from any non-terminal state and ends at cancelled with a
 * captured reason + requires_phone_followup flag for desk attention.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §6.
 */
@Injectable()
export class VendorOrderStatusService {
  constructor(
    private readonly db: DbService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  /**
   * Forward-only state machine. **Immediate-next only**, plus ONE explicit
   * carve-out for the "I accept + immediately mark complete" one-tap UX
   * (ordered → delivered).
   *
   * Codex Sprint 3 fix: an earlier draft allowed arbitrary forward jumps
   * (ordered → en_route, confirmed → delivered, etc.). That collapsed the
   * audit timeline + let a malicious or buggy client falsify operational
   * milestones. Tighten: only the next step. Spec §6's one-tap UX still
   * works — the UI dispatches one transition per click.
   */
  private static readonly ALLOWED_FORWARD: Record<string, ReadonlyArray<string>> = {
    ordered:    ['confirmed', 'delivered'],     // confirmed = the next step; delivered = the explicit one-tap-complete carve-out
    confirmed:  ['preparing'],
    preparing:  ['en_route'],
    en_route:   ['delivered'],
    // delivered + cancelled are terminal for the vendor.
  };

  /**
   * Vendor updates the status of every line they own on the order. Atomic:
   * either every line transitions or none does. Reject when:
   *   - the order isn't visible to this vendor (404)
   *   - any of the vendor's lines is in a state from which the requested
   *     transition is invalid (400)
   *   - the new status equals the current status (400 — no-op)
   */
  async updateStatus(input: UpdateStatusInput): Promise<UpdateStatusResult> {
    const { tenantId, vendorId, orderId, newStatus, note, vendorUserId } = input;

    if (!isVendorTransitionStatus(newStatus)) {
      throw new BadRequestException(`Invalid status: ${newStatus}`);
    }

    return this.db.tx(async (client) => {
      // Snapshot the vendor's lines on this order. Lock them so a parallel
      // status request can't drift.
      const linesResult = await client.query<{ id: string; fulfillment_status: string; tenant_id: string }>(
        `select id, fulfillment_status, tenant_id
           from order_line_items
          where order_id = $1
            and tenant_id = $2
            and vendor_id = $3
            and recurrence_skipped is not true
          for update`,
        [orderId, tenantId, vendorId],
      );
      const lines = linesResult.rows;
      if (lines.length === 0) {
        throw new NotFoundException('Order not found');
      }

      // Validate the transition for every line. We allow heterogeneous
      // starting states (e.g. line 1 ordered, line 2 preparing) as long
      // as ALL lines can legally advance to newStatus.
      const invalid: Array<{ id: string; from: string }> = [];
      for (const line of lines) {
        if (line.fulfillment_status === newStatus) continue;          // no-op for already-there lines
        const allowed: ReadonlyArray<string> = VendorOrderStatusService.ALLOWED_FORWARD[line.fulfillment_status] ?? [];
        if (!allowed.includes(newStatus)) {
          invalid.push({ id: line.id, from: line.fulfillment_status });
        }
      }
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Cannot transition to ${newStatus}: ${invalid.length} line(s) in incompatible state ` +
          `(${[...new Set(invalid.map((l) => l.from))].join(', ')})`,
        );
      }

      // Apply the transition. UPDATE returns the lines that actually changed
      // — the per-line status_events rows below get the right from_status.
      const updated = await client.query<{ id: string; prior_status: string }>(
        `update order_line_items
            set fulfillment_status = $4,
                updated_at         = now()
          where order_id = $1
            and tenant_id = $2
            and vendor_id = $3
            and recurrence_skipped is not true
            and fulfillment_status <> $4
          returning id, fulfillment_status as prior_status`,
        [orderId, tenantId, vendorId, newStatus],
      );

      // The RETURNING clause above gives us the post-update status (which
      // is `newStatus` for every row that changed). To capture the *prior*
      // status per line we re-derive from the snapshot taken under FOR UPDATE.
      const priorByLine = new Map(lines.map((l) => [l.id, l.fulfillment_status]));

      // One status_events row per line that actually changed.
      for (const row of updated.rows) {
        const fromStatus = priorByLine.get(row.id) ?? null;
        await client.query(
          `insert into vendor_order_status_events
             (tenant_id, order_line_item_id, from_status, to_status,
              actor_kind, actor_vendor_user_id, reason)
           values ($1, $2, $3, $4, 'vendor_user', $5, $6)`,
          [tenantId, row.id, fromStatus, newStatus, vendorUserId ?? null, note ?? null],
        );
      }

      // Audit taxonomy distinction (codex Sprint 3 fix): acknowledgement
      // (confirmed = spec "received") gets its own event type so "vendor
      // accepted the order" is queryable separately from later progress
      // states. Without this, every consumer has to inspect details.to_status.
      const eventType = newStatus === 'confirmed'
        ? VendorPortalEventType.OrderAcknowledged
        : VendorPortalEventType.OrderStatusUpdated;

      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType,
        entityType: 'orders',
        entityId: orderId,
        details: {
          vendor_id: vendorId,
          vendor_user_id: vendorUserId,
          to_status: newStatus,
          line_count: updated.rowCount,
          note: note ?? null,
        },
      });

      return {
        order_id: orderId,
        to_status: newStatus,
        lines_updated: updated.rowCount ?? 0,
      };
    });
  }

  /**
   * Vendor declines an order they cannot fulfill. Marks every line as
   * cancelled, captures the reason, sets requires_phone_followup so desk
   * picks it up. Cascade routing (auto-route to fallback vendor) is
   * controlled by tenant config + lives in a downstream slice — per
   * open-questions §VP8 the v1 default is "manual desk handling."
   */
  async decline(input: DeclineInput): Promise<DeclineResult> {
    const { tenantId, vendorId, orderId, reason, vendorUserId } = input;

    if (!reason || reason.trim().length < 8) {
      throw new BadRequestException('Decline reason required (>=8 chars).');
    }

    return this.db.tx(async (client) => {
      const linesResult = await client.query<{ id: string; fulfillment_status: string }>(
        `select id, fulfillment_status
           from order_line_items
          where order_id = $1
            and tenant_id = $2
            and vendor_id = $3
            and recurrence_skipped is not true
          for update`,
        [orderId, tenantId, vendorId],
      );
      const lines = linesResult.rows;
      if (lines.length === 0) {
        throw new NotFoundException('Order not found');
      }

      // Already-terminal lines (delivered / cancelled) can't be declined.
      const terminal = lines.filter((l) => l.fulfillment_status === 'delivered' || l.fulfillment_status === 'cancelled');
      if (terminal.length > 0) {
        throw new BadRequestException(
          `Cannot decline: ${terminal.length} line(s) already in terminal state ` +
          `(${[...new Set(terminal.map((l) => l.fulfillment_status))].join(', ')})`,
        );
      }

      const trimmedReason = reason.trim();

      const updated = await client.query<{ id: string }>(
        `update order_line_items
            set fulfillment_status      = 'cancelled',
                requires_phone_followup = true,
                updated_at              = now()
          where order_id = $1
            and tenant_id = $2
            and vendor_id = $3
            and recurrence_skipped is not true
            and fulfillment_status not in ('delivered','cancelled')
          returning id`,
        [orderId, tenantId, vendorId],
      );

      const priorByLine = new Map(lines.map((l) => [l.id, l.fulfillment_status]));
      for (const row of updated.rows) {
        await client.query(
          `insert into vendor_order_status_events
             (tenant_id, order_line_item_id, from_status, to_status,
              actor_kind, actor_vendor_user_id, reason)
           values ($1, $2, $3, 'cancelled', 'vendor_user', $4, $5)`,
          [tenantId, row.id, priorByLine.get(row.id) ?? null, vendorUserId ?? null, trimmedReason],
        );
      }

      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType: VendorPortalEventType.OrderDeclined,
        entityType: 'orders',
        entityId: orderId,
        details: {
          vendor_id: vendorId,
          vendor_user_id: vendorUserId,
          reason: trimmedReason,
          line_count: updated.rowCount,
        },
      });

      return {
        order_id: orderId,
        to_status: 'cancelled' as const,
        lines_declined: updated.rowCount ?? 0,
        requires_phone_followup: true,
      };
    });
  }

  /**
   * Recent status events for an order — used by the desk-side surface
   * + portal audit-of-self view. Read-only.
   */
  async listEventsForOrder(input: ListEventsInput): Promise<VendorOrderStatusEvent[]> {
    const { tenantId, vendorId, orderId } = input;
    return this.db.queryMany<VendorOrderStatusEvent>(
      `select e.id, e.order_line_item_id, e.from_status, e.to_status,
              e.actor_kind, e.actor_vendor_user_id, e.actor_tenant_user_id,
              e.reason, e.metadata, e.occurred_at
         from vendor_order_status_events e
         join order_line_items oli
           on oli.id = e.order_line_item_id
          and oli.tenant_id = e.tenant_id
        where e.tenant_id = $1
          and oli.order_id = $2
          and oli.vendor_id = $3
        order by e.occurred_at desc, e.id desc
        limit 100`,
      [tenantId, orderId, vendorId],
    );
  }
}

// =====================================================================
// helpers + types
// =====================================================================

/** Statuses a vendor may transition TO via the portal. */
export type VendorTransitionStatus =
  | 'confirmed'
  | 'preparing'
  | 'en_route'
  | 'delivered';

const VENDOR_TRANSITION_STATUSES: ReadonlySet<string> = new Set([
  'confirmed', 'preparing', 'en_route', 'delivered',
]);

export function isVendorTransitionStatus(s: string): s is VendorTransitionStatus {
  return VENDOR_TRANSITION_STATUSES.has(s);
}

export interface UpdateStatusInput {
  tenantId: string;
  vendorId: string;
  orderId: string;
  newStatus: string;
  note?: string | null;
  vendorUserId?: string | null;
}

export interface UpdateStatusResult {
  order_id: string;
  to_status: string;
  lines_updated: number;
}

export interface DeclineInput {
  tenantId: string;
  vendorId: string;
  orderId: string;
  reason: string;
  vendorUserId?: string | null;
}

export interface DeclineResult {
  order_id: string;
  to_status: 'cancelled';
  lines_declined: number;
  requires_phone_followup: boolean;
}

export interface ListEventsInput {
  tenantId: string;
  vendorId: string;
  orderId: string;
}

export interface VendorOrderStatusEvent {
  id: string;
  order_line_item_id: string;
  from_status: string | null;
  to_status: string;
  actor_kind: 'vendor_user' | 'tenant_user' | 'system' | 'inferred';
  actor_vendor_user_id: string | null;
  actor_tenant_user_id: string | null;
  reason: string | null;
  metadata: unknown;
  occurred_at: string;
}
