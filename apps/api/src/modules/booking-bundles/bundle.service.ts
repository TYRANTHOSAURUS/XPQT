import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  loadPermissionMap,
  loadRequesterContext,
} from '../../common/requester-context';
import { ApprovalRoutingService } from '../orders/approval-routing.service';
import { ServiceRuleResolverService } from '../service-catalog/service-rule-resolver.service';
import { buildServiceEvaluationContext } from '../service-catalog/service-evaluation-context';
import { SetupWorkOrderTriggerService } from '../service-routing/setup-work-order-trigger.service';
import type { BundleSource, BundleType } from './dto/types';

/**
 * BundleService — orchestration parent for room + N services.
 *
 * Responsibilities:
 *   - Lazy-create `booking_bundles` on first-service-attach to a reservation.
 *   - Group lines by service_type → one order per group.
 *   - Insert order_line_items with provenance snapshot from `resolve_menu_offer`.
 *   - Insert asset_reservations when a line linked an asset (GiST exclusion
 *     fires here on conflict).
 *   - Resolve service rules + assemble approvals via the deduping
 *     `ApprovalRoutingService`.
 *   - Emit `bundle.created` / `bundle.cancelled` audit events.
 *
 * Atomicity (v1):
 *   We use a sequence of Supabase calls with explicit cleanup-on-error.
 *   The asset GiST exclusion still fires at insert time so dual-bookings
 *   are impossible. A future refactor will move the whole pipeline into a
 *   single Postgres function for true transactional atomicity, matching
 *   spec §4.1 step 3. Until then, partial-success states are deleted in
 *   reverse-creation order on any thrown exception.
 */

export interface AttachServicesArgs {
  reservation_id: string;
  requester_person_id: string;
  bundle?: {
    bundle_type?: BundleType;
    host_person_id?: string | null;
    cost_center_id?: string | null;
    template_id?: string | null;
    source?: BundleSource;
  };
  services: ServiceLineInput[];
}

export interface ServiceLineInput {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity: number;
  /** Defaults to reservation window when omitted. */
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
  /** True (default) = clones for future occurrences; false = master-only. */
  repeats_with_series?: boolean;
  /** When set, an `asset_reservations` row is created in the same transaction. */
  linked_asset_id?: string | null;
}

export interface AttachServicesResult {
  bundle_id: string;
  order_ids: string[];
  order_line_item_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
  any_pending_approval: boolean;
}

@Injectable()
export class BundleService {
  private readonly log = new Logger(BundleService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ServiceRuleResolverService,
    private readonly approvalRouter: ApprovalRoutingService,
    private readonly setupTrigger: SetupWorkOrderTriggerService,
  ) {}

