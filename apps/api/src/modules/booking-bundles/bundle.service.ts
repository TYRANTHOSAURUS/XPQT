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
import {
  SetupWorkOrderTriggerService,
  type TriggerArgs,
} from '../service-routing/setup-work-order-trigger.service';
import { BundleEventBus, type BundleEvent } from './bundle-event-bus';
import type { BundleSource, BundleType } from './dto/types';

/**
 * BundleService — orchestration parent for booking + N services.
 *
 * Post-canonicalisation (2026-05-02): there is no separate `booking_bundles`
 * row. The `bookings` row IS the canonical entity (00277:27). This service
 * attaches service orders/lines/asset-reservations to an existing booking.
 *
 * Responsibilities:
 *   - Group service lines by service_type → one order per group.
 *   - Insert order_line_items with provenance snapshot from `resolve_menu_offer`.
 *   - Insert asset_reservations when a line linked an asset (GiST exclusion
 *     fires here on conflict).
 *   - Resolve service rules + assemble approvals via the deduping
 *     `ApprovalRoutingService`.
 *   - Emit `booking.services_attached` / cascade events as the bundle event
 *     bus expects them (event names retain `bundle.*` for now — bus subscribers
 *     are out-of-scope slices).
 *
 * Atomicity (v1):
 *   Booking creation itself is now atomic via the `create_booking` RPC
 *   (00277:236) — the booking + slot rows go in inside one transaction.
 *   Service attachment (this service) still uses a sequence of Supabase
 *   calls with explicit cleanup-on-error. Asset GiST exclusion still fires
 *   at insert time so dual-bookings are impossible. A future refactor will
 *   pull the whole pipeline into a single Postgres function.
 *
 * Method rename:
 *   - `attachServicesToReservation` → `attachServicesToBooking`. The legacy
 *     name remains as a deprecated shim that delegates to the new method,
 *     translating the renamed `reservation_id` field to `booking_id`. Per the
 *     destructive-default rewrite plan, the legacy method will be removed
 *     once `reservation.controller.ts` migrates (separate slice).
 */

export interface AttachServicesArgs {
  /**
   * The id of an existing `bookings` row (00277:28) to attach services to.
   * Field renamed from `reservation_id` post-canonicalisation; the legacy
   * `attachServicesToReservation` shim accepts the old field name and
   * translates here.
   */
  booking_id: string;
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

/**
 * Legacy shape kept ONLY for the deprecated `attachServicesToReservation`
 * shim. New callers must use `AttachServicesArgs` + `attachServicesToBooking`.
 */
export interface AttachServicesToReservationArgsDeprecated {
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
  /**
   * Equals `args.booking_id`. Kept under the `bundle_id` field name for
   * backwards-compat with controllers/UI that still read `bundle_id` —
   * under canonicalisation the booking IS the bundle. Renamed in a
   * follow-up frontend slice.
   */
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
    private readonly eventBus: BundleEventBus,
  ) {}

  /**
   * Deprecated legacy entry-point. Translates the old `reservation_id` field
   * to the new canonical `booking_id` and delegates to
   * `attachServicesToBooking`.
   *
   * Kept ONLY so `reservation.controller.ts` (separate slice) keeps
   * typechecking. The controller currently passes the URL `:id` segment as
   * `reservation_id`; that param is now semantically a booking id (the
   * URL path will be renamed in the controller-rewrite slice). Until then,
   * runtime correctness depends on callers passing a real booking id.
   *
   * @deprecated Use `attachServicesToBooking({ booking_id, ... })` directly.
   */
  async attachServicesToReservation(
    args: AttachServicesToReservationArgsDeprecated,
  ): Promise<AttachServicesResult> {
    return this.attachServicesToBooking({
      booking_id: args.reservation_id,
      requester_person_id: args.requester_person_id,
      bundle: args.bundle,
      services: args.services,
    });
  }

