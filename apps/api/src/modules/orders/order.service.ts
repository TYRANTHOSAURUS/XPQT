import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  loadPermissionMap,
  loadRequesterContext,
} from '../../common/requester-context';
import { ApprovalRoutingService } from './approval-routing.service';
import { ServiceRuleResolverService } from '../service-catalog/service-rule-resolver.service';
import { buildServiceEvaluationContext } from '../service-catalog/service-evaluation-context';
import {
  SetupWorkOrderTriggerService,
  type TriggerArgs,
} from '../service-routing/setup-work-order-trigger.service';

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
    private readonly setupTrigger: SetupWorkOrderTriggerService,
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
    // Column renames (00278:108-118):
    //   orders.booking_bundle_id    → orders.booking_id     (FK to bookings.id)
    //   orders.linked_reservation_id → orders.linked_slot_id (FK to booking_slots.id)
    // Under canonicalisation the booking IS the bundle (00277:27); the
    // occurrence's `bundleId` is its booking id, and `newReservation.id` is
    // the new occurrence's booking id (BookingFlowService.create now returns
    // the booking id, not a slot id). We don't have a slot id at hand here;
    // leave linked_slot_id null — the FK is nullable on delete set null
    // (00278:118) and downstream queries don't rely on it for recurrence
    // clones.
    const newWindowStart = args.newReservation.start_at;
    const newWindowEnd = args.newReservation.end_at;
    const clonedOrder = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: tenantId,
        requester_person_id: args.requesterPersonId,
        booking_id: args.bundleId,
        linked_slot_id: null,
        delivery_location_id: (masterOrder.data as { delivery_location_id: string | null }).delivery_location_id,
        delivery_date: newWindowStart.slice(0, 10),
        requested_for_start_at: newWindowStart,
        requested_for_end_at: newWindowEnd,
        recurrence_series_id: args.recurrenceSeriesId,
        // Provisional status — re-evaluated below after per-occurrence rule
        // re-resolution (spec §5.1). Set to 'submitted' so a row is never
        // visible as fully approved before rules have run.
        status: 'submitted',
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
        'id, catalog_item_id, quantity, unit_price, line_total, fulfillment_status, fulfillment_team_id, vendor_id, menu_item_id, linked_asset_id, service_window_start_at, service_window_end_at, repeats_with_series, policy_snapshot',
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
    type ClonedLineMeta = {
      oliId: string;
      catalog_item_id: string;
      menu_id: string | null;
      quantity: number;
      unit_price: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      asset_reservation_id: string | null;
      asset_conflicted: boolean;
    };
    const clonedLineMetas: ClonedLineMeta[] = [];

    for (const line of (masterLines.data ?? []) as Array<{
      id: string;
      catalog_item_id: string;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      fulfillment_status: string | null;
      fulfillment_team_id: string | null;
      vendor_id: string | null;
      menu_item_id: string | null;
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
        // Column rename: asset_reservations.booking_bundle_id → booking_id
        // (00278:136). bundleId is the booking id post-canonicalisation.
        const ar = await this.supabase.admin
          .from('asset_reservations')
          .insert({
            tenant_id: tenantId,
            asset_id: line.linked_asset_id,
            start_at: assetStart,
            end_at: assetEnd,
            status: 'confirmed',
            requester_person_id: args.requesterPersonId,
            booking_id: args.bundleId,
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
          vendor_id: line.vendor_id,
          menu_item_id: line.menu_item_id,
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

      clonedLineMetas.push({
        oliId: newLineId,
        catalog_item_id: line.catalog_item_id,
        menu_id:
          (line.policy_snapshot as { menu_id?: string | null } | null)?.menu_id ?? null,
        quantity: line.quantity,
        unit_price: line.unit_price,
        service_window_start_at: occurrenceStart,
        service_window_end_at: occurrenceEnd,
        asset_reservation_id: clonedAssetReservationId,
        asset_conflicted: assetConflicted,
      });
    }

    // Per-spec §5.1: re-resolve service rules against each occurrence's
    // context. Outcomes can change per occurrence (e.g. holiday-specific deny
    // on Dec 25, weekly cost-threshold approval). Asset-conflicted lines are
    // already skipped at clone time and are excluded from rule eval — no
    // point evaluating a line that won't fulfil anyway.
    const ruleEval = await this.reEvalRulesForOccurrence({
      tenantId,
      bundleId: args.bundleId,
      newReservationId: args.newReservation.id,
      newReservationStartAt: args.newReservation.start_at,
      newReservationEndAt: args.newReservation.end_at,
      requesterPersonId: args.requesterPersonId,
      clonedOrderId,
      clonedLineMetas: clonedLineMetas.filter((m) => !m.asset_conflicted),
    });

    // Set order status. submitted = pending approval; approved = clean run.
    await this.supabase.admin
      .from('orders')
      .update({ status: ruleEval.anyPending ? 'submitted' : 'approved' })
      .eq('id', clonedOrderId);

    void this.audit(tenantId, 'order.line_cloned', 'order', clonedOrderId, {
      master_order_id: args.masterOrderId,
      new_order_id: clonedOrderId,
      bundle_id: args.bundleId,
      cloned_line_ids: clonedLineIds,
      cloned_asset_reservation_ids: clonedAssetReservationIds,
      asset_conflict_line_ids: assetConflictLineIds,
      rule_denied_line_ids: ruleEval.deniedLineIds,
      rule_approval_required_line_ids: ruleEval.approvalLineIds,
      any_pending_approval: ruleEval.anyPending,
    });

    return {
      cloned_order_id: clonedOrderId,
      cloned_line_ids: clonedLineIds,
      cloned_asset_reservation_ids: clonedAssetReservationIds,
      asset_conflict_line_ids: assetConflictLineIds,
    };
  }

  /**
   * Re-evaluate service rules against the new occurrence's context and apply
   * outcomes:
   *   - deny → mark line `recurrence_skipped=true skip_reason='rule_deny'`,
   *     cancel any cloned asset reservation
   *   - require_approval → route through ApprovalRoutingService scoped to
   *     this occurrence's order/bundle
   *   - allow / warn → leave as-is (warns are surfaced via audit only)
   *
   * Failures here are logged but never throw — recurrence materialisation
   * already swallows per-order errors at the caller, but we'd rather the
   * occurrence land as 'submitted' than not land at all.
   */
  private async reEvalRulesForOccurrence(args: {
    tenantId: string;
    bundleId: string;
    newReservationId: string;
    newReservationStartAt: string;
    newReservationEndAt: string;
    requesterPersonId: string;
    clonedOrderId: string;
    clonedLineMetas: Array<{
      oliId: string;
      catalog_item_id: string;
      menu_id: string | null;
      quantity: number;
      unit_price: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      asset_reservation_id: string | null;
    }>;
  }): Promise<{ deniedLineIds: string[]; approvalLineIds: string[]; anyPending: boolean }> {
    if (args.clonedLineMetas.length === 0) {
      return { deniedLineIds: [], approvalLineIds: [], anyPending: false };
    }

    try {
      // Post-canonicalisation: the booking IS the bundle (00277:27). Both
      // `args.newReservationId` and `args.bundleId` are booking ids — the
      // newReservationId is the new occurrence's booking id (Slice A return-
      // shape change in BookingFlowService.create). Pull the booking row for
      // cost_center_id + template_id (00277:61,80) and its primary slot
      // (00277:154 display_order) for space_id + attendee_count.
      const [bookingRow, slotRow, requesterCtx] = await Promise.all([
        this.supabase.admin
          .from('bookings')
          .select('id, cost_center_id, template_id, location_id')
          .eq('id', args.bundleId)
          .eq('tenant_id', args.tenantId)
          .maybeSingle(),
        this.supabase.admin
          .from('booking_slots')
          .select('id, space_id, attendee_count')
          .eq('booking_id', args.newReservationId)
          .eq('tenant_id', args.tenantId)
          .order('display_order', { ascending: true })
          .limit(1)
          .maybeSingle(),
        loadRequesterContext(this.supabase, args.requesterPersonId),
      ]);
      if (bookingRow.error) throw bookingRow.error;
      if (slotRow.error) throw slotRow.error;

      const booking = bookingRow.data as
        | {
            id: string;
            cost_center_id: string | null;
            template_id: string | null;
            location_id: string;
          }
        | null;
      const slot = slotRow.data as
        | { id: string; space_id: string; attendee_count: number | null }
        | null;
      if (!booking) {
        this.log.warn(
          `re-eval: booking not found for clone ${args.clonedOrderId}`,
        );
        return { deniedLineIds: [], approvalLineIds: [], anyPending: false };
      }
      // Reservation context: prefer the slot's space_id (per-slot anchor
      // from the new occurrence) but fall back to the booking's location_id
      // when the occurrence has no slots yet (services-only paths).
      const reservation = {
        id: args.newReservationId,
        space_id: slot?.space_id ?? booking.location_id,
        attendee_count: slot?.attendee_count ?? null,
      };
      const bundle = {
        id: booking.id,
        cost_center_id: booking.cost_center_id,
        template_id: booking.template_id,
      };

      const permissions = await loadPermissionMap(this.supabase, requesterCtx.user_id);

      // Hydrate catalog_item category + fulfillment_team_id, and menu's
      // fulfillment_vendor_id, for each unique catalog_item_id / menu_id pair.
      const catalogIds = Array.from(
        new Set(args.clonedLineMetas.map((m) => m.catalog_item_id)),
      );
      const menuIds = Array.from(
        new Set(
          args.clonedLineMetas
            .map((m) => m.menu_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      const [itemsRes, menusRes] = await Promise.all([
        this.supabase.admin
          .from('catalog_items')
          .select('id, category, fulfillment_team_id, price_per_unit')
          .in('id', catalogIds)
          .eq('tenant_id', args.tenantId),
        menuIds.length > 0
          ? this.supabase.admin
              .from('catalog_menus')
              .select('id, fulfillment_vendor_id, fulfillment_team_id')
              .in('id', menuIds)
              .eq('tenant_id', args.tenantId)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (menusRes.error) throw menusRes.error;
      const itemsById = new Map(
        (itemsRes.data ?? []).map((row: any) => [row.id as string, row]),
      );
      const menusById = new Map(
        (menusRes.data ?? []).map((row: any) => [row.id as string, row]),
      );

      const orderTotal = args.clonedLineMetas.reduce(
        (sum, m) => sum + (m.unit_price ?? 0) * m.quantity,
        0,
      );

      const linesByOli = new Map(args.clonedLineMetas.map((m) => [m.oliId, m]));
      const outcomes = await this.resolver.resolveBulk({
        lines: args.clonedLineMetas.map((m) => ({
          lineKey: m.oliId,
          catalog_item_id: m.catalog_item_id,
          catalog_item_category:
            (itemsById.get(m.catalog_item_id) as { category: string | null } | undefined)
              ?.category ?? null,
          menu_id: m.menu_id,
        })),
        contextFor: (lineKey) => {
          const meta = linesByOli.get(lineKey)!;
          const item = itemsById.get(meta.catalog_item_id) as
            | { category: string | null; fulfillment_team_id: string | null }
            | undefined;
          const menu = meta.menu_id
            ? (menusById.get(meta.menu_id) as
                | { fulfillment_vendor_id: string | null; fulfillment_team_id: string | null }
                | undefined)
            : undefined;
          const startAt = meta.service_window_start_at ?? args.newReservationStartAt;
          const leadHours = (Date.parse(startAt) - Date.now()) / 3_600_000;
          return buildServiceEvaluationContext({
            requester: requesterCtx,
            bundle: {
              id: bundle.id,
              cost_center_id: bundle.cost_center_id,
              template_id: bundle.template_id,
              attendee_count: reservation.attendee_count ?? null,
            },
            reservation: {
              id: reservation.id,
              space_id: reservation.space_id,
              start_at: args.newReservationStartAt,
              end_at: args.newReservationEndAt,
            },
            line: {
              catalog_item_id: meta.catalog_item_id,
              catalog_item_category: item?.category ?? null,
              menu_id: meta.menu_id,
              quantity: meta.quantity,
              quantity_per_attendee: null,
              service_window_start_at: meta.service_window_start_at,
              service_window_end_at: meta.service_window_end_at,
              unit_price: meta.unit_price,
              lead_time_remaining_hours: leadHours,
              menu: {
                fulfillment_vendor_id: menu?.fulfillment_vendor_id ?? null,
                fulfillment_team_id:
                  menu?.fulfillment_team_id ?? item?.fulfillment_team_id ?? null,
              },
            },
            order: {
              total_per_occurrence: orderTotal,
              total: orderTotal,
              line_count: args.clonedLineMetas.length,
            },
            permissions,
          });
        },
      });

      const deniedLineIds: string[] = [];
      const approvalLineIds: string[] = [];
      const perLineApproval: Array<{
        line_key: string;
        outcome: NonNullable<ReturnType<typeof outcomes.get>>;
        scope: {
          order_ids: string[];
          order_line_item_ids: string[];
          asset_reservation_ids: string[];
        };
      }> = [];

      for (const meta of args.clonedLineMetas) {
        const outcome = outcomes.get(meta.oliId);
        if (!outcome) continue;
        if (outcome.effect === 'deny') {
          deniedLineIds.push(meta.oliId);
          continue;
        }
        if (outcome.effect === 'require_approval' || outcome.effect === 'allow_override') {
          approvalLineIds.push(meta.oliId);
        }
        perLineApproval.push({
          line_key: meta.oliId,
          outcome,
          scope: {
            order_ids: [args.clonedOrderId],
            order_line_item_ids: [meta.oliId],
            asset_reservation_ids: meta.asset_reservation_id
              ? [meta.asset_reservation_id]
              : [],
          },
        });
      }

      // Apply deny outcomes: skip the line + cancel its asset reservation.
      for (const oliId of deniedLineIds) {
        const meta = linesByOli.get(oliId)!;
        await this.supabase.admin
          .from('order_line_items')
          .update({
            recurrence_skipped: true,
            recurrence_overridden: true,
            skip_reason: 'rule_deny',
            fulfillment_status: 'cancelled',
          })
          .eq('id', oliId)
          .eq('tenant_id', args.tenantId);
        if (meta.asset_reservation_id) {
          await this.supabase.admin
            .from('asset_reservations')
            .update({ status: 'cancelled' })
            .eq('id', meta.asset_reservation_id)
            .eq('tenant_id', args.tenantId);
        }
      }

      const anyPending = perLineApproval.some(
        (p) =>
          p.outcome.effect === 'require_approval' || p.outcome.effect === 'allow_override',
      );
      if (perLineApproval.length > 0) {
        // 00278:172 CHECK constraint enforces target_entity_type='booking'
        // for booking-anchored approvals (was 'booking_bundle' pre-rewrite).
        await this.approvalRouter.assemble({
          target_entity_type: 'booking',
          target_entity_id: args.bundleId,
          per_line_outcomes: perLineApproval,
          bundle_context: {
            cost_center_id: bundle.cost_center_id,
            requester_person_id: args.requesterPersonId,
            bundle_id: args.bundleId,
          },
        });
      }

      return { deniedLineIds, approvalLineIds, anyPending };
    } catch (err) {
      // Fail-safe: if re-eval can't run (DB hiccup, missing context), keep
      // the order as 'submitted' so a human reviews — never silently flip
      // to 'approved'. Returning anyPending=true preserves the pre-eval
      // status the caller already wrote.
      this.log.warn(
        `per-occurrence rule re-eval failed for order ${args.clonedOrderId}: ${(err as Error).message}`,
      );
      return { deniedLineIds: [], approvalLineIds: [], anyPending: true };
    }
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
    void this.audit(tenantId, 'order.line_overridden', 'order_line_item', lineId, {
      line_id: lineId,
      patch,
    });
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
    void this.audit(tenantId, 'order.line_skipped', 'order_line_item', lineId, {
      line_id: lineId,
      reason: reason ?? 'user_skipped',
    });
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
    void this.audit(tenantId, 'order.line_reverted', 'order_line_item', lineId, {
      line_id: lineId,
    });
    return { id: lineId };
  }

  /**
   * `POST /orders/standalone`. Creates a services-only `bookings` row (no
   * slots), one order with N line items, asset reservations for any line
   * that requested one, and de-duped approvals.
   *
   * Post-canonicalisation (2026-05-02): the booking IS the bundle (00277:27).
   * The legacy "services-only booking_bundles row with primary_reservation_id
   * NULL" pattern collapses to "a bookings row that holds zero booking_slots"
   * — `bookings` doesn't constrain slot count, and downstream service-attach
   * code reads through `orders.booking_id` (00278:109) rather than walking
   * slots. Sub-project 3+ visitor-only bundles use the same shape.
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
    const requesterCtx = await loadRequesterContext(this.supabase, args.requester_person_id);
    const permissions = await loadPermissionMap(this.supabase, requesterCtx.user_id);

    try {
      // 1. Create the services-only booking (no booking_slots attached).
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
        /** Resolved from menu offer; needed for the location_service_routing
         *  matrix lookup when requires_internal_setup fires. NULL when the
         *  catalog item has no menu (e.g. tenant-default rules only). */
        service_type: string | null;
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
          service_type: offer?.service_type ?? null,
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
            requester: requesterCtx,
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
            permissions,
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
          requires_internal_setup: false,
          internal_setup_lead_time_minutes: null,
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
        // 00278:172 CHECK constraint enforces target_entity_type='booking'
        // for booking-anchored approvals (was 'booking_bundle' pre-rewrite).
        target_entity_type: 'booking',
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

      // Auto-create internal-setup work orders in parallel for any line
      // whose rules emitted requires_internal_setup=true. Lines without a
      // service_type (catalog item with no menu) can't route — surface
      // separately and skip. Shared trigger handles the rest.
      //
      // Approval interlock (codex 2026-04-30 review): mirrors the bundle
      // path — if ANY line is pending approval, defer auto-creation.
      // Facilities shouldn't start work for orders that may be rejected.
      // The TriggerArgs are PERSISTED on the OLI so BundleService.
      // onApprovalDecided can re-fire exactly the snapshot on grant
      // without re-resolving rules (00197 + the approval-decided handler).
      const persisted: Array<{ meta: (typeof lineMetas)[number]; args: TriggerArgs }> = [];
      for (const meta of lineMetas) {
        const outcome = outcomes.get(meta.oliId);
        if (!outcome?.requires_internal_setup) continue;
        if (!meta.service_type) {
          // No service_type → matrix can't route. Surface and skip. Same on
          // both deferred and immediate paths so the audit stream is uniform.
          void this.audit(tenantId, 'order.setup_routing_unconfigured', 'order_line_item', meta.oliId, {
            line_id: meta.oliId,
            reason: 'no_service_type_on_line',
            rule_ids: outcome.matched_rule_ids,
            severity: 'medium',
          });
          continue;
        }
        persisted.push({
          meta,
          args: {
            tenantId,
            bundleId: bundle.id,
            oliId: meta.oliId,
            serviceCategory: meta.service_type,
            serviceWindowStartAt: meta.service_window_start_at,
            locationId: args.delivery_space_id,
            ruleIds: outcome.matched_rule_ids,
            leadTimeOverride: outcome.internal_setup_lead_time_minutes,
            originSurface: 'order',
          },
        });
      }

      if (anyPending) {
        // Persist failure surfaces as a HIGH-severity event, NOT the normal
        // deferred marker — otherwise approval-grant later claims nothing
        // and no work order fires, with the audit trail saying the opposite.
        // Mirror of the bundle path.
        for (const { meta, args: tArgs } of persisted) {
          const outcome = outcomes.get(meta.oliId)!;
          const { error: persistErr } = await this.supabase.admin
            .from('order_line_items')
            .update({ pending_setup_trigger_args: tArgs })
            .eq('id', meta.oliId);
          if (persistErr) {
            this.log.error(
              `failed to persist pending_setup_trigger_args for oli ${meta.oliId}: ${persistErr.message}`,
            );
            void this.audit(tenantId, 'order.setup_deferral_persist_failed', 'order_line_item', meta.oliId, {
              line_id: meta.oliId,
              order_id: order.id,
              // Standalone orders still create a bundle row; carry bundle_id
              // here so BundleService.onApprovalDecided's persist-failure
              // lookup (`details->>bundle_id = bundleId`) finds it. Without
              // this, standalone-order lost-persist cases fall through to
              // the misleading "no_deferred_setup" marker. Codex round 4.
              bundle_id: bundle.id,
              rule_ids: outcome.matched_rule_ids,
              error: persistErr.message,
              severity: 'high',
            });
            continue;
          }
          void this.audit(tenantId, 'order.setup_deferred_pending_approval', 'order_line_item', meta.oliId, {
            line_id: meta.oliId,
            order_id: order.id,
            rule_ids: outcome.matched_rule_ids,
            reason: 'approval_pending',
          });
        }
      } else {
        await this.setupTrigger.triggerMany(persisted.map((p) => p.args));
      }

      void this.audit(tenantId, 'order.created', 'order', order.id, {
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

  /**
   * Standalone-order anchor: a `bookings` row with NO `booking_slots`.
   *
   * Post-canonicalisation (2026-05-02) the booking IS the bundle (00277:27),
   * so the legacy "services-only booking_bundles row" becomes "a bookings
   * row that holds zero slots". The schema doesn't constrain slot count,
   * and downstream service-attach code reads through `booking_id` on
   * `orders` / `asset_reservations` rather than walking slots.
   *
   * Field deltas vs. the legacy row:
   *   - `bundle_type`            dropped (00277:15-17)
   *   - `primary_reservation_id` dropped (00277:15-17)
   *   - `policy_snapshot` shape carries `{ source: 'standalone' }` so admins
   *     can spot services-only bookings in the audit feed without joining
   *     to the orders table.
   */
  private async createServicesOnlyBundle(args: {
    tenantId: string;
    args: CreateStandaloneOrderArgs;
  }): Promise<{ id: string }> {
    const insertRow = {
      tenant_id: args.tenantId,
      requester_person_id: args.args.requester_person_id,
      host_person_id: null,
      booked_by_user_id: null,
      location_id: args.args.delivery_space_id,
      start_at: args.args.requested_for_start_at,
      end_at: args.args.requested_for_end_at,
      timezone: 'UTC',
      status: 'confirmed',
      source: 'portal',
      cost_center_id: args.args.cost_center_id ?? null,
      cost_amount_snapshot: null,
      policy_snapshot: { source: 'standalone' },
      applied_rule_ids: [],
      template_id: null,
    };
    const { data, error } = await this.supabase.admin
      .from('bookings')
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
    // Column rename: orders.booking_bundle_id → orders.booking_id (00278:109).
    // bundle_id is the booking id under canonicalisation.
    const { data, error } = await this.supabase.admin
      .from('orders')
      .insert({
        tenant_id: args.tenantId,
        requester_person_id: args.args.requester_person_id,
        booking_id: args.bundle_id,
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
    // Reject cross-tenant asset ids passed in the payload — admin client
    // bypasses RLS so the tenant boundary has to live in code.
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

    // Column rename: asset_reservations.booking_bundle_id → booking_id
    // (00278:136). bundle_id is the booking id post-canonicalisation.
    const { data, error } = await this.supabase.admin
      .from('asset_reservations')
      .insert({
        tenant_id: args.tenantId,
        asset_id: args.asset_id,
        start_at: args.start_at,
        end_at: args.end_at,
        status: 'confirmed',
        requester_person_id: args.requester_person_id,
        booking_id: args.bundle_id,
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
        vendor_id: args.offer?.vendor_id ?? null,
        menu_item_id: args.offer?.menu_item_id ?? null,
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
      // Post-canonicalisation: the standalone "bundle" row lives in
      // `bookings` (00277:27); legacy `booking_bundles` table was dropped
      // (00276:43-58). The booking has no slots, so the delete cascades to
      // nothing else here.
      try {
        await this.supabase.admin.from('bookings').delete().eq('id', this.bundleId);
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
