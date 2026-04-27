import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ApprovalRoutingService } from '../orders/approval-routing.service';
import { ServiceRuleResolverService } from '../service-catalog/service-rule-resolver.service';
import { buildServiceEvaluationContext } from '../service-catalog/service-evaluation-context';
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
  /** Permissions map for the requester — passed through to the predicate engine. */
  permissions?: Record<string, boolean>;
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
    const requesterCtx = await this.loadRequesterContext(args.requester_person_id);
    const permissions =
      args.permissions ?? (await this.loadPermissionMap(requesterCtx.user_id));

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

  /**
   * Resolve requester profile (person + primary org membership + roles + linked
   * user) for predicate evaluation. Mirrors RoomBookingRules' loadRequester so
   * service rules see the same shape as room rules.
   */
  private async loadRequesterContext(personId: string): Promise<{
    id: string;
    type: string | null;
    cost_center: string | null;
    org_node_id: string | null;
    role_ids: string[];
    user_id: string | null;
  }> {
    const tenantId = TenantContext.current().id;
    const [
      { data: person, error: pErr },
      { data: membership, error: mErr },
      { data: user, error: uErr },
    ] = await Promise.all([
      this.supabase.admin
        .from('persons')
        .select('id, type, cost_center')
        .eq('id', personId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      this.supabase.admin
        .from('person_org_memberships')
        .select('org_node_id')
        .eq('person_id', personId)
        .eq('tenant_id', tenantId)
        .eq('is_primary', true)
        .maybeSingle(),
      this.supabase.admin
        .from('users')
        .select('id')
        .eq('person_id', personId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
    ]);
    if (pErr) throw pErr;
    if (mErr) throw mErr;
    if (uErr) throw uErr;
    if (!person) throw new NotFoundException(`Person ${personId} not found`);
    const userId = (user as { id: string } | null)?.id ?? null;

    let roleIds: string[] = [];
    if (userId) {
      const { data: roles, error: rErr } = await this.supabase.admin
        .from('user_role_assignments')
        .select('role_id')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .eq('active', true);
      if (rErr) throw rErr;
      roleIds = ((roles ?? []) as Array<{ role_id: string }>).map((r) => r.role_id);
    }

    return {
      id: personId,
      type: (person as { type: string | null }).type ?? null,
      cost_center: (person as { cost_center: string | null }).cost_center ?? null,
      org_node_id: (membership as { org_node_id: string } | null)?.org_node_id ?? null,
      role_ids: roleIds,
      user_id: userId,
    };
  }

  /**
   * Materialise the permissions referenced by service-rule templates. Mirrors
   * RoomBookingRules' loadPermissionMap. Today no service template uses
   * has_permission, but the predicate engine supports it — pre-load the same
   * permissions room rules use so admin overrides work uniformly across both.
   */
  private async loadPermissionMap(userId: string | null): Promise<Record<string, boolean>> {
    if (!userId) return {};
    const tenantId = TenantContext.current().id;
    const perms = ['rooms.override_rules', 'rooms.book_on_behalf'];
    const result: Record<string, boolean> = {};
    await Promise.all(
      perms.map(async (perm) => {
        const { data, error } = await this.supabase.admin.rpc('user_has_permission', {
          p_user_id: userId,
          p_tenant_id: tenantId,
          p_permission: perm,
        });
        if (error) throw error;
        result[perm] = Boolean(data);
      }),
    );
    return result;
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
