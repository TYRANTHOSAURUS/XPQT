import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ApprovalRoutingService } from './approval-routing.service';
import { ServiceRuleResolverService } from '../service-catalog/service-rule-resolver.service';
import { buildServiceEvaluationContext } from '../service-catalog/service-evaluation-context';

/**
 * Per spec §5.1: at recurrence-materialisation time, each order on the
 * master reservation is cloned for the new occurrence. The per-line service
 * window is stored absolute on every row; the offset comes from the master:
 *
 *   delta = master.line.service_window_start_at − master.reservation.start_at
 *   clone.line.service_window_start_at = new_reservation.start_at + delta
 *
 * Lines with `repeats_with_series=false` stay master-only and are skipped
 * for the clone. Asset GiST exclusion fires per occurrence: if a conflict
 * occurs, the cloned line is created with `recurrence_skipped=true` and
 * `skip_reason='asset_conflict'` so siblings still materialise.
 */
export interface CloneOrderForOccurrenceArgs {
  masterOrderId: string;
  /** New occurrence's reservation row. Required for service-window math. */
  newReservation: {
    id: string;
    start_at: string;
    end_at: string;
  };
  /**
   * The master reservation's start_at — used to compute the per-line offset
   * from `service_window_start_at`. Pass the master's row directly so we
   * don't refetch.
   */
  masterReservationStartAt: string;
  /** Bundle the cloned order should attach to. Required. */
  bundleId: string;
  /** Recurrence series id to set on the clone. */
  recurrenceSeriesId: string | null;
  requesterPersonId: string;
}

export interface CloneOrderForOccurrenceResult {
  cloned_order_id: string;
  cloned_line_ids: string[];
  cloned_asset_reservation_ids: string[];
  /** Lines we marked as recurrence_skipped due to asset conflict. */
  asset_conflict_line_ids: string[];
}

/**
 * OrderService — wraps the standalone-order create path. Composite (room +
 * services) flows live in `BundleService`; this is the
 * `/portal/order` flow where there is no reservation.
 *
 * Standalone shape:
 *   - delivery_space_id (required) — picker locks to a single location
 *   - requested_for_start_at + requested_for_end_at — service window
 *   - cost_center_id (optional)
 *   - lines[] — same shape as bundle lines, minus the asset slot (parking
 *     and asset reservations require sub-project 2.5+)
 *
 * Recurrence is forward-compat only in v1 — the toggle is disabled in the
 * UI with "Coming soon". The `orders.recurrence_rule` column ships now so
 * sub-project 2.5 can switch on standalone recurrence without a migration.
 */

export interface CreateStandaloneOrderArgs {
  requester_person_id: string;
  delivery_space_id: string;
  requested_for_start_at: string;
  requested_for_end_at: string;
  cost_center_id?: string | null;
  lines: Array<{
    catalog_item_id: string;
    menu_id?: string | null;
    quantity: number;
    /** Defaults to the order window when omitted. */
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
    /** Optional asset reservation; conflict guard applies. */
    linked_asset_id?: string | null;
  }>;
  permissions?: Record<string, boolean>;
}

export interface CreateStandaloneOrderResult {
  order_id: string;
  bundle_id: string;
  order_line_item_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
  any_pending_approval: boolean;
}

@Injectable()
export class OrderService {
  private readonly log = new Logger(OrderService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ServiceRuleResolverService,
    private readonly approvalRouter: ApprovalRoutingService,
  ) {}

