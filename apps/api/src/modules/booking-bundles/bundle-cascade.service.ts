import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleVisibilityService, type BundleVisibilityContext } from './bundle-visibility.service';

/**
 * BundleCascadeService — cancellation orchestration per spec §5.3.
 *
 * Three entry points with distinct semantics:
 *
 *   - cancelLine(line_id)         — single order_line_item + its
 *                                   work-order ticket + its asset_reservation;
 *                                   approvals re-scoped (auto-close if scope
 *                                   drops to empty).
 *   - cancelReservation(res_id)   — smart-default cascade dialog. Fulfilled
 *                                   lines stay (greyed in UI); bundle stays
 *                                   alive if anything non-fulfilled remains.
 *   - cancelBundle(bundle_id)     — full cascade. The bundle = "this whole
 *                                   event". Same fulfilled-line protection.
 *
 * Fulfilled lines (`order_line_items.fulfillment_status` past 'confirmed')
 * are protected — caller must surface them as "cannot cancel".
 *
 * Recurring scope cancel reuses the existing `RecurrenceService.cancelForward`
 * via `recurrence_scope` argument — see Task 27 for the materialiser hook.
 * For v1 we cancel only the master occurrence's bundle; series-level cancel
 * is the same as cancelling the recurrence_series_id reservations chain.
 */

export type CancelScope = 'this' | 'this_and_following' | 'series';

export interface CancelLineArgs {
  line_id: string;
  /** Caller-supplied for audit trail. Optional. */
  reason?: string;
}

export interface CancelBundleArgs {
  bundle_id: string;
  /** Lines to keep alive — everything else cancels. Empty = cancel all. */
  keep_line_ids?: string[];
  recurrence_scope?: CancelScope;
  reason?: string;
}

@Injectable()
export class BundleCascadeService {
  private readonly log = new Logger(BundleCascadeService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly visibility: BundleVisibilityService,
  ) {}

  /**
   * Cancel a single line item + downstream work-order ticket + asset
   * reservation. Updates approvals' scope_breakdown by removing the line
   * from each row's `order_line_item_ids`; if a row's full scope drops to
   * empty, mark it as cancelled.
   */
  async cancelLine(args: CancelLineArgs, ctx: BundleVisibilityContext): Promise<{
    line_id: string;
    cascaded: { ticket_ids: string[]; asset_reservation_ids: string[] };
    closed_approval_ids: string[];
  }> {
    const tenantId = TenantContext.current().id;
    const line = await this.loadLine(args.line_id, tenantId);
    if (!line) throw new NotFoundException({ code: 'line_not_found', message: `Line ${args.line_id} not found.` });
    if (line.bundle_id) {
      const bundle = await this.loadBundle(line.bundle_id, tenantId);
      if (bundle) await this.visibility.assertVisible(bundle, ctx);
    }

    // Fulfilled-line protection.
    if (FULFILLED_STATUSES.has(line.fulfillment_status ?? '')) {
      throw new ForbiddenException({
        code: 'line_already_fulfilled',
        message: 'This line has been fulfilled and cannot be cancelled. Contact the fulfillment team.',
      });
    }

    // Cancel asset reservation, work-order ticket, then the line.
    const cascaded = { ticket_ids: [] as string[], asset_reservation_ids: [] as string[] };
    if (line.linked_asset_reservation_id) {
      await this.supabase.admin
        .from('asset_reservations')
        .update({ status: 'cancelled' })
        .eq('id', line.linked_asset_reservation_id);
      cascaded.asset_reservation_ids.push(line.linked_asset_reservation_id);
    }
    if (line.linked_ticket_id) {
      await this.supabase.admin
        .from('tickets')
        .update({ status_category: 'closed', resolution: 'cancelled' })
        .eq('id', line.linked_ticket_id);
      cascaded.ticket_ids.push(line.linked_ticket_id);
    }

    await this.supabase.admin
      .from('order_line_items')
      .update({ fulfillment_status: 'cancelled' })
      .eq('id', args.line_id);

    // Re-scope approvals: drop this line from scope_breakdown.order_line_item_ids;
    // close any approval whose scope drops to empty.
    const closedApprovalIds = line.bundle_id
      ? await this.rescopeApprovalsAfterLineCancel(line.bundle_id, args.line_id)
      : [];

    void this.audit(tenantId, 'order.line_cancelled', {
      line_id: args.line_id,
      bundle_id: line.bundle_id,
      ticket_ids: cascaded.ticket_ids,
      asset_reservation_ids: cascaded.asset_reservation_ids,
      closed_approval_ids: closedApprovalIds,
      reason: args.reason ?? null,
    });

    return { line_id: args.line_id, cascaded, closed_approval_ids: closedApprovalIds };
  }