  /**
   * The canonical "attach N services to an existing reservation" path. Called
   * from the booking-confirm dialog (`POST /reservations` with `services[]`)
   * and from the standalone-order pipeline (with a pre-existing reservation,
   * if any).
   */
  async attachServicesToReservation(args: AttachServicesArgs): Promise<AttachServicesResult> {
    if (args.services.length === 0) {
      throw new BadRequestException({ code: 'no_services', message: 'no service lines provided' });
    }
    const tenantId = TenantContext.current().id;

    const reservation = await this.loadReservation(args.reservation_id);
    const lines = await this.hydrateLines(args.services, reservation);
    const requesterCtx = await loadRequesterContext(this.supabase, args.requester_person_id);
    const permissions = await loadPermissionMap(this.supabase, requesterCtx.user_id);

    const cleanup = new Cleanup(this.supabase);
    try {
      const bundle = await this.lazyCreateBundle({
        tenantId,
        reservation,
        requester_person_id: args.requester_person_id,
        bundle: args.bundle,
      });
      cleanup.bundle(bundle.id, bundle.preExisting);

      // Link reservation to bundle if not already linked.
      if (!reservation.booking_bundle_id || reservation.booking_bundle_id !== bundle.id) {
        await this.supabase.admin
          .from('reservations')
          .update({ booking_bundle_id: bundle.id })
          .eq('id', reservation.id);
      }

      // Group by service_type (from menu_items.menu → catalog_menus.service_type).
      const linesByServiceType = new Map<string, HydratedLine[]>();
      for (const line of lines) {
        const list = linesByServiceType.get(line.service_type) ?? [];
        list.push(line);
        linesByServiceType.set(line.service_type, list);
      }

      const orderIds: string[] = [];
      const oliIds: string[] = [];
      const assetReservationIds: string[] = [];
      const perLineOutcomeInputs: Array<{
        lineKey: string;
        catalog_item_id: string;
        catalog_item_category: string | null;
        menu_id: string | null;
      }> = [];
      const perLineScopes = new Map<string, { order_id: string; oli_id: string; asset_reservation_id: string | null; ticket_id: string | null }>();
      // (oliId → HydratedLine) — the rule resolver's `contextFor` callback
      // looks up by lineKey (= persisted oliId), not by HydratedLine.id (which
      // is always the empty string until insert). Track the pair here.
      const lineByOli = new Map<string, HydratedLine>();

      // Pre-compute the order total once — `contextFor` would otherwise
      // recompute it per line.
      const orderTotal = lines.reduce(
        (sum, l) => sum + (l.unit_price ?? 0) * l.quantity,
        0,
      );

      for (const [serviceType, group] of linesByServiceType) {
        const order = await this.createOrder({
          tenantId,
          reservation,
          requester_person_id: args.requester_person_id,
          bundle_id: bundle.id,
          service_type: serviceType,
        });
        cleanup.order(order.id);
        orderIds.push(order.id);

        for (const line of group) {
          // 1. Asset reservation first — GiST conflict fails fast and we don't
          //    leak an order_line_items row on conflict.
          let assetReservationId: string | null = null;
          if (line.linked_asset_id) {
            assetReservationId = await this.createAssetReservation({
              tenantId,
              asset_id: line.linked_asset_id,
              start_at: line.service_window_start_at,
              end_at: line.service_window_end_at,
              requester_person_id: args.requester_person_id,
              bundle_id: bundle.id,
            });
            cleanup.assetReservation(assetReservationId);
            assetReservationIds.push(assetReservationId);
          }

          // 2. Order line item.
          const oliId = await this.createLineItem({
            tenantId,
            order_id: order.id,
            line,
            linked_asset_reservation_id: assetReservationId,
          });
          cleanup.orderLineItem(oliId);
          oliIds.push(oliId);

          // Track per-line for rule resolution + scope_breakdown.
          perLineOutcomeInputs.push({
            lineKey: oliId,
            catalog_item_id: line.catalog_item_id,
            catalog_item_category: line.catalog_item_category,
            menu_id: line.menu_id ?? null,
          });
          perLineScopes.set(oliId, {
            order_id: order.id,
            oli_id: oliId,
            asset_reservation_id: assetReservationId,
            ticket_id: null,
          });
          lineByOli.set(oliId, line);
        }
      }

      // Resolve service rules per line, assemble approvals.
      const outcomes = await this.resolver.resolveBulk({
        lines: perLineOutcomeInputs,
        contextFor: (lineKey) => {
          const line = lineByOli.get(lineKey);
          if (!line) throw new Error(`context lookup failed for ${lineKey}`);
          return buildServiceEvaluationContext({
            requester: requesterCtx,
            bundle: {
              id: bundle.id,
              cost_center_id: args.bundle?.cost_center_id ?? null,
              template_id: args.bundle?.template_id ?? null,
              attendee_count: reservation.attendee_count ?? null,
            },
            reservation: {
              id: reservation.id,
              space_id: reservation.space_id,
              start_at: reservation.start_at,
              end_at: reservation.end_at,
            },
            line: {
              catalog_item_id: line.catalog_item_id,
              catalog_item_category: line.catalog_item_category,
              menu_id: line.menu_id,
              quantity: line.quantity,
              quantity_per_attendee: null,
              service_window_start_at: line.service_window_start_at,
              service_window_end_at: line.service_window_end_at,
              unit_price: line.unit_price,
              lead_time_remaining_hours: line.lead_time_remaining_hours,
              menu: {
                fulfillment_vendor_id: line.fulfillment_vendor_id,
                fulfillment_team_id: line.fulfillment_team_id,
              },
            },
            order: {
              total_per_occurrence: orderTotal,
              total: orderTotal,
              line_count: lines.length,
            },
            permissions,
          });
        },
      });

      const perLineApproval = perLineOutcomeInputs.map((input) => {
        const outcome = outcomes.get(input.lineKey);
        const scope = perLineScopes.get(input.lineKey)!;
        return {
          line_key: input.lineKey,
          outcome: outcome ?? this.allowOutcome(),
          scope: {
            reservation_ids: [reservation.id],
            order_ids: [scope.order_id],
            order_line_item_ids: [scope.oli_id],
            ticket_ids: scope.ticket_id ? [scope.ticket_id] : [],
            asset_reservation_ids: scope.asset_reservation_id ? [scope.asset_reservation_id] : [],
          },
        };
      });

      const assembled = await this.approvalRouter.assemble({
        target_entity_type: 'booking_bundle',
        target_entity_id: bundle.id,
        per_line_outcomes: perLineApproval,
        bundle_context: {
          cost_center_id: args.bundle?.cost_center_id ?? null,
          requester_person_id: args.requester_person_id,
          bundle_id: bundle.id,
        },
      });

      const anyDeny = perLineApproval.some((p) => p.outcome.effect === 'deny');
      if (anyDeny) {
        const denials = perLineApproval.flatMap((p) => p.outcome.denial_messages);
        // Throw before we mark orders 'submitted' — cleanup will undo the
        // asset reservations + line items + bundle.
        throw new BadRequestException({
          code: 'service_rule_deny',
          message: denials[0] ?? 'A service rule denied this booking.',
          denial_messages: denials,
        });
      }

      const anyPending = perLineApproval.some((p) =>
        p.outcome.effect === 'require_approval' || p.outcome.effect === 'allow_override',
      );

      // Update each order's status: submitted (pending approval) or approved.
      for (const orderId of orderIds) {
        await this.supabase.admin
          .from('orders')
          .update({ status: anyPending ? 'submitted' : 'approved' })
          .eq('id', orderId);
      }

      cleanup.commit();

      // Auto-create internal-setup work orders in parallel for any line
      // whose rules emitted requires_internal_setup=true. Runs AFTER
      // commit; failures are audited internally and never roll back
      // the bundle. See plan §Slice 2 + SetupWorkOrderTriggerService.
      const triggerArgs = Array.from(outcomes.entries())
        .filter(([oliId, outcome]) => outcome.requires_internal_setup && lineByOli.has(oliId))
        .map(([oliId, outcome]) => {
          const line = lineByOli.get(oliId)!;
          return {
            tenantId,
            bundleId: bundle.id,
            oliId,
            serviceCategory: line.service_type,
            serviceWindowStartAt: line.service_window_start_at,
            locationId: reservation.space_id,
            ruleIds: outcome.matched_rule_ids,
            leadTimeOverride: outcome.internal_setup_lead_time_minutes,
            originSurface: 'bundle' as const,
          };
        });
      await this.setupTrigger.triggerMany(triggerArgs);

      void this.audit(tenantId, 'bundle.created', 'booking_bundle', bundle.id, {
        bundle_id: bundle.id,
        reservation_id: reservation.id,
        order_ids: orderIds,
        order_line_item_ids: oliIds,
        asset_reservation_ids: assetReservationIds,
        approval_ids: assembled.map((a) => a.target_entity_id),
        any_pending_approval: anyPending,
      });

      return {
        bundle_id: bundle.id,
        order_ids: orderIds,
        order_line_item_ids: oliIds,
        asset_reservation_ids: assetReservationIds,
        approval_ids: assembled.map((a) => a.target_entity_id),
        any_pending_approval: anyPending,
      };
    } catch (err) {
      await cleanup.rollback();
      // Asset GiST conflict path — surface a structured 409 with the
      // conflicting asset for the picker to suggest alternatives.
      if (isExclusionViolation(err)) {
        throw new ConflictException({
          code: 'asset_conflict',
          message: 'A requested asset is already reserved for this window.',
        });
      }
      throw err;
    }
  }