  /**
   * The canonical "attach N services to an existing booking" path. Called
   * from `BookingFlowService.create` after the `create_booking` RPC lands
   * the booking + slot rows, and from the standalone-order pipeline
   * (with a pre-existing booking, if any).
   */
  async attachServicesToBooking(args: AttachServicesArgs): Promise<AttachServicesResult> {
    if (args.services.length === 0) {
      throw new BadRequestException({ code: 'no_services', message: 'no service lines provided' });
    }
    const tenantId = TenantContext.current().id;

    const booking = await this.loadBooking(args.booking_id);
    const lines = await this.hydrateLines(args.services, booking);
    const requesterCtx = await loadRequesterContext(this.supabase, args.requester_person_id);
    const permissions = await loadPermissionMap(this.supabase, requesterCtx.user_id);

    const cleanup = new Cleanup(this.supabase, tenantId);
    try {
      // Under canonicalisation the booking IS the bundle — no separate
      // `booking_bundles` row to lazy-create. Use the booking's id as the
      // bundle id throughout (orders, approvals, audit). lazyCreateBundle
      // is gone entirely.
      const bundleId = booking.id;

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
          booking,
          requester_person_id: args.requester_person_id,
          bundle_id: bundleId,
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
              bundle_id: bundleId,
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
      // The `reservation` slot of the rule-evaluation context still uses
      // legacy field names (`reservation.id`, etc.) — that's a context-shape
      // contract owned by ServiceRuleResolverService and untouched by this
      // slice. We pass the booking's id/window/space into those slots so the
      // semantic meaning (the holding being booked) is preserved.
      const outcomes = await this.resolver.resolveBulk({
        lines: perLineOutcomeInputs,
        contextFor: (lineKey) => {
          const line = lineByOli.get(lineKey);
          if (!line) throw new Error(`context lookup failed for ${lineKey}`);
          return buildServiceEvaluationContext({
            requester: requesterCtx,
            bundle: {
              id: bundleId,
              cost_center_id: args.bundle?.cost_center_id ?? null,
              template_id: args.bundle?.template_id ?? null,
              attendee_count: booking.attendee_count ?? null,
            },
            reservation: {
              id: booking.id,                       // booking id (canonical entity)
              space_id: booking.space_id,           // location anchor
              start_at: booking.start_at,
              end_at: booking.end_at,
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
            // ApprovalScope.reservation_ids is the legacy field name — the
            // value is now the booking id (canonical entity). The approvals
            // slice rewrite will rename this field on the routing service.
            reservation_ids: [booking.id],
            order_ids: [scope.order_id],
            order_line_item_ids: [scope.oli_id],
            ticket_ids: scope.ticket_id ? [scope.ticket_id] : [],
            asset_reservation_ids: scope.asset_reservation_id ? [scope.asset_reservation_id] : [],
          },
        };
      });

      // 00278:172 CHECK constraint enforces target_entity_type = 'booking'
      // for booking-anchored approvals; the routing service union now
      // admits 'booking' (approval-routing.service.ts AssembleApprovalsArgs).
      const assembled = await this.approvalRouter.assemble({
        target_entity_type: 'booking',
        target_entity_id: bundleId,
        per_line_outcomes: perLineApproval,
        bundle_context: {
          cost_center_id: args.bundle?.cost_center_id ?? null,
          requester_person_id: args.requester_person_id,
          bundle_id: bundleId,
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
      //
      // Approval interlock (codex 2026-04-30 review): if ANY line is
      // pending approval (anyPending), the order/bundle sits in
      // 'submitted' state until approved. We skip auto-creation entirely
      // here — facilities should not start internal work for orders that
      // may still be rejected. The args are PERSISTED on the OLI so
      // BundleService.onApprovalDecided can re-fire the trigger on grant
      // without re-resolving rules (00197 + handleBookingBundleApprovalDecided).
      const requiresSetup = Array.from(outcomes.entries())
        .filter(([oliId, outcome]) => outcome.requires_internal_setup && lineByOli.has(oliId))
        .map(([oliId, outcome]) => {
          const line = lineByOli.get(oliId)!;
          return {
            oliId,
            outcome,
            args: {
              tenantId,
              bundleId,                           // = booking.id post-canonicalisation
              oliId,
              serviceCategory: line.service_type,
              serviceWindowStartAt: line.service_window_start_at,
              locationId: booking.space_id,
              ruleIds: outcome.matched_rule_ids,
              leadTimeOverride: outcome.internal_setup_lead_time_minutes,
              originSurface: 'bundle' as const,
            },
          };
        });

      if (anyPending) {
        // Persist trigger args on each OLI so onApprovalDecided can re-fire
        // exactly the snapshot that would have fired at create time. If the
        // persist fails, emit a HIGH-severity event instead of the normal
        // deferred marker — codex 2026-04-30 review: leaving the misleading
        // "deferred" audit AND a missing persist means approval-grant later
        // claims nothing and no work order ever fires, with the audit trail
        // saying the opposite.
        for (const { oliId, outcome, args } of requiresSetup) {
          const { error: persistErr } = await this.supabase.admin
            .from('order_line_items')
            .update({ pending_setup_trigger_args: args })
            .eq('id', oliId);
          if (persistErr) {
            this.log.error(
              `failed to persist pending_setup_trigger_args for oli ${oliId}: ${persistErr.message}`,
            );
            void this.audit(
              tenantId,
              'bundle.setup_deferral_persist_failed',
              'order_line_item',
              oliId,
              {
                line_id: oliId,
                bundle_id: bundleId,
                rule_ids: outcome.matched_rule_ids,
                error: persistErr.message,
                severity: 'high',
              },
            );
            continue;
          }
          void this.audit(
            tenantId,
            'bundle.setup_deferred_pending_approval',
            'order_line_item',
            oliId,
            {
              line_id: oliId,
              bundle_id: bundleId,
              rule_ids: outcome.matched_rule_ids,
              reason: 'approval_pending',
            },
          );
        }
      } else {
        await this.setupTrigger.triggerMany(requiresSetup.map((r) => r.args));
      }

      // Audit entity_type stays 'booking_bundle' on existing event_types so
      // pre-rewrite audit consumers keep matching. New events should use
      // 'booking' going forward — adopted here for the new
      // 'booking.services_attached' marker. Historical 'booking_bundle' rows
      // remain immutable (00278:18) and queryable by ops dashboards.
      void this.audit(tenantId, 'bundle.created', 'booking_bundle', bundleId, {
        bundle_id: bundleId,
        booking_id: bundleId,                   // canonical alias (booking.id == bundleId post-rewrite)
        order_ids: orderIds,
        order_line_item_ids: oliIds,
        asset_reservation_ids: assetReservationIds,
        approval_ids: assembled.map((a) => a.target_entity_id),
        any_pending_approval: anyPending,
      });

      return {
        bundle_id: bundleId,
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
   * `addLinesToBundle` — append new service lines to an existing booking.
   *
   * Post-canonicalisation: the bundle IS the booking (00277:27). The legacy
   * `primary_reservation_id` indirection is gone — we delegate straight to
   * `attachServicesToBooking` with the same id. Method name kept so the
   * existing `POST /booking-bundles/:id/lines` endpoint stays callable; the
   * bookings-controller-rewrite slice will rename to `addLinesToBooking` and
   * point the route at `POST /bookings/:id/lines`.
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

    // Verify the booking exists in this tenant before delegating. Returns
    // a clean 404 instead of letting `loadBooking` throw the same shape
    // (which would also work — this is just earlier signalling).
    const { data, error } = await this.supabase.admin
      .from('bookings')
      .select('id')
      .eq('id', args.bundle_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({ code: 'bundle_not_found', message: `Booking ${args.bundle_id} not found.` });
    }

    return this.attachServicesToBooking({
      booking_id: args.bundle_id,
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
      requester_notes?: string | null;
    };
    /**
     * Optimistic-concurrency token. When provided, the UPDATE only succeeds
     * if the row's `updated_at` matches — protecting against stale browser
     * edits that would otherwise overwrite a concurrent change.
     *
     * THREAT MODEL: callers that omit this accept last-write-wins semantics.
     * In practice every browser-driven edit MUST send it (the
     * bundle-services-section line editor threads `line.updated_at` through
     * automatically). The optionality exists for non-interactive callers
     * (admin scripts, server-to-server jobs) that have already taken a
     * fresher read before deciding to write. The reviewer-rule: any new
     * caller that touches `requester_notes`, `quantity`, or
     * `service_window_*` from a UI surface must include this token, or
     * the review is wrong. There's no DB-level enforcement — this is a
     * code-review contract, not a constraint.
     */
    expected_updated_at?: string | null;
  }): Promise<{ line_id: string; quantity: number; line_total: number | null; service_window_start_at: string | null; service_window_end_at: string | null; requester_notes: string | null; updated_at: string }> {
    const tenantId = TenantContext.current().id;

    // Shape-validate the patch BEFORE any DB hit. The PATCH endpoint
    // accepts a JSON body without class-validator (project convention —
    // see room-booking-rules/dto/index.ts comment). Without this, a
    // client could send `expected_updated_at: 12345` and Postgres would
    // try to cast a number to timestamp at write time, surfacing as a
    // 500 instead of a clean 400. Same risk for `requester_notes:
    // {evil:1}` reaching .trim() further down. Validate explicitly.
    if (args.patch.quantity !== undefined && (typeof args.patch.quantity !== 'number' || !Number.isFinite(args.patch.quantity))) {
      throw new BadRequestException({ code: 'invalid_quantity', message: 'quantity must be a finite number.' });
    }
    if (
      args.patch.service_window_start_at !== undefined &&
      args.patch.service_window_start_at !== null &&
      (typeof args.patch.service_window_start_at !== 'string' || Number.isNaN(Date.parse(args.patch.service_window_start_at)))
    ) {
      throw new BadRequestException({ code: 'invalid_service_window_start_at', message: 'service_window_start_at must be an ISO string or null.' });
    }
    if (
      args.patch.service_window_end_at !== undefined &&
      args.patch.service_window_end_at !== null &&
      (typeof args.patch.service_window_end_at !== 'string' || Number.isNaN(Date.parse(args.patch.service_window_end_at)))
    ) {
      throw new BadRequestException({ code: 'invalid_service_window_end_at', message: 'service_window_end_at must be an ISO string or null.' });
    }
    if (
      args.patch.requester_notes !== undefined &&
      args.patch.requester_notes !== null &&
      (typeof args.patch.requester_notes !== 'string' || args.patch.requester_notes.length > 2000)
    ) {
      throw new BadRequestException({ code: 'invalid_requester_notes', message: 'requester_notes must be a string ≤ 2000 chars or null.' });
    }
    if (
      args.expected_updated_at !== undefined &&
      args.expected_updated_at !== null &&
      (typeof args.expected_updated_at !== 'string' || Number.isNaN(Date.parse(args.expected_updated_at)))
    ) {
      throw new BadRequestException({ code: 'invalid_expected_updated_at', message: 'expected_updated_at must be an ISO string or null.' });
    }

    const { data: existing, error: loadErr } = await this.supabase.admin
      .from('order_line_items')
      .select('id, tenant_id, order_id, quantity, unit_price, line_total, service_window_start_at, service_window_end_at, requester_notes, updated_at, fulfillment_status, linked_ticket_id')
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
      requester_notes: string | null;
      updated_at: string;
      fulfillment_status: string;
      linked_ticket_id: string | null;
    };

    if (args.expected_updated_at && args.expected_updated_at !== line.updated_at) {
      throw new ConflictException({
        code: 'line_state_changed',
        message: 'This line was updated by someone else while you were editing. Reload to see the latest state.',
      });
    }

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
    if (args.patch.requester_notes !== undefined) {
      // Empty string normalizes to null so display logic stays binary.
      const next = args.patch.requester_notes === null ? null : args.patch.requester_notes.trim() || null;
      if (next !== line.requester_notes) {
        update.requester_notes = next;
      }
    }

    if (Object.keys(update).length === 0) {
      // No-op; return current state.
      return {
        line_id: line.id,
        quantity: line.quantity,
        line_total: line.line_total,
        service_window_start_at: line.service_window_start_at,
        service_window_end_at: line.service_window_end_at,
        requester_notes: line.requester_notes,
        updated_at: line.updated_at,
      };
    }

    // Optimistic concurrency: refuse to write if another caller has advanced
    // the line into a frozen state between our SELECT and UPDATE. The
    // `.eq('fulfillment_status', line.fulfillment_status)` clause turns a
    // would-be silent override into a 0-row result we surface as 409.
    // CAS: refuse if the line moved into a frozen state OR (when the caller
    // provided expected_updated_at) if updated_at no longer matches. The
    // second clause closes the race between our SELECT above and this
    // UPDATE for stale-browser writes.
    let updateQuery = this.supabase.admin
      .from('order_line_items')
      .update(update)
      .eq('id', line.id)
      .eq('tenant_id', tenantId)
      .eq('fulfillment_status', line.fulfillment_status);
    if (args.expected_updated_at) {
      updateQuery = updateQuery.eq('updated_at', args.expected_updated_at);
    }
    const { data: updated, error: updateErr } = await updateQuery
      .select('id, quantity, line_total, service_window_start_at, service_window_end_at, requester_notes, updated_at')
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      throw new ConflictException({
        code: 'line_state_changed',
        message: 'This line was updated by someone else while you were editing. Reload to see the latest state.',
      });
    }
    const u = updated as { id: string; quantity: number; line_total: number | null; service_window_start_at: string | null; service_window_end_at: string | null; requester_notes: string | null; updated_at: string };

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
        // Match cancel-cascade whitelist (bundle-cascade.service.ts) — see
        // the comment there for the schema-history reasoning.
        const NON_TERMINAL = ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'];
        // Step 1c.4 cutover: read+write work_orders directly.
        const { data: linkedWos } = await this.supabase.admin
          .from('work_orders')
          .select('id, sla_resolution_due_at')
          .eq('linked_order_line_item_id', line.id)
          .eq('tenant_id', tenantId)
          .in('status_category', NON_TERMINAL);
        for (const wo of (linkedWos ?? []) as Array<{ id: string; sla_resolution_due_at: string | null }>) {
          if (!wo.sla_resolution_due_at) continue;
          const shifted = new Date(
            new Date(wo.sla_resolution_due_at).getTime() + deltaMs,
          ).toISOString();
          await this.supabase.admin
            .from('work_orders')
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

    // Slice 4: emit bundle.line.moved when the service window's start time
    // shifted. v1 doesn't expose room changes through this path (the line's
    // room is on the parent reservation; ReservationService.editOne handles
    // that), so we only emit `bundle.line.moved` here.
    //
    // Visitor lines aren't order_line_items in v1 — the visitor adapter
    // skips line_kind != 'visitor', so this emit is a no-op for visitors
    // by design. We still resolve the catering/AV kind so downstream
    // subscribers (future workstreams) can filter accurately.
    //
    // Resolve bundle_id by walking line → order → bundle. Skipped (no emit)
    // if the line isn't bundle-attached.
    if (oldStart && newStart && oldStart !== newStart) {
      const bundleId = await this.bundleIdForOrder(line.order_id, tenantId);
      if (bundleId) {
        this.emitEvent({
          kind: 'bundle.line.moved',
          tenant_id: tenantId,
          bundle_id: bundleId,
          line_id: line.id,
          line_kind: await this.lineKindForOli(line.id, tenantId),
          old_expected_at: oldStart,
          new_expected_at: newStart,
          occurred_at: new Date().toISOString(),
        });
      }
    }

    return {
      line_id: u.id,
      quantity: u.quantity,
      line_total: u.line_total,
      service_window_start_at: u.service_window_start_at,
      service_window_end_at: u.service_window_end_at,
      requester_notes: u.requester_notes,
      updated_at: u.updated_at,
    };
  }

  /**
   * `getBookingDetail` — read a booking's services + cascaded work-orders for
   * the booking-detail surface. Replaces the `GET /booking-bundles/:id`
   * endpoint (deleted with the bundles controller in this rewrite slice);
   * the booking IS the bundle now (00277:27), so the input is a booking id.
   *
   * Visibility: caller's responsibility — controllers must `assertVisible`
   * BEFORE calling. This method assumes the read is already authorized
   * because the matching reservation/booking detail endpoints already gate
   * via their own visibility services and we don't want to double-check
   * (the column shape on `bookings` is the same the visibility check
   * consumes — `requester_person_id` / `host_person_id` / `location_id`).
   *
   * Status rollup:
   *   pre-rewrite this came from the `booking_bundle_status_v` view (dropped
   *   in 00276:40). The simple line-status rollup is reproduced inline here:
   *     all-cancelled               → 'cancelled'
   *     mixed cancelled + active    → 'partially_cancelled'
   *     any pending approval        → 'pending_approval'   (reads booking.status)
   *     all delivered               → 'completed'
   *     otherwise                   → 'confirmed'
   *   Empty bundles (no lines yet) bubble up the booking's own `status`
   *   ('pending_approval' / 'confirmed' / 'cancelled') so the UI's status
   *   pill still reads truthfully on a booking with no services.
   */
  async getBookingDetail(bookingId: string): Promise<BookingDetail> {
    const tenantId = TenantContext.current().id;

    // 1. The booking row itself (also confirms tenant-scope existence).
    const { data: bookingRow, error: bookingErr } = await this.supabase.admin
      .from('bookings')
      .select(
        // 00277:27 — every column the legacy `BookingBundle` shape echoed
        // back to the frontend. `location_id` (00277:41) replaces the legacy
        // bundle.location_id; identical semantics.
        'id, tenant_id, requester_person_id, host_person_id, location_id, ' +
          'start_at, end_at, timezone, source, status, ' +
          'cost_center_id, template_id, calendar_event_id, policy_snapshot, ' +
          'created_at, updated_at',
      )
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (bookingErr) throw bookingErr;
    if (!bookingRow) {
      throw new NotFoundException({
        code: 'booking_not_found',
        message: `Booking ${bookingId} not found.`,
      });
    }
    const booking = bookingRow as unknown as {
      id: string;
      tenant_id: string;
      requester_person_id: string;
      host_person_id: string | null;
      location_id: string;
      start_at: string;
      end_at: string;
      timezone: string | null;
      source: string;
      status: string;
      cost_center_id: string | null;
      template_id: string | null;
      calendar_event_id: string | null;
      policy_snapshot: Record<string, unknown>;
      created_at: string;
      updated_at: string;
    };

    // 2. Orders + work_orders in parallel. Both use the renamed
    //    `booking_id` FK (00278:109 for orders, 00278:87 for work_orders).
    //    Work-order joins denormalize the assignee label so the frontend
    //    doesn't need a second round-trip per ticket.
    const [ordersRes, workOrdersRes] = await Promise.all([
      this.supabase.admin
        .from('orders')
        .select('id, status, requested_for_start_at, requested_for_end_at')
        .eq('booking_id', bookingId)
        .eq('tenant_id', tenantId),
      this.supabase.admin
        .from('work_orders')
        .select(
          // module_number from 00213:118 (alloced via tickets_assign_module_number trigger);
          // assignee fields per 00213:71-74; status_category 00213:53.
          'id, status_category, assigned_user_id, assigned_team_id, assigned_vendor_id, module_number, ' +
            'assigned_user:users!assigned_user_id(person:persons!person_id(first_name,last_name)), ' +
            'assigned_team:teams!assigned_team_id(name), ' +
            'assigned_vendor:vendors!assigned_vendor_id(name)',
        )
        .eq('booking_id', bookingId)
        .eq('tenant_id', tenantId),
    ]);
    if (ordersRes.error) throw ordersRes.error;
    if (workOrdersRes.error) throw workOrdersRes.error;

    const orders = (ordersRes.data ?? []) as Array<{
      id: string;
      status: string;
      requested_for_start_at: string | null;
      requested_for_end_at: string | null;
    }>;
    const orderIds = orders.map((o) => o.id);

    // 3. Lines (a second round-trip; unavoidable without a SQL function
    //    because PostgREST doesn't let us join order_line_items via the
    //    booking → orders → lines path in one query without losing the
    //    catalog_item name embed).
    type LineRow = {
      id: string;
      order_id: string;
      catalog_item_id: string;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      requester_notes: string | null;
      updated_at: string;
      // 00013:82 — fulfillment_status enum (ordered/confirmed/preparing/delivered/cancelled).
      fulfillment_status: 'ordered' | 'confirmed' | 'preparing' | 'delivered' | 'cancelled' | null;
      linked_ticket_id: string | null;
      linked_asset_reservation_id: string | null;
      catalog_item: { name: string } | { name: string }[] | null;
    };
    let lines: BundleLineDetail[] = [];
    if (orderIds.length > 0) {
      const linesRes = await this.supabase.admin
        .from('order_line_items')
        .select(
          'id, order_id, catalog_item_id, quantity, unit_price, line_total, ' +
            'service_window_start_at, service_window_end_at, requester_notes, ' +
            'updated_at, fulfillment_status, linked_ticket_id, linked_asset_reservation_id, ' +
            'catalog_item:catalog_items(name)',
        )
        .in('order_id', orderIds)
        .eq('tenant_id', tenantId);
      if (linesRes.error) throw linesRes.error;
      lines = ((linesRes.data ?? []) as unknown as LineRow[]).map((row) => {
        const ci = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
        return {
          id: row.id,
          order_id: row.order_id,
          catalog_item_id: row.catalog_item_id,
          catalog_item_name: ci?.name ?? null,
          quantity: row.quantity,
          unit_price: row.unit_price,
          line_total: row.line_total,
          service_window_start_at: row.service_window_start_at,
          service_window_end_at: row.service_window_end_at,
          requester_notes: row.requester_notes,
          updated_at: row.updated_at,
          fulfillment_status: row.fulfillment_status,
          linked_ticket_id: row.linked_ticket_id,
          linked_asset_reservation_id: row.linked_asset_reservation_id,
        };
      });
    }

    // 4. Denormalized assignee label per work_order. Mirrors the legacy
    //    controller's join handling so the frontend BundleTicketRef shape
    //    is unchanged. `ticket_kind` is synthesized as 'work_order' — the
    //    column was dropped in step 1c.10c (every row in `work_orders` is
    //    a work order by table-membership), but the frontend still
    //    branches on it.
    type WorkOrderRow = {
      id: string;
      status_category: string | null;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      assigned_vendor_id: string | null;
      module_number: number | null;
      assigned_user?:
        | { person?: { first_name: string | null; last_name: string | null } | null }
        | null;
      assigned_team?: { name: string | null } | null;
      assigned_vendor?: { name: string | null } | null;
    };
    const tickets: BundleTicketDetail[] = (
      (workOrdersRes.data ?? []) as unknown as WorkOrderRow[]
    ).map((wo) => {
      const userPerson = wo.assigned_user?.person ?? null;
      const userName = userPerson
        ? `${userPerson.first_name ?? ''} ${userPerson.last_name ?? ''}`.trim()
        : null;
      const assignee_label = wo.assigned_vendor_id
        ? wo.assigned_vendor?.name ?? 'Vendor'
        : wo.assigned_team_id
          ? wo.assigned_team?.name ?? 'Team'
          : wo.assigned_user_id
            ? userName || 'User'
            : null;
      return {
        id: wo.id,
        ticket_kind: 'work_order' as const,
        status_category: wo.status_category,
        assigned_user_id: wo.assigned_user_id,
        assigned_team_id: wo.assigned_team_id,
        assigned_vendor_id: wo.assigned_vendor_id,
        module_number: wo.module_number,
        assignee_label,
      };
    });

    return {
      ...booking,
      status_rollup: this.computeStatusRollup(booking.status, lines),
      orders,
      tickets,
      lines,
    };
  }

  /**
   * Reproduces the rollup the dropped `booking_bundle_status_v` view used to
   * compute. Called by `getBookingDetail`; not exposed.
   *
   *   - Empty bundle → bubble booking.status (so a 'pending_approval' booking
   *     with no lines still surfaces as 'pending_approval', not 'confirmed').
   *   - Any line in 'cancelled' AND every other line in 'cancelled' → 'cancelled'.
   *   - Mix of cancelled + non-cancelled → 'partially_cancelled'.
   *   - Booking itself pending approval → 'pending_approval' wins.
   *   - All non-cancelled lines delivered → 'completed'.
   *   - Otherwise → 'confirmed'.
   */
  private computeStatusRollup(
    bookingStatus: string,
    lines: BundleLineDetail[],
  ): BundleStatusRollup {
    if (bookingStatus === 'cancelled') return 'cancelled';
    if (bookingStatus === 'pending_approval') return 'pending_approval';
    if (lines.length === 0) {
      // Map the booking's own status to a rollup label the frontend
      // recognises. 'completed' / 'confirmed' / 'cancelled' / 'pending_approval'
      // all already map 1:1; 'draft'/'checked_in'/'released' fall back to
      // 'pending' (the only safe neutral the frontend renders).
      if (bookingStatus === 'completed') return 'completed';
      if (bookingStatus === 'confirmed') return 'confirmed';
      return 'pending';
    }
    const cancelled = lines.filter((l) => l.fulfillment_status === 'cancelled');
    const active = lines.filter((l) => l.fulfillment_status !== 'cancelled');
    if (cancelled.length === lines.length) return 'cancelled';
    if (cancelled.length > 0 && active.length > 0) return 'partially_cancelled';
    if (active.every((l) => l.fulfillment_status === 'delivered')) return 'completed';
    return 'confirmed';
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Load the booking row that services will attach to. Reads from `bookings`
   * (00277:27); the legacy `loadReservation` against `reservations` was
   * dropped with the table.
   *
   * The local `BookingRow` shape preserves the field names the rest of this
   * service uses, with `space_id` mapped from `bookings.location_id`
   * (00277:41). Bundle-level booking has no per-slot `space_id` — the
   * location anchor IS the space for the v1 single-slot path. Multi-slot
   * bookings (when MultiRoomBookingService rewrites) will need to pick a
   * primary slot's space_id; v1 keeps the single-slot mapping.
   */
  private async loadBooking(id: string): Promise<BookingRow> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('bookings')
      .select('id, tenant_id, location_id, requester_person_id, host_person_id, start_at, end_at, source')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({ code: 'booking_not_found', message: `Booking ${id} not found.` });
    }
    const row = data as {
      id: string;
      tenant_id: string;
      location_id: string;
      requester_person_id: string;
      host_person_id: string | null;
      start_at: string;
      end_at: string;
      source: string | null;
    };

    // Pull attendee_count from the booking's primary slot (lowest
    // display_order, 00277:154). Multi-slot bookings would want per-slot
    // counts; the v1 single-slot path collapses to one row.
    const { data: slot } = await this.supabase.admin
      .from('booking_slots')
      .select('attendee_count')
      .eq('booking_id', id)
      .eq('tenant_id', tenantId)
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();

    return {
      id: row.id,
      tenant_id: row.tenant_id,
      space_id: row.location_id,
      requester_person_id: row.requester_person_id,
      host_person_id: row.host_person_id,
      start_at: row.start_at,
      end_at: row.end_at,
      attendee_count: (slot as { attendee_count: number | null } | null)?.attendee_count ?? null,
      booking_bundle_id: row.id,                  // booking IS the bundle now
      source: row.source,
    };
  }

  private async hydrateLines(inputs: ServiceLineInput[], booking: BookingRow): Promise<HydratedLine[]> {
    const out: HydratedLine[] = [];
    const now = Date.now();
    const tenantId = booking.tenant_id;
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
        p_delivery_space_id: booking.space_id,
        p_on_date: booking.start_at.slice(0, 10),
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

      const startAt = input.service_window_start_at ?? booking.start_at;
      const endAt = input.service_window_end_at ?? booking.end_at;
      const leadRemaining = (Date.parse(startAt) - now) / 3_600_000; // hours

      // Server-side lead-time guard. The picker (service-picker-sheet)
      // already disables items whose `lead_time_hours` exceeds remaining
      // time, but that's a UX layer — any non-portal write path (admin
      // tools, future bulk-edit, server-to-server) bypasses it. This
      // hard gate catches those. Only fires when the menu offer carries
      // an explicit lead_time_hours; offer-less items (catalog default
      // pricing) skip the check the same way they did before.
      if (
        offerRow?.lead_time_hours != null &&
        offerRow.lead_time_hours > leadRemaining
      ) {
        throw new BadRequestException({
          code: 'lead_time_violation',
          message: `Service requires ${offerRow.lead_time_hours}h advance notice; only ${leadRemaining.toFixed(1)}h remain. Move the meeting later or remove this service.`,
        });
      }

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

  // lazyCreateBundle removed: post-canonicalisation the booking IS the
  // bundle (00277:27). Bookings are created upstream by
  // BookingFlowService.create via the create_booking RPC; service attach
  // never needs to materialise a bundle row of its own.

  /**
   * Create one `orders` row keyed to the booking + the booking's primary
   * slot. Column renames from 00278:108-118:
   *   - orders.booking_bundle_id  → orders.booking_id     (FK to bookings.id)
   *   - orders.linked_reservation_id → orders.linked_slot_id (FK to booking_slots.id)
   *
   * `linked_slot_id` is intentionally null in v1 — the bundle service
   * doesn't track which booking_slot a service line belongs to (multi-slot
   * bookings are out of scope until MultiRoomBookingService rewrites). The
   * column is nullable on the new schema (00278:117 — on delete set null).
   * Wired up properly when the multi-room slice resumes.
   */
  private async createOrder(args: {
    tenantId: string;
    booking: BookingRow;
    requester_person_id: string;
    bundle_id: string;
    service_type: string;
  }): Promise<{ id: string }> {
    const { data, error } = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: args.tenantId,
        requester_person_id: args.requester_person_id,
        booking_id: args.bundle_id,                 // = booking.id; column renamed 00278:109
        linked_slot_id: null,                       // multi-slot tracking deferred (see comment above)
        delivery_location_id: args.booking.space_id,
        delivery_date: args.booking.start_at.slice(0, 10),
        requested_for_start_at: args.booking.start_at,
        requested_for_end_at: args.booking.end_at,
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
        booking_id: args.bundle_id,                 // = booking.id; column renamed 00278:136
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


  /**
   * Approval-decided handler. Called by ApprovalService.respondToApproval
   * once a `target_entity_type='booking_bundle'` approval row has resolved
   * (single-step decision OR final-step / parallel-group completion). Both
   * the bundle and standalone-order paths use `'booking_bundle'` as the
   * target type, so this handles them uniformly.
   *
   * On approve:
   *   - Flip every linked order from 'submitted' → 'approved' (idempotent —
   *     orders that already moved on don't get re-stamped).
   *   - Re-fire the deferred setup-work-order trigger for any OLI whose
   *     `pending_setup_trigger_args` was persisted at create time. The args
   *     are a snapshot from creation, so we don't re-resolve rules here.
   *   - Clear `pending_setup_trigger_args` once fired (one-shot).
   *   - Audit `bundle.deferred_setup_fired_on_approval` with the OLI list.
   *
   * On reject:
   *   - Flip linked orders 'submitted' → 'cancelled'.
   *   - Clear `pending_setup_trigger_args` (no longer relevant — line is dead).
   *   - Audit `bundle.deferred_setup_dropped_on_rejection`.
   *
   * Idempotency: safe to call multiple times. Order status updates filter on
   * `status='submitted'`, OLI updates filter on the persisted args being
   * present. A second invocation is a no-op.
   *
   * Failure posture: never throws. Approval-side audit + state already
   * landed before this is called; partial failures here are logged + audited
   * separately so admins can re-fire manually if needed. Same posture as
   * the create-time trigger.
   */
  async onApprovalDecided(
    bundleId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const tenantId = TenantContext.current().id;

    // Column rename: orders.booking_bundle_id → orders.booking_id (00278:109).
    // bundleId is the booking id under canonicalisation.
    const { data: orders, error: ordersErr } = await this.supabase.admin
      .from('orders')
      .select('id, status')
      .eq('tenant_id', tenantId)
      .eq('booking_id', bundleId);

    if (ordersErr) {
      this.log.error(
        `onApprovalDecided: failed to load orders for bundle ${bundleId}: ${ordersErr.message}`,
      );
      return;
    }
    if (!orders || orders.length === 0) {
      // Standalone-order path uses target_entity_id=bundle.id and creates a
      // bundle even though there's no reservation, so this should not
      // happen. Defensive: audit + return.
      void this.audit(
        tenantId,
        `bundle.approval_${decision}_no_orders`,
        'booking_bundle',
        bundleId,
        { bundle_id: bundleId },
      );
      return;
    }

    const orderIds = orders.map((o) => o.id);
    const newOrderStatus = decision === 'approved' ? 'approved' : 'cancelled';

    const { error: orderUpdateErr } = await this.supabase.admin
      .from('orders')
      .update({ status: newOrderStatus })
      .in('id', orderIds)
      .eq('status', 'submitted');
    if (orderUpdateErr) {
      this.log.error(
        `onApprovalDecided: failed to update orders status for bundle ${bundleId}: ${orderUpdateErr.message}`,
      );
    }

    // On rejection: expire sibling approval rows that were still pending
    // BEFORE we touch deferred OLIs. Without this, a bundle with multiple
    // approvers but no requires_internal_setup lines would skip the expire
    // step entirely, leaving peers stuck in their pending queues.
    if (decision === 'rejected') {
      const { error: expireErr } = await this.supabase.admin
        .from('approvals')
        .update({
          status: 'expired',
          responded_at: new Date().toISOString(),
          comments: 'Sibling approval rejected; bundle no longer needs approval.',
        })
        .eq('tenant_id', tenantId)
        .eq('target_entity_id', bundleId)
        .eq('status', 'pending');
      if (expireErr) {
        this.log.error(
          `onApprovalDecided: failed to expire sibling approvals for bundle ${bundleId}: ${expireErr.message}`,
        );
      }
    }

    // Atomic claim: SELECT FOR UPDATE inside the RPC ensures only one
    // caller can claim a given OLI's args, even when two approvers grant
    // truly concurrently across multiple API instances. Returns one row
    // per claimed OLI with the OLD args value (the RPC nulls them in the
    // same statement). The previous read-then-clear pattern allowed a
    // double-fire window between the read and the clear — see 00198.
    const { data: claimed, error: claimErr } = await this.supabase.admin.rpc(
      'claim_deferred_setup_trigger_args',
      {
        p_tenant_id: tenantId,
        p_order_ids: orderIds,
      },
    );
    if (claimErr) {
      this.log.error(
        `onApprovalDecided: failed to claim deferred trigger args for bundle ${bundleId}: ${claimErr.message}`,
      );
      return;
    }

    const claimedRows = (claimed ?? []) as Array<{
      oli_id: string;
      args: TriggerArgs | null;
    }>;

    if (claimedRows.length === 0) {
      // Three reasons we'd see zero claimed rows:
      //   (a) the bundle had approval-required rules WITHOUT
      //       requires_internal_setup — nothing to defer, nothing to fire.
      //       Normal — emit the "no_deferred_setup" marker.
      //   (b) another caller already claimed everything (idempotency on a
      //       duplicate call). Same marker — both calls audit the
      //       observation; downstream effects already happened on the first.
      //   (c) the create-time persist actually FAILED for one or more
      //       lines (`*.setup_deferral_persist_failed` was emitted) — the
      //       work order won't fire on grant because no args ever landed.
      //       Emitting "no_deferred_setup" here would lie about the timeline.
      //
      // Check (c) by looking up persist-failure audit events for this
      // bundle. If any exist, emit a high-severity marker instead so admins
      // can spot the lost setup at approval time. Codex 2026-04-30 review.
      const { data: persistFailures } = await this.supabase.admin
        .from('audit_events')
        .select('id')
        .eq('tenant_id', tenantId)
        .in('event_type', ['bundle.setup_deferral_persist_failed', 'order.setup_deferral_persist_failed'])
        .eq('details->>bundle_id', bundleId)
        .limit(1);
      const hadPersistFailure = (persistFailures ?? []).length > 0;

      if (hadPersistFailure) {
        void this.audit(
          tenantId,
          `bundle.approval_${decision}_setup_persist_was_lost`,
          'booking_bundle',
          bundleId,
          {
            bundle_id: bundleId,
            order_ids: orderIds,
            severity: 'high',
            reason: 'create_time_persist_failed_no_args_to_claim',
          },
        );
      } else {
        void this.audit(
          tenantId,
          `bundle.approval_${decision}_no_deferred_setup`,
          'booking_bundle',
          bundleId,
          { bundle_id: bundleId, order_ids: orderIds },
        );
      }
      return;
    }

    const oliIds = claimedRows.map((r) => r.oli_id);

    if (decision === 'approved') {
      const triggerArgs = claimedRows
        .map((r) => r.args)
        .filter((a): a is TriggerArgs => a !== null);
      await this.setupTrigger.triggerMany(triggerArgs);

      // Cancel/approve race guard. The atomic claim above prevents two
      // approve-side callers from racing each other. But it does NOT
      // coordinate with the cancel cascade, which can run between the
      // claim returning and triggerMany inserting the work order:
      //
      //   1. Claim RPC commits (args nulled, returned).
      //   2. cancelLine runs: closes existing tickets WHERE linked_oli=A
      //      (none yet — the trigger hasn't inserted), updates OLI status
      //      to 'cancelled'.
      //   3. triggerMany inserts a NEW ticket with linked_oli=A.
      //
      // Result: an open work order linked to a cancelled line. Codex
      // 2026-04-30 review caught this. Defensive close: re-run the
      // cancel cascade's tickets-close clause for any of the just-fired
      // OLIs that are now in fulfillment_status='cancelled'. Idempotent
      // and scoped — no-op when the race didn't happen.
      //
      // Errors on either query are surfaced (log + high-severity audit)
      // rather than swallowed. This whole block exists specifically to
      // close a correctness hole; silent best-effort would defeat the
      // point. Codex round 3 review.
      const { data: stale, error: staleErr } = await this.supabase.admin
        .from('order_line_items')
        .select('id')
        .in('id', oliIds)
        .eq('fulfillment_status', 'cancelled');
      if (staleErr) {
        this.log.error(
          `onApprovalDecided: cancel-race lookup failed for bundle ${bundleId}: ${staleErr.message}`,
        );
        void this.audit(
          tenantId,
          'bundle.deferred_setup_close_lookup_failed',
          'booking_bundle',
          bundleId,
          {
            bundle_id: bundleId,
            oli_ids: oliIds,
            error: staleErr.message,
            severity: 'high',
          },
        );
      }
      const staleOliIds = ((stale ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (staleOliIds.length > 0) {
        // Step 1c.4 cutover: target work_orders directly.
        const { data: closedTickets, error: closeErr } = await this.supabase.admin
          .from('work_orders')
          .update({ status_category: 'closed', closed_at: new Date().toISOString() })
          .in('linked_order_line_item_id', staleOliIds)
          .eq('tenant_id', tenantId)
          .in('status_category', ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'])
          .select('id');
        if (closeErr) {
          this.log.error(
            `onApprovalDecided: cancel-race close failed for bundle ${bundleId}: ${closeErr.message}`,
          );
          void this.audit(
            tenantId,
            'bundle.deferred_setup_close_failed',
            'booking_bundle',
            bundleId,
            {
              bundle_id: bundleId,
              oli_ids: staleOliIds,
              error: closeErr.message,
              severity: 'high',
            },
          );
        }
        const closedTicketIds = ((closedTickets ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (closedTicketIds.length > 0) {
          void this.audit(
            tenantId,
            'bundle.deferred_setup_closed_after_concurrent_cancel',
            'booking_bundle',
            bundleId,
            {
              bundle_id: bundleId,
              oli_ids: staleOliIds,
              ticket_ids: closedTicketIds,
              severity: 'medium',
            },
          );
        }
      }

      void this.audit(
        tenantId,
        'bundle.deferred_setup_fired_on_approval',
        'booking_bundle',
        bundleId,
        {
          bundle_id: bundleId,
          oli_ids: oliIds,
          order_ids: orderIds,
        },
      );
    } else {
      // The args were already cleared by the RPC's atomic claim. We just
      // record that the deferral was dropped without firing.
      void this.audit(
        tenantId,
        'bundle.deferred_setup_dropped_on_rejection',
        'booking_bundle',
        bundleId,
        {
          bundle_id: bundleId,
          oli_ids: oliIds,
          order_ids: orderIds,
        },
      );
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

  /**
   * Slice 4: best-effort emit. Subscribers run async; their failures are
   * isolated by the bus subscription. We still wrap the synchronous
   * `emit` in try/catch so a misbehaving sync subscriber can't bubble
   * back into editLine after the DB write already landed.
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
   * Resolve bundle_id (= booking_id under canonicalisation) from an order
   * id with tenant defence. Returns null when the order isn't booking-attached
   * or doesn't exist; callers skip the emit in that case.
   *
   * Column rename: orders.booking_bundle_id → orders.booking_id (00278:109).
   */
  private async bundleIdForOrder(orderId: string, tenantId: string): Promise<string | null> {
    try {
      const { data } = await this.supabase.admin
        .from('orders')
        .select('booking_id')
        .eq('id', orderId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      return ((data as { booking_id: string | null } | null)?.booking_id) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Map order_line_items.policy_snapshot.service_type to a BundleLineKind.
   * Mirrors BundleCascadeService.lineKindForOli — kept in sync there.
   * Visitors are not order_line_items in v1, so 'visitor' is never returned.
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
      return 'other';
    } catch {
      return 'other';
    }
  }
}

// ── Local types ───────────────────────────────────────────────────────────

/**
 * Status rollup string the frontend's BundleStatusRollup union expects.
 * Mirrors `apps/web/src/api/booking-bundles/types.ts` so wire-shape parity
 * doesn't need a separate package.
 */
export type BundleStatusRollup =
  | 'pending'
  | 'pending_approval'
  | 'confirmed'
  | 'partially_cancelled'
  | 'cancelled'
  | 'completed';

/**
 * Per-line shape returned by `getBookingDetail`. Mirrors the legacy
 * `BundleLine` projection — column list at the SELECT in `getBookingDetail`.
 */
export interface BundleLineDetail {
  id: string;
  order_id: string;
  catalog_item_id: string;
  /** Pulled from the embedded `catalog_items.name`; null if the catalog row
   *  was deleted (rare; soft-delete is the norm on the catalog side). */
  catalog_item_name: string | null;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  requester_notes: string | null;
  /** Optimistic-concurrency token for `editLine`. */
  updated_at: string;
  fulfillment_status:
    | 'ordered'
    | 'confirmed'
    | 'preparing'
    | 'delivered'
    | 'cancelled'
    | null;
  linked_ticket_id: string | null;
  linked_asset_reservation_id: string | null;
}

/**
 * Per-ticket (work-order today; cases later) shape. `ticket_kind` is
 * synthesized as 'work_order' — the underlying column was dropped at step
 * 1c.10c, but the frontend BundleTicketRef still branches on it.
 */
export interface BundleTicketDetail {
  id: string;
  ticket_kind: 'work_order';
  status_category: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  module_number: number | null;
  /** Pre-computed assignee label so the frontend doesn't need a second
   *  round-trip per ticket — vendor name | team name | user full name. */
  assignee_label: string | null;
}

/**
 * `BookingDetail` — return shape of `getBookingDetail`. Echoes the booking
 * row's columns plus the cascaded entity arrays. Stays close to the legacy
 * `GET /booking-bundles/:id` payload so the existing frontend BundleData
 * type continues to compile (only delta: the empty-bundle case used to
 * return zero lines/tickets/orders, which this method also does).
 */
export interface BookingDetail {
  id: string;
  tenant_id: string;
  requester_person_id: string;
  host_person_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  source: string;
  status: string;
  cost_center_id: string | null;
  template_id: string | null;
  calendar_event_id: string | null;
  policy_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  status_rollup: BundleStatusRollup;
  orders: Array<{
    id: string;
    status: string;
    requested_for_start_at: string | null;
    requested_for_end_at: string | null;
  }>;
  tickets: BundleTicketDetail[];
  lines: BundleLineDetail[];
}

/**
 * In-service projection of a Booking + its primary slot, hand-built by
 * `loadBooking`. Field names preserve the legacy `space_id` / `attendee_count`
 * naming so the rest of this service reads naturally; the actual columns in
 * Postgres are `bookings.location_id` (00277:41) and
 * `booking_slots.attendee_count` (00277:138). `booking_bundle_id` is set to
 * the booking's own id (canonicalisation: booking IS the bundle).
 */
interface BookingRow {
  id: string;
  tenant_id: string;
  space_id: string;                         // mapped from bookings.location_id
  requester_person_id: string;
  host_person_id: string | null;
  start_at: string;
  end_at: string;
  attendee_count: number | null;            // pulled from primary slot
  booking_bundle_id: string | null;         // = id (legacy alias for in-service code)
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
//
// Post-canonicalisation: there is no booking-row creation in this service
// (the booking is created upstream by BookingFlowService.create via the
// create_booking RPC, atomically with its slots). Cleanup only undoes the
// service-attach-side artefacts — order_line_items, asset_reservations,
// orders, and any pre-deny approvals routed by ApprovalRoutingService.
// The booking row stays as-is on rollback (it's the user's room
// reservation; deleting it because services failed would surprise them).
class Cleanup {
  private orderIds: string[] = [];
  private oliIds: string[] = [];
  private assetReservationIds: string[] = [];
  private done = false;

  constructor(
    private readonly supabase: SupabaseService,
    // Defense-in-depth per the project's #0 invariant: admin-client writes
    // filter by tenant_id explicitly even though uuid id collisions are
    // practically impossible. Caller threads the booking's tenant id.
    private readonly tenantId: string,
  ) {}

  order(id: string) { this.orderIds.push(id); }
  orderLineItem(id: string) { this.oliIds.push(id); }
  assetReservation(id: string) { this.assetReservationIds.push(id); }

  commit() { this.done = true; }

  async rollback() {
    if (this.done) return;
    // Reverse-creation order: oli → asset_reservation → orders → approvals.
    // Each step is independent — a failure in step N shouldn't skip step
    // N+1. Best effort: each branch in its own try/catch. Every write is
    // tenant-scoped (#0 invariant).
    const failures: string[] = [];
    if (this.oliIds.length > 0) {
      try {
        await this.supabase.admin
          .from('order_line_items')
          .delete()
          .eq('tenant_id', this.tenantId)
          .in('id', this.oliIds);
      } catch (err) {
        failures.push(`oli: ${(err as Error).message}`);
      }
    }
    if (this.assetReservationIds.length > 0) {
      // Soft-delete via status='cancelled' so the GiST exclusion stops
      // blocking; matches the room-side rollback semantics.
      try {
        await this.supabase.admin
          .from('asset_reservations')
          .update({ status: 'cancelled' })
          .eq('tenant_id', this.tenantId)
          .in('id', this.assetReservationIds);
      } catch (err) {
        failures.push(`asset_reservations: ${(err as Error).message}`);
      }
    }
    if (this.orderIds.length > 0) {
      try {
        await this.supabase.admin
          .from('orders')
          .delete()
          .eq('tenant_id', this.tenantId)
          .in('id', this.orderIds);
      } catch (err) {
        failures.push(`orders: ${(err as Error).message}`);
      }
    }
    // Void any approvals already persisted for the rolled-back orders /
    // lines. Without this, ApprovalRoutingService.assemble's pre-anyDeny
    // inserts orphan: approvers see a pending row in their queue for
    // entities that no longer exist. (The booking-level approval row may
    // also exist via target_entity_id=booking.id but we don't cancel it
    // here — the booking still exists.)
    const approvalTargetIds = [
      ...this.orderIds,
      ...this.oliIds,
    ];
    if (approvalTargetIds.length > 0) {
      try {
        await this.supabase.admin
          .from('approvals')
          .update({
            status: 'cancelled',
            comments: 'Auto-voided — service attach rolled back (orphan prevention).',
          })
          .eq('tenant_id', this.tenantId)
          .in('target_entity_id', approvalTargetIds)
          .eq('status', 'pending');
      } catch (err) {
        failures.push(`approvals: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
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