  /**
   * Full bundle cancel with optional opt-out via `keep_line_ids`. The bundle
   * row stays put for audit/history — its derived `status_rollup` becomes
   * 'cancelled' or 'partially_cancelled' once the underlying entities flip.
   */
  async cancelBundle(args: CancelBundleArgs, ctx: BundleVisibilityContext): Promise<{
    bundle_id: string;
    cancelled_line_ids: string[];
    cancelled_reservation_ids: string[];
    cancelled_ticket_ids: string[];
    cancelled_asset_reservation_ids: string[];
    closed_approval_ids: string[];
    fulfilled_line_ids: string[];
  }> {
    return this.cancelBundleImpl(args, { ctx });
  }

  /**
   * Internal cascade — used when ReservationService.cancelOne already
   * validated the user can cancel the reservation, so visibility is
   * implicit. Reservations with bundles call this so the bundle's orders,
   * lines, work-order tickets, asset reservations and pending approvals
   * cascade alongside the reservation cancel.
   *
   * Best-effort: a failure here is logged but doesn't fail the reservation
   * cancel that already committed.
   */
  async cancelBundleInternal(args: CancelBundleArgs): Promise<void> {
    try {
      await this.cancelBundleImpl(args, { skipVisibility: true });
    } catch (err) {
      this.log.warn(
        `internal bundle cascade failed for ${args.bundle_id}: ${(err as Error).message}`,
      );
    }
  }

