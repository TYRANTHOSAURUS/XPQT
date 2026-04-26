import type { BaseEvaluationContext } from '../room-booking-rules/predicate-engine.service';

/**
 * Evaluation context for service rules.
 *
 * Distinct from `EvaluationContext` (room booking rules) on purpose: service
 * rules reason over catalog items, menus, and the optional reservation —
 * not room/space/booking. Both contexts satisfy `BaseEvaluationContext` so the
 * shared `PredicateEngineService` can evaluate either.
 *
 * The `booking` mirror of `reservation` is kept so that service rule
 * templates that reference `$.booking.start_at` (the room engine's
 * convention) keep firing when a service is attached to a reservation.
 *
 * `start_at_day_of_week` is pre-derived (1=Mon..7=Sun, ISO format) so the
 * `item_blackout` template can match on day of week without a special
 * resolver branch in the engine.
 */
export interface ServiceEvaluationContext extends BaseEvaluationContext {
  requester: {
    id: string;
    role_ids: string[];
    org_node_id: string | null;
    type: string | null;
    cost_center: string | null;
    user_id: string | null;
  };
  bundle?: {
    id: string;
    cost_center_id: string | null;
    template_id: string | null;
    attendee_count: number | null;
  };
  reservation?: {
    id: string;
    space_id: string;
    start_at: string;
    end_at: string;
  };
  /**
   * Mirror of reservation for templates that use the room-engine convention
   * (`$.booking.start_at`). Absent on standalone orders.
   */
  booking?: {
    start_at: string;
    end_at: string;
    duration_minutes: number;
    attendee_count: number | null;
    /** ISO day of week: 1=Mon, 7=Sun. Pre-derived to keep predicates simple. */
    start_at_day_of_week: number;
  };
  line: {
    catalog_item_id: string;
    catalog_item_category: string | null;
    menu_id: string | null;
    quantity: number;
    quantity_per_attendee: number | null;
    service_window_start_at: string | null;
    service_window_end_at: string | null;
    unit_price: number | null;
    /** start_at - now() in hours; negative once we're past the lead-time window. */
    lead_time_remaining_hours: number;
    menu: {
      fulfillment_vendor_id: string | null;
      fulfillment_team_id: string | null;
    };
  };
  order: {
    /** Per-occurrence total — what approval thresholds compare against. */
    total_per_occurrence: number;
    /** Alias of total_per_occurrence; retained for predicate readability. */
    total: number;
    line_count: number;
  };
}

export interface BuildServiceEvaluationContextArgs {
  requester: ServiceEvaluationContext['requester'];
  bundle?: ServiceEvaluationContext['bundle'];
  reservation?: ServiceEvaluationContext['reservation'];
  line: ServiceEvaluationContext['line'];
  order: ServiceEvaluationContext['order'];
  permissions?: Record<string, boolean>;
}

/**
 * Build a `ServiceEvaluationContext` from raw inputs. Pre-computes the
 * `booking` mirror (with ISO day of week) when a reservation is present.
 *
 * Day-of-week is derived from the reservation's `start_at` *as-is*, in UTC.
 * That matches the existing room-rule conventions (engine sees ISO strings,
 * not Luxon objects). If timezone-aware day-of-week becomes an issue, lift
 * this to a TZ-aware helper at the call site.
 */
export function buildServiceEvaluationContext(
  args: BuildServiceEvaluationContextArgs,
): ServiceEvaluationContext {
  const reservation = args.reservation;
  const booking = reservation
    ? {
        start_at: reservation.start_at,
        end_at: reservation.end_at,
        duration_minutes:
          (Date.parse(reservation.end_at) - Date.parse(reservation.start_at)) / 60_000,
        attendee_count: args.bundle?.attendee_count ?? null,
        start_at_day_of_week: isoDayOfWeek(reservation.start_at),
      }
    : undefined;

  return {
    requester: args.requester,
    bundle: args.bundle,
    reservation,
    booking,
    line: args.line,
    order: args.order,
    permissions: args.permissions ?? {},
    resolved: {
      org_descendants: {},
      in_business_hours: {},
    },
  };
}

/** ISO 8601 day of week: 1=Monday, 7=Sunday. */
function isoDayOfWeek(iso: string): number {
  const d = new Date(iso);
  const js = d.getUTCDay(); // 0=Sun .. 6=Sat
  return js === 0 ? 7 : js;
}