  /**
   * Clone an order + its line items + their asset reservations for a new
   * occurrence of a recurring booking. Called by `RecurrenceService.materialize`
   * once per new occurrence per master order.
   *
   * Lines with `repeats_with_series=false` are skipped — used for one-off
   * items the master alone needed (e.g. opening-day setup that doesn't
   * recur weekly with the standup).
   *
   * If the master line had a `linked_asset_id`, we attempt to clone the
   * asset_reservations row too. The GiST exclusion fires per occurrence;
   * a conflict marks the cloned line as recurrence_skipped without
   * blocking siblings.
   */
  async cloneOrderForOccurrence(
    args: CloneOrderForOccurrenceArgs,
  ): Promise<CloneOrderForOccurrenceResult> {
    const tenantId = TenantContext.current().id;

    const masterOrder = await this.supabase.admin
      .from('orders')
      .select('id, tenant_id, requester_person_id, delivery_location_id, policy_snapshot, recurrence_rule')
      .eq('id', args.masterOrderId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (masterOrder.error) throw masterOrder.error;
    if (!masterOrder.data) {
      throw new NotFoundException({
        code: 'master_order_not_found',
        message: `Master order ${args.masterOrderId} not found.`,
      });
    }

    // 1. Create the clone order row, scoped to the new occurrence.
    const newWindowStart = args.newReservation.start_at;
    const newWindowEnd = args.newReservation.end_at;
    const clonedOrder = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: tenantId,
        requester_person_id: args.requesterPersonId,
        booking_bundle_id: args.bundleId,
        linked_reservation_id: args.newReservation.id,
        delivery_location_id: (masterOrder.data as { delivery_location_id: string | null }).delivery_location_id,
        delivery_date: newWindowStart.slice(0, 10),
        requested_for_start_at: newWindowStart,
        requested_for_end_at: newWindowEnd,
        recurrence_series_id: args.recurrenceSeriesId,
        status: 'approved', // recurrence skips re-resolving rules in v1
        policy_snapshot: {
          ...(masterOrder.data as { policy_snapshot: Record<string, unknown> }).policy_snapshot,
          cloned_from: args.masterOrderId,
        },
      })
      .select('id')
      .single();
    if (clonedOrder.error) throw clonedOrder.error;
    const clonedOrderId = (clonedOrder.data as { id: string }).id;

    // 2. Pull master's lines that should repeat.
    const masterLines = await this.supabase.admin
      .from('order_line_items')
      .select(
        'id, catalog_item_id, quantity, unit_price, line_total, fulfillment_status, fulfillment_team_id, linked_asset_id, service_window_start_at, service_window_end_at, repeats_with_series, policy_snapshot',
      )
      .eq('order_id', args.masterOrderId)
      .eq('tenant_id', tenantId)
      .eq('repeats_with_series', true);
    if (masterLines.error) throw masterLines.error;

    const masterStartMs = Date.parse(args.masterReservationStartAt);
    const newStartMs = Date.parse(newWindowStart);
    const lineDeltaShift = (windowAt: string | null): string | null => {
      if (!windowAt) return null;
      const masterLineMs = Date.parse(windowAt);
      if (!Number.isFinite(masterLineMs) || !Number.isFinite(masterStartMs)) return null;
      const delta = masterLineMs - masterStartMs;
      return new Date(newStartMs + delta).toISOString();
    };

    const clonedLineIds: string[] = [];
    const clonedAssetReservationIds: string[] = [];
    const assetConflictLineIds: string[] = [];