  private async cancelBundleImpl(
    args: CancelBundleArgs,
    auth: { ctx?: BundleVisibilityContext; skipVisibility?: boolean },
  ): Promise<{
    bundle_id: string;
    cancelled_line_ids: string[];
    cancelled_reservation_ids: string[];
    cancelled_ticket_ids: string[];
    cancelled_asset_reservation_ids: string[];
    closed_approval_ids: string[];
    fulfilled_line_ids: string[];
  }> {
    const tenantId = TenantContext.current().id;
    const bundle = await this.loadBundle(args.bundle_id, tenantId);
    if (!bundle) throw new NotFoundException({ code: 'bundle_not_found', message: `Bundle ${args.bundle_id} not found.` });
    if (!auth.skipVisibility && auth.ctx) {
      await this.visibility.assertVisible(bundle, auth.ctx);
    }

    const keep = new Set(args.keep_line_ids ?? []);

    // Pull every linked line; partition into fulfilled (untouched) +
    // kept (untouched per opt-out) + cancellable.
    const { data: lines, error: linesErr } = await this.supabase.admin
      .from('order_line_items')
      .select(`
        id,
        fulfillment_status,
        linked_asset_reservation_id,
        linked_ticket_id,
        order_id
      `)
      .in('order_id', await this.orderIdsForBundle(args.bundle_id));
    if (linesErr) throw linesErr;

    const fulfilledLineIds: string[] = [];
    const cancellableLines: Array<{
      id: string;
      linked_asset_reservation_id: string | null;
      linked_ticket_id: string | null;
    }> = [];
    for (const row of (lines ?? []) as Array<{
      id: string;
      fulfillment_status: string | null;
      linked_asset_reservation_id: string | null;
      linked_ticket_id: string | null;
    }>) {
      if (FULFILLED_STATUSES.has(row.fulfillment_status ?? '')) {
        fulfilledLineIds.push(row.id);
        continue;
      }
      if (keep.has(row.id)) continue;
      cancellableLines.push(row);
    }

    const cancelledLineIds = cancellableLines.map((l) => l.id);
    const cancelledTicketIds = cancellableLines
      .map((l) => l.linked_ticket_id)
      .filter((id): id is string => Boolean(id));
    const cancelledAssetReservationIds = cancellableLines
      .map((l) => l.linked_asset_reservation_id)
      .filter((id): id is string => Boolean(id));

    if (cancelledAssetReservationIds.length > 0) {
      await this.supabase.admin
        .from('asset_reservations')
        .update({ status: 'cancelled' })
        .in('id', cancelledAssetReservationIds);
    }
    if (cancelledTicketIds.length > 0) {
      await this.supabase.admin
        .from('tickets')
        .update({ status_category: 'closed', resolution: 'cancelled' })
        .in('id', cancelledTicketIds);
    }
    if (cancelledLineIds.length > 0) {
      await this.supabase.admin
        .from('order_line_items')
        .update({ fulfillment_status: 'cancelled' })
        .in('id', cancelledLineIds);
    }

    // Cancel the reservation only when nothing remains alive (no fulfilled
    // lines AND no kept lines). Otherwise the room stays booked for the
    // lines that are still going.
    const cancelledReservationIds: string[] = [];
    const everythingCancelled = fulfilledLineIds.length === 0 && keep.size === 0;
    if (everythingCancelled && bundle.primary_reservation_id) {
      await this.supabase.admin
        .from('reservations')
        .update({ status: 'cancelled' })
        .eq('id', bundle.primary_reservation_id);
      cancelledReservationIds.push(bundle.primary_reservation_id);
    }

    // Cancel pending approvals for this bundle.
    const closedApprovalIds = await this.cancelPendingApprovalsForBundle(args.bundle_id);

    void this.audit(tenantId, 'bundle.cancelled', {
      bundle_id: args.bundle_id,
      cancelled_line_ids: cancelledLineIds,
      cancelled_reservation_ids: cancelledReservationIds,
      cancelled_ticket_ids: cancelledTicketIds,
      cancelled_asset_reservation_ids: cancelledAssetReservationIds,
      closed_approval_ids: closedApprovalIds,
      fulfilled_line_ids: fulfilledLineIds,
      reason: args.reason ?? null,
      recurrence_scope: args.recurrence_scope ?? 'this',
    });

    return {
      bundle_id: args.bundle_id,
      cancelled_line_ids: cancelledLineIds,
      cancelled_reservation_ids: cancelledReservationIds,
      cancelled_ticket_ids: cancelledTicketIds,
      cancelled_asset_reservation_ids: cancelledAssetReservationIds,
      closed_approval_ids: closedApprovalIds,
      fulfilled_line_ids: fulfilledLineIds,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadLine(id: string, tenantId: string): Promise<{
    id: string;
    fulfillment_status: string | null;
    linked_asset_reservation_id: string | null;
    linked_ticket_id: string | null;
    order_id: string;
    bundle_id: string | null;
  } | null> {
    const { data, error } = await this.supabase.admin
      .from('order_line_items')
      .select('id, fulfillment_status, linked_asset_reservation_id, linked_ticket_id, order_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as {
      id: string;
      fulfillment_status: string | null;
      linked_asset_reservation_id: string | null;
      linked_ticket_id: string | null;
      order_id: string;
    };
    // Walk to bundle_id via orders.
    const { data: order, error: orderErr } = await this.supabase.admin
      .from('orders')
      .select('booking_bundle_id')
      .eq('id', row.order_id)
      .maybeSingle();
    if (orderErr) throw orderErr;
    return {
      ...row,
      bundle_id: (order as { booking_bundle_id: string | null } | null)?.booking_bundle_id ?? null,
    };
  }

  private async loadBundle(id: string, tenantId: string): Promise<{
    id: string;
    requester_person_id: string;
    host_person_id: string | null;
    location_id: string;
    primary_reservation_id: string | null;
  } | null> {
    const { data, error } = await this.supabase.admin
      .from('booking_bundles')
      .select('id, requester_person_id, host_person_id, location_id, primary_reservation_id')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    return (data as {
      id: string;
      requester_person_id: string;
      host_person_id: string | null;
      location_id: string;
      primary_reservation_id: string | null;
    } | null) ?? null;
  }

  private async orderIdsForBundle(bundleId: string): Promise<string[]> {
    const { data, error } = await this.supabase.admin
      .from('orders')
      .select('id')
      .eq('booking_bundle_id', bundleId);
    if (error) throw error;
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  private async rescopeApprovalsAfterLineCancel(
    bundleId: string,
    cancelledLineId: string,
  ): Promise<string[]> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('id, scope_breakdown')
      .eq('tenant_id', tenantId)
      .eq('target_entity_id', bundleId)
      .eq('status', 'pending');
    if (error) throw error;

    const closed: string[] = [];
    for (const row of (data ?? []) as Array<{ id: string; scope_breakdown: Record<string, unknown> }>) {
      const scope = (row.scope_breakdown ?? {}) as { order_line_item_ids?: string[]; reasons?: unknown };
      const newLines = (scope.order_line_item_ids ?? []).filter((id) => id !== cancelledLineId);
      const updated: Record<string, unknown> = { ...scope, order_line_item_ids: newLines };

      // If the entire scope (across all entity arrays) is empty, the approval
      // covers nothing — close it.
      const stillCovers = ENTITY_KEYS.some((key) => {
        const arr = (updated[key] as string[] | undefined) ?? [];
        return arr.length > 0;
      });
      if (!stillCovers) {
        await this.supabase.admin
          .from('approvals')
          .update({ status: 'expired', responded_at: new Date().toISOString(), comments: 'Auto-closed after scope drop' })
          .eq('id', row.id);
        closed.push(row.id);
      } else {
        await this.supabase.admin
          .from('approvals')
          .update({ scope_breakdown: updated })
          .eq('id', row.id);
      }
    }
    return closed;
  }

  private async cancelPendingApprovalsForBundle(bundleId: string): Promise<string[]> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('target_entity_id', bundleId)
      .eq('status', 'pending');
    if (error) throw error;
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return [];
    await this.supabase.admin
      .from('approvals')
      .update({ status: 'expired', responded_at: new Date().toISOString(), comments: 'Bundle cancelled; voiding approval' })
      .in('id', ids);
    return ids;
  }

  private async audit(tenantId: string, eventType: string, details: Record<string, unknown>) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: 'booking_bundle',
        entity_id: (details.bundle_id as string) ?? null,
        details,
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

const FULFILLED_STATUSES = new Set(['confirmed', 'preparing', 'delivered']);
const ENTITY_KEYS = [
  'reservation_ids',
  'order_ids',
  'order_line_item_ids',
  'ticket_ids',
  'asset_reservation_ids',
] as const;