  /**
   * `addLinesToBundle` — append new service lines to an existing bundle.
   * Resolves the bundle's primary reservation and delegates to
   * `attachServicesToReservation`, which already handles bundle reuse,
   * grouping by service_type, asset reservations, rule resolution, and
   * approval routing.
   */
  async addLinesToBundle(args: {
    bundle_id: string;
    requester_person_id: string;
    services: ServiceLineInput[];
  }): Promise<AttachServicesResult> {
    if (args.services.length === 0) {
      throw new BadRequestException({ code: 'no_services', message: 'no service lines provided' });
    }
    const tenantId = TenantContext.current().id;

    const { data, error } = await this.supabase.admin
      .from('booking_bundles')
      .select('id, primary_reservation_id, requester_person_id, host_person_id, location_id')
      .eq('id', args.bundle_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({ code: 'bundle_not_found', message: `Bundle ${args.bundle_id} not found.` });
    }
    const bundle = data as { id: string; primary_reservation_id: string | null };
    if (!bundle.primary_reservation_id) {
      throw new BadRequestException({
        code: 'bundle_no_reservation',
        message: 'Cannot add lines to a bundle without a primary reservation.',
      });
    }

    return this.attachServicesToReservation({
      reservation_id: bundle.primary_reservation_id,
      requester_person_id: args.requester_person_id,
      services: args.services,
    });
  }