    for (const line of (masterLines.data ?? []) as Array<{
      id: string;
      catalog_item_id: string;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      fulfillment_status: string | null;
      fulfillment_team_id: string | null;
      linked_asset_id: string | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      repeats_with_series: boolean;
      policy_snapshot: Record<string, unknown>;
    }>) {
      const occurrenceStart = lineDeltaShift(line.service_window_start_at);
      const occurrenceEnd = lineDeltaShift(line.service_window_end_at);

      // 3a. Try to clone the asset reservation if the master had one.
      let clonedAssetReservationId: string | null = null;
      let assetConflicted = false;
      if (line.linked_asset_id) {
        const assetStart = occurrenceStart ?? newWindowStart;
        const assetEnd = occurrenceEnd ?? newWindowEnd;
        const ar = await this.supabase.admin
          .from('asset_reservations')
          .insert({
            tenant_id: tenantId,
            asset_id: line.linked_asset_id,
            start_at: assetStart,
            end_at: assetEnd,
            status: 'confirmed',
            requester_person_id: args.requesterPersonId,
            booking_bundle_id: args.bundleId,
          })
          .select('id')
          .single();
        if (ar.error) {
          if ((ar.error as { code?: string }).code === '23P01') {
            assetConflicted = true;
          } else {
            throw ar.error;
          }
        } else {
          clonedAssetReservationId = (ar.data as { id: string }).id;
          clonedAssetReservationIds.push(clonedAssetReservationId);
        }
      }

      // 3b. Insert the cloned line. If the asset conflicted, mark this
      //     occurrence skipped without blocking the rest of the series.
      const insertRes = await this.supabase.admin
        .from('order_line_items')
        .insert({
          order_id: clonedOrderId,
          tenant_id: tenantId,
          catalog_item_id: line.catalog_item_id,
          quantity: line.quantity,
          unit_price: line.unit_price,
          line_total: line.line_total,
          fulfillment_status: assetConflicted ? 'cancelled' : 'ordered',
          fulfillment_team_id: line.fulfillment_team_id,
          linked_asset_id: line.linked_asset_id,
          linked_asset_reservation_id: clonedAssetReservationId,
          service_window_start_at: occurrenceStart,
          service_window_end_at: occurrenceEnd,
          repeats_with_series: true,
          recurrence_skipped: assetConflicted,
          skip_reason: assetConflicted ? 'asset_conflict' : null,
          policy_snapshot: {
            ...line.policy_snapshot,
            cloned_from: line.id,
          },
        })
        .select('id')
        .single();
      if (insertRes.error) throw insertRes.error;
      const newLineId = (insertRes.data as { id: string }).id;
      clonedLineIds.push(newLineId);
      if (assetConflicted) assetConflictLineIds.push(newLineId);
    }

    void this.audit(tenantId, 'order.line_cloned', {
      master_order_id: args.masterOrderId,
      new_order_id: clonedOrderId,
      bundle_id: args.bundleId,
      cloned_line_ids: clonedLineIds,
      cloned_asset_reservation_ids: clonedAssetReservationIds,
      asset_conflict_line_ids: assetConflictLineIds,
    });

