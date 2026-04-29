import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TicketService } from '../ticket/ticket.service';

/**
 * Shared trigger logic that turns a "this line needs internal setup" rule
 * outcome into a booking-origin work order. Same shape used by both:
 *   - BundleService.attachServicesToReservation (bundle path)
 *   - OrderService.createStandaloneOrder       (standalone path)
 *
 * Why a shared service: the auto-creation flow (matrix lookup → ticket
 * insert → audit on miss) is ~80 lines of orchestration. Inlining it in
 * both creators meant we'd diverge over time as one path got fixes the
 * other didn't. Extracting also lets the next consumer (e.g., when
 * recurrence-clone re-fires rules per occurrence) share the same logic.
 *
 * Posture (unchanged from the inlined version):
 *   * Runs AFTER the bundle/order is committed. The bundle is the source
 *     of truth — a failed work order is recoverable via audit + manual
 *     re-trigger; we never roll back the bundle for it.
 *   * Concurrency: each line in a bundle is independent — caller can
 *     fire all of them in parallel via `triggerMany`.
 *   * Audit signals on routing-unconfigured / create-failed land on
 *     `audit_events` so admins can spot misconfiguration.
 *
 * Audit event taxonomy is parameterised so callers stamp the originating
 * surface ('bundle' vs 'order') in the event_type. See
 * docs/assignments-routing-fulfillment.md §25.
 */
@Injectable()
export class SetupWorkOrderTriggerService {
  private readonly log = new Logger(SetupWorkOrderTriggerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService))
    private readonly tickets: TicketService,
  ) {}

  /**
   * Fire the trigger for a single line. Returns the created work order id
   * (or null if no team was configured at this combo, or if the create
   * failed — both states are audited internally so callers don't need to
   * branch on the response).
   */
  async trigger(args: TriggerArgs): Promise<{ ticket_id: string } | null> {
    const { data: routing, error: routingErr } = await this.supabase.admin.rpc(
      'resolve_setup_routing',
      {
        p_tenant_id: args.tenantId,
        p_location_id: args.locationId,
        p_service_category: args.serviceCategory,
      },
    );
    if (routingErr) {
      this.log.warn(
        `setup routing lookup failed for line ${args.oliId}: ${routingErr.message}`,
      );
      return null;
    }
    const routingRow = (routing as Array<{
      internal_team_id: string | null;
      default_lead_time_minutes: number;
      sla_policy_id: string | null;
    }> | null)?.[0];

    if (!routingRow || !routingRow.internal_team_id) {
      void this.audit(args, 'setup_routing_unconfigured', { reason: 'no_matrix_match' });
      return null;
    }

    const leadTimeMinutes =
      args.leadTimeOverride ?? routingRow.default_lead_time_minutes;
    const targetDueAt = new Date(
      new Date(args.serviceWindowStartAt).getTime() - leadTimeMinutes * 60_000,
    ).toISOString();

    try {
      const { id } = await this.tickets.createBookingOriginWorkOrder({
        title: `Internal setup — ${args.serviceCategory}`,
        booking_bundle_id: args.bundleId,
        linked_order_line_item_id: args.oliId,
        assigned_team_id: routingRow.internal_team_id,
        target_due_at: targetDueAt,
        location_id: args.locationId,
        audit_metadata: {
          triggered_by_rule_ids: args.ruleIds,
          lead_time_minutes: leadTimeMinutes,
          service_window_start_at: args.serviceWindowStartAt,
          service_category: args.serviceCategory,
          origin: args.originSurface,
        },
      });
      return { ticket_id: id };
    } catch (err) {
      this.log.warn(
        `booking-origin work order create failed for line ${args.oliId}: ${
          (err as Error).message
        }`,
      );
      void this.audit(args, 'setup_work_order_create_failed', {
        error: (err as Error).message,
        severity: 'high',
      });
      return null;
    }
  }

  /**
   * Fire the trigger for many lines in parallel. Order of args doesn't
   * matter — each result is independent. Use this from creation hot paths
   * to avoid sequential round trips.
   */
  async triggerMany(argsList: TriggerArgs[]): Promise<Array<{ ticket_id: string } | null>> {
    if (argsList.length === 0) return [];
    return Promise.all(argsList.map((args) => this.trigger(args)));
  }

  private async audit(
    args: TriggerArgs,
    suffix: 'setup_routing_unconfigured' | 'setup_work_order_create_failed',
    extras: Record<string, unknown>,
  ): Promise<void> {
    const eventType = `${args.originSurface}.${suffix}`;
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: args.tenantId,
        event_type: eventType,
        entity_type: 'order_line_item',
        entity_id: args.oliId,
        details: {
          line_id: args.oliId,
          service_category: args.serviceCategory,
          location_id: args.locationId,
          rule_ids: args.ruleIds,
          severity: 'medium',
          ...extras,
        },
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

export interface TriggerArgs {
  tenantId: string;
  bundleId: string;
  oliId: string;
  serviceCategory: string;
  serviceWindowStartAt: string;
  /** Delivery / reservation location. NULL allowed but in practice a line
   *  always has one — the matrix lookup degrades gracefully. */
  locationId: string | null;
  /** Rule IDs that aggregated requires_internal_setup=true on this line. */
  ruleIds: string[];
  /** Per-rule MAX of internal_setup_lead_time_minutes; null = use matrix. */
  leadTimeOverride: number | null;
  /** Stamps the audit event prefix: 'bundle' vs 'order'. Used to keep
   *  the existing audit-event taxonomy unchanged across the refactor. */
  originSurface: 'bundle' | 'order';
}
