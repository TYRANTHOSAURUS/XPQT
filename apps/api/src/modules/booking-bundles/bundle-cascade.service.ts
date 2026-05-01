import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleEventBus, type BundleEvent } from './bundle-event-bus';
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
  /**
   * When set, restricts the cascade to orders whose `linked_reservation_id`
   * matches. Used by recurrence cancel paths so a single occurrence cancel
   * doesn't take down sibling occurrences sharing the same bundle. Omitting
   * cancels every order in the bundle (full cascade — single-occurrence /
   * non-recurring case).
   */
  reservation_id?: string;
  recurrence_scope?: CancelScope;
  reason?: string;
}

@Injectable()
export class BundleCascadeService {
  private readonly log = new Logger(BundleCascadeService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly visibility: BundleVisibilityService,
    private readonly eventBus: BundleEventBus,
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
    // Sub-project 2 only owns bundle-linked lines. A pre-bundle order line
    // (legacy /orders flow) routes through OrderService.cancel, not this
    // path — refuse so we don't silently let a tenant-mate cancel each
    // other's lines.
    if (!line.bundle_id) {
      throw new NotFoundException({
        code: 'line_not_in_bundle',
        message: `Line ${args.line_id} is not part of a bundle.`,
      });
    }
    const bundle = await this.loadBundle(line.bundle_id, tenantId);
    if (!bundle) {
      throw new NotFoundException({
        code: 'bundle_not_found',
        message: `Bundle ${line.bundle_id} not found.`,
      });
    }
    await this.visibility.assertVisible(bundle, ctx);

    // Fulfilled-line protection.
    if (FULFILLED_STATUSES.has(line.fulfillment_status ?? '')) {
      throw new ForbiddenException({
        code: 'line_already_fulfilled',
        message: 'This line has been fulfilled and cannot be cancelled. Contact the fulfillment team.',
      });
    }

    // Capture policy snapshot before mutating — needed for the bundle-event
    // emission below. Looked up here (not via loadLine) to keep that helper
    // narrow; Supabase round-trip cost is negligible vs. the cancel cascade.
    const lineKind = await this.lineKindForOli(args.line_id, tenantId);

    // Cancel asset reservation, work-order ticket, then the line.
    const cascaded = { ticket_ids: [] as string[], asset_reservation_ids: [] as string[] };
    if (line.linked_asset_reservation_id) {
      await this.supabase.admin
        .from('asset_reservations')
        .update({ status: 'cancelled' })
        .eq('id', line.linked_asset_reservation_id);
      cascaded.asset_reservation_ids.push(line.linked_asset_reservation_id);
    }
    // Cascade-cancel any booking-origin work orders linked TO this line via
    // tickets.linked_order_line_item_id (00145). Wave 2 Slice 2 enabled this:
    // the auto-creation flow (BundleService.maybeCreateSetupWorkOrder) now
    // populates linked_order_line_item_id at creation time, so the inverse
    // cascade has real data to act on. Filter NON-terminal status with an
    // explicit whitelist so already-closed tickets don't get their
    // closed_at re-stamped.
    // Non-terminal status whitelist mirrors the schema check constraints:
    //   00011 added: new, assigned, in_progress, waiting, resolved, closed
    //   00028 added: pending_approval
    // Booking-origin work orders bypass the approval gate today (no
    // request_type), so pending_approval is unreachable in practice — but
    // include defensively so a future code path that DOES land them there
    // doesn't silently bypass the cascade.
    const NON_TERMINAL_STATUSES = ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'];
    // Step 1c.4 cutover: target work_orders directly. The reverse shadow
    // trigger keeps tickets in sync. Removes the ticket_kind filter
    // (work_orders is single-kind).
    const { data: linkedTickets } = await this.supabase.admin
      .from('work_orders')
      .update({ status_category: 'closed', closed_at: new Date().toISOString() })
      .eq('linked_order_line_item_id', args.line_id)
      .eq('tenant_id', tenantId)
      .in('status_category', NON_TERMINAL_STATUSES)
      .select('id');
    if (linkedTickets) {
      for (const t of linkedTickets as Array<{ id: string }>) {
        cascaded.ticket_ids.push(t.id);
      }
    }

    // Clearing pending_setup_trigger_args (00197) alongside the cancel is
    // important: the line might be cancelled while approval-deferred. Without
    // this, a later approval grant on a SIBLING line on the same bundle
    // would re-fire the trigger for the cancelled line via
    // BundleService.onApprovalDecided.
    await this.supabase.admin
      .from('order_line_items')
      .update({
        fulfillment_status: 'cancelled',
        pending_setup_trigger_args: null,
      })
      .eq('id', args.line_id);

    // Re-scope approvals: drop the cancelled line + its linked ticket + its
    // linked asset reservation from scope_breakdown. Otherwise an approval
    // scoped to (oli, ticket, asset) would stay pending pointing at the now
    // dead ticket/asset even though the underlying work is gone.
    const closedApprovalIds = await this.rescopeApprovalsAfterLineCancel(
      line.bundle_id,
      args.line_id,
      cascaded.ticket_ids,
      cascaded.asset_reservation_ids,
    );

    void this.audit(tenantId, 'order.line_cancelled', 'order_line_item', args.line_id, {
      line_id: args.line_id,
      bundle_id: line.bundle_id,
      ticket_ids: cascaded.ticket_ids,
      asset_reservation_ids: cascaded.asset_reservation_ids,
      closed_approval_ids: closedApprovalIds,
      reason: args.reason ?? null,
    });

    // Slice 4: notify cross-module subscribers (today: visitor cascade adapter
    // in VisitorsModule). Emit AFTER all DB writes succeed; subscriber failures
    // are absorbed inside BundleEventBus listeners — see bundle-cascade.adapter
    // for the rationale.
    this.emitEvent({
      kind: 'bundle.line.cancelled',
      tenant_id: tenantId,
      bundle_id: line.bundle_id,
      line_id: args.line_id,
      line_kind: lineKind,
      occurred_at: new Date().toISOString(),
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
      .in(
        'order_id',
        await this.orderIdsForBundle(args.bundle_id, args.reservation_id),
      );
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
    const cancelledAssetReservationIds = cancellableLines
      .map((l) => l.linked_asset_reservation_id)
      .filter((id): id is string => Boolean(id));

    if (cancelledAssetReservationIds.length > 0) {
      await this.supabase.admin
        .from('asset_reservations')
        .update({ status: 'cancelled' })
        .in('id', cancelledAssetReservationIds);
    }

    // Cascade-cancel booking-origin work orders linked to any of the
    // cancelled lines (via tickets.linked_order_line_item_id, 00145).
    // Whitelist non-terminal statuses so already-closed tickets don't
    // get closed_at re-stamped. Bulk form mirrors cancelLine() above.
    // Same whitelist as cancelLine() above — kept inline since the bulk path
    // shouldn't import a constant from the per-line block (separate scopes).
    const NON_TERMINAL_STATUSES = ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'];
    let cancelledTicketIds: string[] = [];
    if (cancelledLineIds.length > 0) {
      // Step 1c.4 cutover: target work_orders directly.
      const { data: linkedTickets } = await this.supabase.admin
        .from('work_orders')
        .update({ status_category: 'closed', closed_at: new Date().toISOString() })
        .in('linked_order_line_item_id', cancelledLineIds)
        .eq('tenant_id', tenantId)
        .in('status_category', NON_TERMINAL_STATUSES)
        .select('id');
      cancelledTicketIds = (linkedTickets as Array<{ id: string }> | null)?.map((t) => t.id) ?? [];
    }
    if (cancelledLineIds.length > 0) {
      // Also clear pending_setup_trigger_args (00197) so a later approval
      // grant doesn't re-fire the trigger for cancelled lines. See the
      // single-line cancel path above for rationale.
      await this.supabase.admin
        .from('order_line_items')
        .update({
          fulfillment_status: 'cancelled',
          pending_setup_trigger_args: null,
        })
        .in('id', cancelledLineIds);
    }

    // Cancel the reservation only when nothing remains alive (no fulfilled
    // lines AND no kept lines). Otherwise the room stays booked for the
    // lines that are still going. Skip when scoped to a specific reservation
    // — the caller already cancelled that reservation, and other occurrences
    // sharing the bundle's primary_reservation_id should not be touched.
    const cancelledReservationIds: string[] = [];
    const everythingCancelled = fulfilledLineIds.length === 0 && keep.size === 0;
    if (everythingCancelled && bundle.primary_reservation_id && !args.reservation_id) {
      await this.supabase.admin
        .from('reservations')
        .update({ status: 'cancelled' })
        .eq('id', bundle.primary_reservation_id);
      cancelledReservationIds.push(bundle.primary_reservation_id);
    }

    // Approvals: if we're scoped to a single occurrence, rescope per
    // line — full cancel would void approvals that still cover other
    // occurrences in the bundle. Otherwise, cancel all pending approvals
    // (this is a whole-bundle cancel).
    let closedApprovalIds: string[] = [];
    if (args.reservation_id) {
      for (const line of cancellableLines) {
        const closed = await this.rescopeApprovalsAfterLineCancel(
          args.bundle_id,
          line.id,
          line.linked_ticket_id ? [line.linked_ticket_id] : [],
          line.linked_asset_reservation_id ? [line.linked_asset_reservation_id] : [],
        );
        closedApprovalIds.push(...closed);
      }
    } else {
      closedApprovalIds = await this.cancelPendingApprovalsForBundle(args.bundle_id);
    }

    void this.audit(tenantId, 'bundle.cancelled', 'booking_bundle', args.bundle_id, {
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

    // Slice 4: emit cross-module event for the visitor cascade adapter.
    // Skip when the cancel was scoped to a single recurrence occurrence
    // (`reservation_id` set) AND nothing was actually cancelled — the cascade
    // walked but everything was fulfilled/kept; nothing for downstream
    // subscribers to react to. Otherwise emit so the visitors module can
    // cancel/alert the linked visitor invites per spec §10.2.
    const somethingCancelled =
      cancelledLineIds.length > 0 ||
      cancelledReservationIds.length > 0 ||
      cancelledTicketIds.length > 0 ||
      cancelledAssetReservationIds.length > 0;
    if (somethingCancelled) {
      this.emitEvent({
        kind: 'bundle.cancelled',
        tenant_id: tenantId,
        bundle_id: args.bundle_id,
        occurred_at: new Date().toISOString(),
      });
    }

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
    // Walk to bundle_id via orders. Tenant-filter as defence-in-depth in
    // case a malformed line ever points at a cross-tenant order.
    const { data: order, error: orderErr } = await this.supabase.admin
      .from('orders')
      .select('booking_bundle_id')
      .eq('id', row.order_id)
      .eq('tenant_id', tenantId)
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

  private async orderIdsForBundle(
    bundleId: string,
    reservationId?: string,
  ): Promise<string[]> {
    let q = this.supabase.admin
      .from('orders')
      .select('id')
      .eq('booking_bundle_id', bundleId);
    if (reservationId) q = q.eq('linked_reservation_id', reservationId);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  /**
   * Locate the bundle (if any) that this reservation's orders belong to and
   * cascade-cancel scoped to just that reservation's orders. Used by
   * ReservationService.cancelOne and RecurrenceService.cancelForward — both
   * already validated the reservation cancel; this is the bundle cleanup.
   */
  async cancelOrdersForReservation(args: {
    reservation_id: string;
    reason?: string;
  }): Promise<void> {
    try {
      const { data, error } = await this.supabase.admin
        .from('orders')
        .select('booking_bundle_id')
        .eq('linked_reservation_id', args.reservation_id)
        .not('booking_bundle_id', 'is', null)
        .limit(1);
      if (error) throw error;
      const row = ((data ?? [])[0] as { booking_bundle_id: string | null } | undefined);
      const bundleId = row?.booking_bundle_id;
      if (!bundleId) return;
      await this.cancelBundleImpl(
        { bundle_id: bundleId, reservation_id: args.reservation_id, reason: args.reason },
        { skipVisibility: true },
      );
    } catch (err) {
      this.log.warn(
        `cancelOrdersForReservation ${args.reservation_id} failed: ${(err as Error).message}`,
      );
    }
  }

  private async rescopeApprovalsAfterLineCancel(
    bundleId: string,
    cancelledLineId: string,
    cancelledTicketIds: string[] = [],
    cancelledAssetReservationIds: string[] = [],
  ): Promise<string[]> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('id, scope_breakdown')
      .eq('tenant_id', tenantId)
      .eq('target_entity_id', bundleId)
      .eq('status', 'pending');
    if (error) throw error;

    const ticketSet = new Set(cancelledTicketIds);
    const assetSet = new Set(cancelledAssetReservationIds);
    const closed: string[] = [];
    for (const row of (data ?? []) as Array<{ id: string; scope_breakdown: Record<string, unknown> }>) {
      const scope = (row.scope_breakdown ?? {}) as {
        order_line_item_ids?: string[];
        ticket_ids?: string[];
        asset_reservation_ids?: string[];
        reasons?: unknown;
      };
      const newLines = (scope.order_line_item_ids ?? []).filter((id) => id !== cancelledLineId);
      const newTickets = (scope.ticket_ids ?? []).filter((id) => !ticketSet.has(id));
      const newAssets = (scope.asset_reservation_ids ?? []).filter(
        (id) => !assetSet.has(id),
      );
      const updated: Record<string, unknown> = {
        ...scope,
        order_line_item_ids: newLines,
        ticket_ids: newTickets,
        asset_reservation_ids: newAssets,
      };

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

  /**
   * Best-effort emit. Subscriber failures are isolated by the bus; an
   * unexpected throw (e.g. someone subscribed synchronously and threw)
   * is logged but never propagated — cancelLine/cancelBundle have already
   * mutated state, and re-throwing would mislead the caller into thinking
   * the cancel itself failed.
   */
  private emitEvent(event: BundleEvent): void {
    try {
      this.eventBus.emit(event);
    } catch (err) {
      this.log.warn(
        `bundle event emit failed for ${event.kind}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Map an order_line_items row to its bundle-event line_kind. Falls back to
   * 'other' on lookup failure — emit shape is fixed, so an unknown kind is
   * safer than dropping the event.
   */
  private async lineKindForOli(
    oliId: string,
    tenantId: string,
  ): Promise<'visitor' | 'room' | 'catering' | 'av' | 'other'> {
    try {
      const { data } = await this.supabase.admin
        .from('order_line_items')
        .select('policy_snapshot')
        .eq('id', oliId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const snapshot = (data as { policy_snapshot: Record<string, unknown> | null } | null)
        ?.policy_snapshot ?? null;
      const serviceType = (snapshot && typeof snapshot === 'object'
        ? (snapshot as { service_type?: string }).service_type
        : null) ?? null;
      if (serviceType === 'catering') return 'catering';
      if (serviceType === 'av' || serviceType === 'audiovisual') return 'av';
      // visitors aren't order_line_items in v1, so we never expect 'visitor' here.
      return 'other';
    } catch {
      return 'other';
    }
  }

  private async audit(
    tenantId: string,
    eventType: string,
    entityType: string,
    entityId: string | null,
    details: Record<string, unknown>,
  ) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: entityType,
        entity_id: entityId,
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