    return {
      cloned_order_id: clonedOrderId,
      cloned_line_ids: clonedLineIds,
      cloned_asset_reservation_ids: clonedAssetReservationIds,
      asset_conflict_line_ids: assetConflictLineIds,
    };
  }

  /**
   * Per-occurrence override / skip / revert APIs (spec §5.2). Called from
   * the `/portal/me-bookings` drawer when the user tweaks one occurrence's
   * service line.
   *
   *   override = "use a different quantity / window for this occurrence"
   *   skip     = "no service for this occurrence"
   *   revert   = "drop the override, follow the series"
   */
  async overrideLineForOccurrence(
    lineId: string,
    patch: { quantity?: number; service_window_start_at?: string | null; service_window_end_at?: string | null },
  ): Promise<{ id: string; recurrence_overridden: true }> {
    const tenantId = TenantContext.current().id;
    const update: Record<string, unknown> = { recurrence_overridden: true };
    if (patch.quantity != null) update.quantity = Math.max(0, Math.floor(patch.quantity));
    if ('service_window_start_at' in patch) update.service_window_start_at = patch.service_window_start_at;
    if ('service_window_end_at' in patch) update.service_window_end_at = patch.service_window_end_at;
    const { error } = await this.supabase.admin
      .from('order_line_items')
      .update(update)
      .eq('id', lineId)
      .eq('tenant_id', tenantId);
    if (error) throw error;
    return { id: lineId, recurrence_overridden: true };
  }

  async skipLineForOccurrence(
    lineId: string,
    reason?: string,
  ): Promise<{ id: string; recurrence_skipped: true }> {
    const tenantId = TenantContext.current().id;
    const { error } = await this.supabase.admin
      .from('order_line_items')
      .update({
        recurrence_skipped: true,
        recurrence_overridden: true,
        skip_reason: reason ?? 'user_skipped',
        fulfillment_status: 'cancelled',
      })
      .eq('id', lineId)
      .eq('tenant_id', tenantId);
    if (error) throw error;
    return { id: lineId, recurrence_skipped: true };
  }

  async revertLineForOccurrence(
    lineId: string,
  ): Promise<{ id: string }> {
    const tenantId = TenantContext.current().id;
    const { error } = await this.supabase.admin
      .from('order_line_items')
      .update({
        recurrence_overridden: false,
        recurrence_skipped: false,
        skip_reason: null,
      })
      .eq('id', lineId)
      .eq('tenant_id', tenantId);
    if (error) throw error;
    return { id: lineId };
  }

  /**
   * `POST /orders/standalone`. Creates a services-only `booking_bundles`
   * row (no reservation), one order with N line items, asset reservations
   * for any line that requested one, and de-duped approvals.
   *
   * Why a services-only bundle? Spec §3.3: bundles are nullable on
   * `primary_reservation_id`. Sub-project 2 always sets it (because every
   * bundle attaches to a reservation). For the v1 standalone-order flow
   * we DO want a parent bundle so the cancel/audit/approval flows work
   * uniformly — we just leave `primary_reservation_id` null. This is the
   * same shape sub-project 3+ visitor-only bundles will use.
   */
  async createStandalone(args: CreateStandaloneOrderArgs): Promise<CreateStandaloneOrderResult> {
    if (args.lines.length === 0) {
      throw new BadRequestException({ code: 'no_lines', message: 'no order lines provided' });
    }
    if (Date.parse(args.requested_for_end_at) <= Date.parse(args.requested_for_start_at)) {
      throw new BadRequestException({
        code: 'invalid_window',
        message: 'requested_for_end_at must be after requested_for_start_at',
      });
    }

    const tenantId = TenantContext.current().id;
    const cleanup = new StandaloneCleanup(this.supabase);

    try {
      // 1. Create services-only bundle (primary_reservation_id stays null).
      const bundle = await this.createServicesOnlyBundle({
        tenantId,
        args,
      });
      cleanup.bundle(bundle.id);

      // 2. Create the order row.
      const order = await this.createOrder({
        tenantId,
        bundle_id: bundle.id,
        args,
      });
      cleanup.order(order.id);

      // 3. Per-line: hydrate via resolve_menu_offer, create asset
      //    reservation if requested, create line item.
      const oliIds: string[] = [];
      const assetReservationIds: string[] = [];
      type LineMeta = {
        oliId: string;
        catalog_item_id: string;
        catalog_item_category: string | null;
        menu_id: string | null;
        unit_price: number | null;
        quantity: number;
        service_window_start_at: string;
        service_window_end_at: string;
        fulfillment_vendor_id: string | null;
        fulfillment_team_id: string | null;
        lead_time_remaining_hours: number;
        asset_reservation_id: string | null;
      };
      const lineMetas: LineMeta[] = [];

      for (const input of args.lines) {
        const startAt = input.service_window_start_at ?? args.requested_for_start_at;
        const endAt = input.service_window_end_at ?? args.requested_for_end_at;

        // Resolve catalog item + menu offer.
        const [item, offer] = await Promise.all([
          this.loadCatalogItem(input.catalog_item_id),
          this.resolveOffer(input.catalog_item_id, args.delivery_space_id, args.requested_for_start_at.slice(0, 10)),
        ]);

        let assetReservationId: string | null = null;
        if (input.linked_asset_id) {
          assetReservationId = await this.createAssetReservation({
            tenantId,
            asset_id: input.linked_asset_id,
            start_at: startAt,
            end_at: endAt,
            requester_person_id: args.requester_person_id,
            bundle_id: bundle.id,
          });
          cleanup.assetReservation(assetReservationId);
          assetReservationIds.push(assetReservationId);
        }

        const oliId = await this.createLineItem({
          tenantId,
          order_id: order.id,
          input,
          item,
          offer,
          service_window_start_at: startAt,
          service_window_end_at: endAt,
          linked_asset_reservation_id: assetReservationId,
        });
        cleanup.orderLineItem(oliId);
        oliIds.push(oliId);

        const leadHours = (Date.parse(startAt) - Date.now()) / 3_600_000;
        lineMetas.push({
          oliId,
          catalog_item_id: input.catalog_item_id,
          catalog_item_category: item.category,
          menu_id: offer?.menu_id ?? input.menu_id ?? null,
          unit_price: offer?.price ?? item.price_per_unit,
          quantity: input.quantity,
          service_window_start_at: startAt,
          service_window_end_at: endAt,
          fulfillment_vendor_id: offer?.vendor_id ?? null,
          fulfillment_team_id: offer?.fulfillment_team_id ?? item.fulfillment_team_id ?? null,
          lead_time_remaining_hours: leadHours,
          asset_reservation_id: assetReservationId,
        });
      }

      // 4. Resolve service rules per line (no reservation in context).
      const totalPerOccurrence = lineMetas.reduce(
        (sum, l) => sum + (l.unit_price ?? 0) * l.quantity,
        0,
      );
      const outcomes = await this.resolver.resolveBulk({
        lines: lineMetas.map((l) => ({
          lineKey: l.oliId,
          catalog_item_id: l.catalog_item_id,
          catalog_item_category: l.catalog_item_category,
          menu_id: l.menu_id,
        })),
        contextFor: (lineKey) => {
          const meta = lineMetas.find((l) => l.oliId === lineKey)!;
          return buildServiceEvaluationContext({
            requester: {
              id: args.requester_person_id,
              role_ids: [],
              org_node_id: null,
              type: null,
              cost_center: null,
              user_id: null,
            },
            bundle: {
              id: bundle.id,
              cost_center_id: args.cost_center_id ?? null,
              template_id: null,
              attendee_count: null,
            },
            // No reservation for standalone orders. Predicate paths under
            // $.booking and $.reservation evaluate to undefined and the
            // engine treats those as no-match.
            line: {
              catalog_item_id: meta.catalog_item_id,
              catalog_item_category: meta.catalog_item_category,
              menu_id: meta.menu_id,
              quantity: meta.quantity,
              quantity_per_attendee: null,
              service_window_start_at: meta.service_window_start_at,
              service_window_end_at: meta.service_window_end_at,
              unit_price: meta.unit_price,
              lead_time_remaining_hours: meta.lead_time_remaining_hours,
              menu: {
                fulfillment_vendor_id: meta.fulfillment_vendor_id,
                fulfillment_team_id: meta.fulfillment_team_id,
              },
            },
            order: {
              total_per_occurrence: totalPerOccurrence,
              total: totalPerOccurrence,
              line_count: lineMetas.length,
            },
            permissions: args.permissions ?? {},
          });
        },
      });

      // 5. Aggregate deny/require_approval and assemble approvals.
      const perLineApproval = lineMetas.map((meta) => {
        const outcome = outcomes.get(meta.oliId) ?? {
          effect: 'allow' as const,
          matched_rule_ids: [],
          denial_messages: [],
          warning_messages: [],
          approver_targets: [],
        };
        return {
          line_key: meta.oliId,
          outcome,
          scope: {
            order_ids: [order.id],
            order_line_item_ids: [meta.oliId],
            asset_reservation_ids: meta.asset_reservation_id ? [meta.asset_reservation_id] : [],
          },
        };
      });

      if (perLineApproval.some((p) => p.outcome.effect === 'deny')) {
        const denials = perLineApproval.flatMap((p) => p.outcome.denial_messages);
        throw new BadRequestException({
          code: 'service_rule_deny',
          message: denials[0] ?? 'A service rule denied this order.',
          denial_messages: denials,
        });
      }

      const anyPending = perLineApproval.some(
        (p) => p.outcome.effect === 'require_approval' || p.outcome.effect === 'allow_override',
      );

      const assembled = await this.approvalRouter.assemble({
        target_entity_type: 'booking_bundle',
        target_entity_id: bundle.id,
        per_line_outcomes: perLineApproval,
        bundle_context: {
          cost_center_id: args.cost_center_id ?? null,
          requester_person_id: args.requester_person_id,
          bundle_id: bundle.id,
        },
      });

      // 6. Set order status: submitted (pending) or approved (no rules).
      await this.supabase.admin
        .from('orders')
        .update({ status: anyPending ? 'submitted' : 'approved' })
        .eq('id', order.id);

      cleanup.commit();

      void this.audit(tenantId, 'order.created', {
        order_id: order.id,
        bundle_id: bundle.id,
        order_line_item_ids: oliIds,
        asset_reservation_ids: assetReservationIds,
        any_pending_approval: anyPending,
      });

      return {
        order_id: order.id,
        bundle_id: bundle.id,
        order_line_item_ids: oliIds,
        asset_reservation_ids: assetReservationIds,
        approval_ids: assembled.map((a) => a.target_entity_id),
        any_pending_approval: anyPending,
      };
    } catch (err) {
      await cleanup.rollback();
      throw err;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async createServicesOnlyBundle(args: {
    tenantId: string;
    args: CreateStandaloneOrderArgs;
  }): Promise<{ id: string }> {
    const insertRow = {
      tenant_id: args.tenantId,
      bundle_type: 'hospitality',
      requester_person_id: args.args.requester_person_id,
      host_person_id: null,
      primary_reservation_id: null,
      location_id: args.args.delivery_space_id,
      start_at: args.args.requested_for_start_at,
      end_at: args.args.requested_for_end_at,
      source: 'portal',
      cost_center_id: args.args.cost_center_id ?? null,
      template_id: null,
      policy_snapshot: {},
    };
    const { data, error } = await this.supabase.admin
      .from('booking_bundles')
      .insert(insertRow)
      .select('id')
      .single();
    if (error) throw error;
    return { id: (data as { id: string }).id };
  }

  private async createOrder(args: {
    tenantId: string;
    bundle_id: string;
    args: CreateStandaloneOrderArgs;
  }): Promise<{ id: string }> {
    const { data, error } = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: args.tenantId,
        requester_person_id: args.args.requester_person_id,
        booking_bundle_id: args.bundle_id,
        delivery_location_id: args.args.delivery_space_id,
        delivery_date: args.args.requested_for_start_at.slice(0, 10),
        requested_for_start_at: args.args.requested_for_start_at,
        requested_for_end_at: args.args.requested_for_end_at,
        status: 'draft',
        policy_snapshot: { source: 'standalone' },
      })
      .select('id')
      .single();
    if (error) throw error;
    return { id: (data as { id: string }).id };
  }

  private async loadCatalogItem(id: string): Promise<{
    id: string;
    category: string | null;
    price_per_unit: number | null;
    unit: 'per_item' | 'per_person' | 'flat_rate';
    fulfillment_team_id: string | null;
  }> {
    const { data, error } = await this.supabase.admin
      .from('catalog_items')
      .select('id, category, price_per_unit, unit, fulfillment_team_id')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException({ code: 'catalog_item_not_found', message: `Catalog item ${id} not found.` });
    return data as typeof data & {
      id: string;
      category: string | null;
      price_per_unit: number | null;
      unit: 'per_item' | 'per_person' | 'flat_rate';
      fulfillment_team_id: string | null;
    };
  }

  private async resolveOffer(catalogItemId: string, deliverySpaceId: string, onDate: string) {
    const { data, error } = await this.supabase.admin.rpc('resolve_menu_offer', {
      p_catalog_item_id: catalogItemId,
      p_delivery_space_id: deliverySpaceId,
      p_on_date: onDate,
    });
    if (error) throw error;
    return ((data ?? []) as Array<{
      menu_id: string;
      menu_item_id: string;
      vendor_id: string | null;
      fulfillment_team_id: string | null;
      price: number | null;
      unit: 'per_item' | 'per_person' | 'flat_rate' | null;
      lead_time_hours: number | null;
      service_type: string;
    }>)[0] ?? null;
  }

  private async createAssetReservation(args: {
    tenantId: string;
    asset_id: string;
    start_at: string;
    end_at: string;
    requester_person_id: string;
    bundle_id: string;
  }): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('asset_reservations')
      .insert({
        tenant_id: args.tenantId,
        asset_id: args.asset_id,
        start_at: args.start_at,
        end_at: args.end_at,
        status: 'confirmed',
        requester_person_id: args.requester_person_id,
        booking_bundle_id: args.bundle_id,
      })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  private async createLineItem(args: {
    tenantId: string;
    order_id: string;
    input: CreateStandaloneOrderArgs['lines'][number];
    item: Awaited<ReturnType<OrderService['loadCatalogItem']>>;
    offer: Awaited<ReturnType<OrderService['resolveOffer']>>;
    service_window_start_at: string;
    service_window_end_at: string;
    linked_asset_reservation_id: string | null;
  }): Promise<string> {
    const unitPrice = args.offer?.price ?? args.item.price_per_unit;
    const { data, error } = await this.supabase.admin
      .from('order_line_items')
      .insert({
        order_id: args.order_id,
        tenant_id: args.tenantId,
        catalog_item_id: args.input.catalog_item_id,
        quantity: args.input.quantity,
        unit_price: unitPrice,
        line_total: unitPrice != null ? unitPrice * args.input.quantity : null,
        fulfillment_status: 'ordered',
        fulfillment_team_id: args.offer?.fulfillment_team_id ?? args.item.fulfillment_team_id,
        linked_asset_id: args.input.linked_asset_id ?? null,
        linked_asset_reservation_id: args.linked_asset_reservation_id,
        service_window_start_at: args.service_window_start_at,
        service_window_end_at: args.service_window_end_at,
        repeats_with_series: false,
        policy_snapshot: {
          menu_id: args.offer?.menu_id ?? args.input.menu_id ?? null,
          menu_item_id: args.offer?.menu_item_id ?? null,
          unit: args.offer?.unit ?? args.item.unit,
          service_type: args.offer?.service_type ?? null,
        },
      })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  private async audit(tenantId: string, eventType: string, details: Record<string, unknown>) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: 'order',
        entity_id: (details.order_id as string) ?? null,
        details,
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

class StandaloneCleanup {
  private bundleId: string | null = null;
  private orderId: string | null = null;
  private oliIds: string[] = [];
  private assetReservationIds: string[] = [];
  private done = false;

  constructor(private readonly supabase: SupabaseService) {}

  bundle(id: string) { this.bundleId = id; }
  order(id: string) { this.orderId = id; }
  orderLineItem(id: string) { this.oliIds.push(id); }
  assetReservation(id: string) { this.assetReservationIds.push(id); }
  commit() { this.done = true; }

  async rollback() {
    if (this.done) return;
    // Same posture as BundleService.Cleanup: each step independent so a
    // network blip on step N doesn't leave step N+1's row dangling.
    const failures: string[] = [];
    if (this.oliIds.length > 0) {
      try {
        await this.supabase.admin.from('order_line_items').delete().in('id', this.oliIds);
      } catch (err) {
        failures.push(`oli: ${(err as Error).message}`);
      }
    }
    if (this.assetReservationIds.length > 0) {
      try {
        await this.supabase.admin
          .from('asset_reservations')
          .update({ status: 'cancelled' })
          .in('id', this.assetReservationIds);
      } catch (err) {
        failures.push(`asset_reservations: ${(err as Error).message}`);
      }
    }
    if (this.orderId) {
      try {
        await this.supabase.admin.from('orders').delete().eq('id', this.orderId);
      } catch (err) {
        failures.push(`order: ${(err as Error).message}`);
      }
    }
    if (this.bundleId) {
      try {
        await this.supabase.admin.from('booking_bundles').delete().eq('id', this.bundleId);
      } catch (err) {
        failures.push(`bundle: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[orders.standalone.rollback] ${failures.length} step(s) failed: ${failures.join('; ')}`,
      );
    }
  }
}