  /**
   * `editLine` — patch quantity / service window / notes on an existing
   * order_line_items row. Recomputes line_total when qty changes; cascades
   * the new window to the linked work-order ticket so dispatch and SLA
   * still reflect the latest commitment.
   *
   * Visibility/write check is enforced upstream by the controller via
   * `BundleVisibilityService` + a participant/admin gate on writes.
   */
  async editLine(args: {
    line_id: string;
    patch: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
    };
  }): Promise<{ line_id: string; quantity: number; line_total: number | null; service_window_start_at: string | null; service_window_end_at: string | null }> {
    const tenantId = TenantContext.current().id;

    const { data: existing, error: loadErr } = await this.supabase.admin
      .from('order_line_items')
      .select('id, tenant_id, order_id, quantity, unit_price, line_total, service_window_start_at, service_window_end_at, fulfillment_status, linked_ticket_id')
      .eq('id', args.line_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!existing) {
      throw new NotFoundException({ code: 'line_not_found', message: `Line ${args.line_id} not found.` });
    }
    const line = existing as {
      id: string;
      tenant_id: string;
      order_id: string;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      fulfillment_status: string;
      linked_ticket_id: string | null;
    };

    const FROZEN: Set<string> = new Set(['preparing', 'delivered', 'cancelled']);
    if (FROZEN.has(line.fulfillment_status)) {
      throw new ConflictException({
        code: 'line_frozen',
        message: `Cannot edit a line in '${line.fulfillment_status}' state. Cancel and re-add instead.`,
      });
    }

    const update: Record<string, unknown> = {};
    if (typeof args.patch.quantity === 'number' && args.patch.quantity !== line.quantity) {
      if (args.patch.quantity < 1) {
        throw new BadRequestException({ code: 'invalid_quantity', message: 'Quantity must be ≥ 1.' });
      }
      update.quantity = args.patch.quantity;
      if (line.unit_price != null) {
        update.line_total = Number((Number(line.unit_price) * args.patch.quantity).toFixed(2));
      }
    }
    if (args.patch.service_window_start_at !== undefined && args.patch.service_window_start_at !== line.service_window_start_at) {
      update.service_window_start_at = args.patch.service_window_start_at;
    }
    if (args.patch.service_window_end_at !== undefined && args.patch.service_window_end_at !== line.service_window_end_at) {
      update.service_window_end_at = args.patch.service_window_end_at;
    }

    if (Object.keys(update).length === 0) {
      // No-op; return current state.
      return {
        line_id: line.id,
        quantity: line.quantity,
        line_total: line.line_total,
        service_window_start_at: line.service_window_start_at,
        service_window_end_at: line.service_window_end_at,
      };
    }

    // Optimistic concurrency: refuse to write if another caller has advanced
    // the line into a frozen state between our SELECT and UPDATE. The
    // `.eq('fulfillment_status', line.fulfillment_status)` clause turns a
    // would-be silent override into a 0-row result we surface as 409.
    const { data: updated, error: updateErr } = await this.supabase.admin
      .from('order_line_items')
      .update(update)
      .eq('id', line.id)
      .eq('tenant_id', tenantId)
      .eq('fulfillment_status', line.fulfillment_status)
      .select('id, quantity, line_total, service_window_start_at, service_window_end_at')
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      throw new ConflictException({
        code: 'line_state_changed',
        message: 'This line was updated by fulfillment while you were editing. Reload to see the latest state.',
      });
    }
    const u = updated as { id: string; quantity: number; line_total: number | null; service_window_start_at: string | null; service_window_end_at: string | null };

    // Wave 2 Slice 2: when a service window moves, shift any linked
    // booking-origin work order's sla_resolution_due_at by the same delta.
    // Preserves the lead-time relationship that was committed at create
    // time (incl. per-rule overrides) without re-running the matrix —
    // re-running could change the team or lead time mid-flight if the
    // matrix has been edited since.
    //
    // Only fires when start_at actually moved; quantity-only edits don't
    // affect timing. Idempotent if the linked WO is already terminal —
    // the whitelist filter excludes closed/resolved rows.
    const oldStart = line.service_window_start_at;
    const newStart = u.service_window_start_at;
    if (oldStart && newStart && oldStart !== newStart) {
      const deltaMs = new Date(newStart).getTime() - new Date(oldStart).getTime();
      if (deltaMs !== 0) {
        const NON_TERMINAL = ['new', 'assigned', 'in_progress', 'waiting'];
        const { data: linkedWos } = await this.supabase.admin
          .from('tickets')
          .select('id, sla_resolution_due_at')
          .eq('linked_order_line_item_id', line.id)
          .eq('tenant_id', tenantId)
          .eq('ticket_kind', 'work_order')
          .in('status_category', NON_TERMINAL);
        for (const wo of (linkedWos ?? []) as Array<{ id: string; sla_resolution_due_at: string | null }>) {
          if (!wo.sla_resolution_due_at) continue;
          const shifted = new Date(
            new Date(wo.sla_resolution_due_at).getTime() + deltaMs,
          ).toISOString();
          await this.supabase.admin
            .from('tickets')
            .update({ sla_resolution_due_at: shifted })
            .eq('id', wo.id)
            .eq('tenant_id', tenantId);
        }
      }
    }

    void this.audit(tenantId, 'bundle_line.updated', 'order_line_item', line.id, {
      line_id: line.id,
      patch: update,
    });

    return {
      line_id: u.id,
      quantity: u.quantity,
      line_total: u.line_total,
      service_window_start_at: u.service_window_start_at,
      service_window_end_at: u.service_window_end_at,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadReservation(id: string) {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('id, tenant_id, space_id, requester_person_id, host_person_id, start_at, end_at, attendee_count, booking_bundle_id, source')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException({ code: 'reservation_not_found', message: `Reservation ${id} not found.` });
    return data as ReservationRow;
  }

  private async hydrateLines(inputs: ServiceLineInput[], reservation: ReservationRow): Promise<HydratedLine[]> {
    const out: HydratedLine[] = [];
    const now = Date.now();
    const tenantId = reservation.tenant_id;
    for (const input of inputs) {
      // Look up the catalog item — gives us category + price/unit defaults
      // that the resolver doesn't otherwise see. Tenant-filter to refuse
      // cross-tenant catalog ids passed in the payload.
      const { data: item, error: itemErr } = await this.supabase.admin
        .from('catalog_items')
        .select('id, category, price_per_unit, unit, fulfillment_team_id')
        .eq('id', input.catalog_item_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (itemErr) throw itemErr;
      if (!item) throw new NotFoundException({ code: 'catalog_item_not_found', message: `Catalog item ${input.catalog_item_id} not found.` });

      // Resolve menu offer to get vendor/team + price snapshot.
      let menuId = input.menu_id ?? null;
      let menuPrice: number | null = null;
      let menuUnit: 'per_item' | 'per_person' | 'flat_rate' | null = null;
      let serviceType = 'other';
      let fulfillmentVendorId: string | null = null;
      let fulfillmentTeamId: string | null = (item as { fulfillment_team_id: string | null }).fulfillment_team_id ?? null;

      const { data: offer, error: offerErr } = await this.supabase.admin.rpc('resolve_menu_offer', {
        p_catalog_item_id: input.catalog_item_id,
        p_delivery_space_id: reservation.space_id,
        p_on_date: reservation.start_at.slice(0, 10),
      });
      if (offerErr) throw offerErr;
      const offerRow = ((offer ?? []) as Array<{
        menu_id: string;
        menu_item_id: string;
        vendor_id: string | null;
        fulfillment_team_id: string | null;
        price: number | null;
        unit: 'per_item' | 'per_person' | 'flat_rate' | null;
        lead_time_hours: number | null;
        service_type: string;
      }>)[0];

      if (offerRow) {
        menuId = offerRow.menu_id;
        menuPrice = offerRow.price;
        menuUnit = offerRow.unit;
        serviceType = offerRow.service_type;
        fulfillmentVendorId = offerRow.vendor_id;
        fulfillmentTeamId = offerRow.fulfillment_team_id ?? fulfillmentTeamId;
      } else {
        // No menu offer found; fall back to catalog item's defaults.
        menuPrice = (item as { price_per_unit: number | null }).price_per_unit ?? null;
        menuUnit = (item as { unit: 'per_item' | 'per_person' | 'flat_rate' }).unit ?? 'per_item';
      }

      const startAt = input.service_window_start_at ?? reservation.start_at;
      const endAt = input.service_window_end_at ?? reservation.end_at;
      const leadRemaining = (Date.parse(startAt) - now) / 3_600_000; // hours

      out.push({
        id: '', // assigned by Supabase on insert
        catalog_item_id: input.catalog_item_id,
        catalog_item_category: (item as { category: string | null }).category,
        menu_id: menuId,
        menu_item_id: offerRow?.menu_item_id ?? null,
        quantity: input.quantity,
        unit_price: menuPrice,
        unit: menuUnit,
        service_window_start_at: startAt,
        service_window_end_at: endAt,
        repeats_with_series: input.repeats_with_series ?? true,
        linked_asset_id: input.linked_asset_id ?? null,
        service_type: serviceType,
        fulfillment_vendor_id: fulfillmentVendorId,
        fulfillment_team_id: fulfillmentTeamId,
        lead_time_remaining_hours: leadRemaining,
      });
    }
    return out;
  }

  private async lazyCreateBundle(args: {
    tenantId: string;
    reservation: ReservationRow;
    requester_person_id: string;
    bundle?: AttachServicesArgs['bundle'];
  }): Promise<{ id: string; preExisting: boolean }> {
    if (args.reservation.booking_bundle_id) {
      const { data, error } = await this.supabase.admin
        .from('booking_bundles')
        .select('id')
        .eq('id', args.reservation.booking_bundle_id)
        .eq('tenant_id', args.tenantId)
        .maybeSingle();
      if (error) throw error;
      if (data) return { id: (data as { id: string }).id, preExisting: true };
      // Stale FK or cross-tenant leak attempt — fall through to create new
      // in this tenant.
    }

    const insertRow = {
      tenant_id: args.tenantId,
      bundle_type: args.bundle?.bundle_type ?? 'meeting',
      requester_person_id: args.requester_person_id,
      host_person_id: args.bundle?.host_person_id ?? args.reservation.host_person_id ?? null,
      primary_reservation_id: args.reservation.id,
      location_id: args.reservation.space_id,
      start_at: args.reservation.start_at,
      end_at: args.reservation.end_at,
      source: args.bundle?.source ?? 'portal',
      cost_center_id: args.bundle?.cost_center_id ?? null,
      template_id: args.bundle?.template_id ?? null,
      policy_snapshot: {},
    };

    const { data, error } = await this.supabase.admin
      .from('booking_bundles')
      .insert(insertRow)
      .select('id')
      .single();
    if (error) {
      // 23505 = unique violation on (primary_reservation_id) WHERE NOT NULL
      // (migration 00153). A concurrent attach already created a bundle for
      // this reservation; fetch + reuse it instead of double-creating.
      if ((error as { code?: string }).code === '23505') {
        const existing = await this.supabase.admin
          .from('booking_bundles')
          .select('id')
          .eq('primary_reservation_id', args.reservation.id)
          .eq('tenant_id', args.tenantId)
          .maybeSingle();
        if (existing.data) {
          return { id: (existing.data as { id: string }).id, preExisting: true };
        }
      }
      throw error;
    }
    return { id: (data as { id: string }).id, preExisting: false };
  }

  private async createOrder(args: {
    tenantId: string;
    reservation: ReservationRow;
    requester_person_id: string;
    bundle_id: string;
    service_type: string;
  }): Promise<{ id: string }> {
    const { data, error } = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: args.tenantId,
        requester_person_id: args.requester_person_id,
        booking_bundle_id: args.bundle_id,
        linked_reservation_id: args.reservation.id,
        delivery_location_id: args.reservation.space_id,
        delivery_date: args.reservation.start_at.slice(0, 10),
        requested_for_start_at: args.reservation.start_at,
        requested_for_end_at: args.reservation.end_at,
        status: 'draft',
        policy_snapshot: { service_type: args.service_type },
      })
      .select('id')
      .single();
    if (error) throw error;
    return { id: (data as { id: string }).id };
  }

  private async createLineItem(args: {
    tenantId: string;
    order_id: string;
    line: HydratedLine;
    linked_asset_reservation_id: string | null;
  }): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('order_line_items')
      .insert({
        order_id: args.order_id,
        tenant_id: args.tenantId,
        catalog_item_id: args.line.catalog_item_id,
        quantity: args.line.quantity,
        unit_price: args.line.unit_price,
        line_total: args.line.unit_price != null ? args.line.unit_price * args.line.quantity : null,
        fulfillment_status: 'ordered',
        fulfillment_team_id: args.line.fulfillment_team_id,
        vendor_id: args.line.fulfillment_vendor_id,
        menu_item_id: args.line.menu_item_id,
        linked_asset_id: args.line.linked_asset_id,
        linked_asset_reservation_id: args.linked_asset_reservation_id,
        service_window_start_at: args.line.service_window_start_at,
        service_window_end_at: args.line.service_window_end_at,
        repeats_with_series: args.line.repeats_with_series,
        policy_snapshot: {
          menu_id: args.line.menu_id,
          menu_item_id: args.line.menu_item_id,
          unit: args.line.unit,
          service_type: args.line.service_type,
        },
      })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  private async createAssetReservation(args: {
    tenantId: string;
    asset_id: string;
    start_at: string;
    end_at: string;
    requester_person_id: string;
    bundle_id: string;
  }): Promise<string> {
    // Confirm the asset belongs to this tenant — otherwise a cross-tenant
    // asset id passed in the payload would land a tenant-A reservation
    // pointing at a tenant-B asset.
    const assetCheck = await this.supabase.admin
      .from('assets')
      .select('id')
      .eq('id', args.asset_id)
      .eq('tenant_id', args.tenantId)
      .maybeSingle();
    if (assetCheck.error) throw assetCheck.error;
    if (!assetCheck.data) {
      throw new NotFoundException({
        code: 'asset_not_found',
        message: `Asset ${args.asset_id} not found.`,
      });
    }

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

  private allowOutcome() {
    return {
      effect: 'allow' as const,
      matched_rule_ids: [],
      denial_messages: [],
      warning_messages: [],
      approver_targets: [],
      requires_internal_setup: false,
      internal_setup_lead_time_minutes: null,
    };
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

// ── Local types ───────────────────────────────────────────────────────────

interface ReservationRow {
  id: string;
  tenant_id: string;
  space_id: string;
  requester_person_id: string;
  host_person_id: string | null;
  start_at: string;
  end_at: string;
  attendee_count: number | null;
  booking_bundle_id: string | null;
  source: string | null;
}

interface HydratedLine {
  id: string;
  catalog_item_id: string;
  catalog_item_category: string | null;
  menu_id: string | null;
  menu_item_id: string | null;
  quantity: number;
  unit_price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  service_window_start_at: string;
  service_window_end_at: string;
  repeats_with_series: boolean;
  linked_asset_id: string | null;
  service_type: string;
  fulfillment_vendor_id: string | null;
  fulfillment_team_id: string | null;
  lead_time_remaining_hours: number;
}

// ── Cleanup helper ────────────────────────────────────────────────────────

class Cleanup {
  private bundles: Array<{ id: string; preExisting: boolean }> = [];
  private orderIds: string[] = [];
  private oliIds: string[] = [];
  private assetReservationIds: string[] = [];
  private done = false;

  constructor(private readonly supabase: SupabaseService) {}

  bundle(id: string, preExisting: boolean) { this.bundles.push({ id, preExisting }); }
  order(id: string) { this.orderIds.push(id); }
  orderLineItem(id: string) { this.oliIds.push(id); }
  assetReservation(id: string) { this.assetReservationIds.push(id); }

  commit() { this.done = true; }

  async rollback() {
    if (this.done) return;
    // Reverse-creation order: oli → ar → orders → bundle (only if we
    // created it). Each step is independent — a failure in step N
    // shouldn't skip step N+1 (the user is already getting an error;
    // hiding orphans behind it is worse than half-failed cleanup). Best
    // effort: each branch in its own try/catch, errors collected for
    // a single warn-log at the end.
    const failures: string[] = [];
    if (this.oliIds.length > 0) {
      try {
        await this.supabase.admin.from('order_line_items').delete().in('id', this.oliIds);
      } catch (err) {
        failures.push(`oli: ${(err as Error).message}`);
      }
    }
    if (this.assetReservationIds.length > 0) {
      // Soft-delete via status='cancelled' so the GiST exclusion stops
      // blocking; matches sub-project 1's pattern for reservations rollback.
      try {
        await this.supabase.admin
          .from('asset_reservations')
          .update({ status: 'cancelled' })
          .in('id', this.assetReservationIds);
      } catch (err) {
        failures.push(`asset_reservations: ${(err as Error).message}`);
      }
    }
    if (this.orderIds.length > 0) {
      try {
        await this.supabase.admin.from('orders').delete().in('id', this.orderIds);
      } catch (err) {
        failures.push(`orders: ${(err as Error).message}`);
      }
    }
    // Void any approvals already persisted for the rolled-back bundles /
    // orders / lines. Without this, ApprovalRoutingService.assemble's
    // pre-anyDeny inserts orphan: approvers see a pending row in their
    // queue for entities that no longer exist. Codex flagged this on
    // the multi-room contract widening review (2026-04-28).
    const approvalTargetIds = [
      ...this.bundles.map((b) => b.id),
      ...this.orderIds,
      ...this.oliIds,
    ];
    if (approvalTargetIds.length > 0) {
      try {
        await this.supabase.admin
          .from('approvals')
          .update({
            status: 'cancelled',
            comments: 'Auto-voided — bundle creation rolled back (orphan prevention).',
          })
          .in('target_entity_id', approvalTargetIds)
          .eq('status', 'pending');
      } catch (err) {
        failures.push(`approvals: ${(err as Error).message}`);
      }
    }
    for (const b of this.bundles) {
      if (!b.preExisting) {
        try {
          await this.supabase.admin.from('booking_bundles').delete().eq('id', b.id);
        } catch (err) {
          failures.push(`bundle ${b.id}: ${(err as Error).message}`);
        }
      }
    }
    if (failures.length > 0) {
      // Surface as a single combined log so ops can see the full picture
      // when investigating an orphan. Doesn't re-throw — the caller's
      // original error wins.
      // eslint-disable-next-line no-console
      console.warn(
        `[bundle.rollback] ${failures.length} step(s) failed: ${failures.join('; ')}`,
      );
    }
  }
}

function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23P01'
  );
}
