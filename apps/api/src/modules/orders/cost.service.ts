import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Per-line + bundle + annualised cost computation. Honors the three units
 * shipped in `menu_items.unit`:
 *   - per_item   → unit_price × quantity
 *   - per_person → unit_price × (quantity_per_attendee ?? 1) × bundle.attendee_count
 *   - flat_rate  → unit_price (quantity is informational, doesn't multiply)
 *
 * `unit_price` is snapshotted onto `order_line_items.unit_price` at create
 * time so future menu repricing doesn't change historical totals — the
 * same pattern as `reservations.cost_amount_snapshot`.
 *
 * Null `unit_price` lines render as "—" (caller responsibility) and
 * contribute 0 to the total. Approval thresholds compute against
 * per-occurrence, never annualised.
 */

export interface BundleCostBreakdown {
  bundle_id: string;
  lines: Array<{
    order_line_item_id: string;
    catalog_item_id: string;
    quantity: number;
    unit: 'per_item' | 'per_person' | 'flat_rate' | null;
    unit_price: number | null;
    line_total: number;
    is_priceless: boolean;
  }>;
  reservation_cost: number;
  total_per_occurrence: number;
  /** Set when the bundle's reservation has a recurrence_rule. */
  total_annualised: number | null;
  /** Number of occurrences over the next 365 days (for annualised display). */
  annualised_occurrences: number | null;
}

@Injectable()
export class CostService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Compute the bundle's per-occurrence and annualised totals.
   * Returns nulls for `total_annualised` + `annualised_occurrences` when the
   * bundle is not recurring.
   */
  async computeBundleCost(bundleId: string): Promise<BundleCostBreakdown> {
    const tenantId = TenantContext.current().id;

    const [bundleRes, reservationRes, ordersRes] = await Promise.all([
      this.supabase.admin
        .from('booking_bundles')
        .select('id, primary_reservation_id')
        .eq('id', bundleId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      // We need attendee_count + cost_amount_snapshot from the primary
      // reservation. Reservations are cheap; one-shot fetch is fine.
      this.supabase.admin
        .from('reservations')
        .select('id, attendee_count, cost_amount_snapshot, recurrence_rule')
        .eq('booking_bundle_id', bundleId)
        .order('start_at', { ascending: true })
        .limit(1),
      this.supabase.admin
        .from('orders')
        .select('id, status')
        .eq('booking_bundle_id', bundleId),
    ]);
    if (bundleRes.error) throw bundleRes.error;
    if (reservationRes.error) throw reservationRes.error;
    if (ordersRes.error) throw ordersRes.error;

    const reservation = ((reservationRes.data ?? []) as Array<{
      id: string;
      attendee_count: number | null;
      cost_amount_snapshot: number | null;
      recurrence_rule: { until?: string; count?: number; freq?: string; interval?: number } | null;
    }>)[0];

    const orderIds = ((ordersRes.data ?? []) as Array<{ id: string }>).map((o) => o.id);
    const lines = orderIds.length > 0 ? await this.loadLineItems(orderIds) : [];
    const attendeeCount = reservation?.attendee_count ?? null;

    const computedLines = lines.map((l) => {
      const lineTotal = computeLineTotal(l, attendeeCount);
      return {
        order_line_item_id: l.id,
        catalog_item_id: l.catalog_item_id,
        quantity: l.quantity,
        unit: l.unit,
        unit_price: l.unit_price,
        line_total: lineTotal,
        is_priceless: l.unit_price == null,
      };
    });

    const reservationCost = reservation?.cost_amount_snapshot ?? 0;
    const totalPerOccurrence =
      computedLines.reduce((sum, l) => sum + l.line_total, 0) + Number(reservationCost);

    const annualisedOccurrences = reservation?.recurrence_rule
      ? estimateAnnualisedOccurrences(reservation.recurrence_rule)
      : null;
    const totalAnnualised =
      annualisedOccurrences != null ? totalPerOccurrence * annualisedOccurrences : null;

    return {
      bundle_id: bundleId,
      lines: computedLines,
      reservation_cost: Number(reservationCost),
      total_per_occurrence: totalPerOccurrence,
      total_annualised: totalAnnualised,
      annualised_occurrences: annualisedOccurrences,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadLineItems(orderIds: string[]): Promise<Array<{
    id: string;
    catalog_item_id: string;
    quantity: number;
    unit: 'per_item' | 'per_person' | 'flat_rate' | null;
    unit_price: number | null;
    policy_snapshot: { unit?: 'per_item' | 'per_person' | 'flat_rate' | null } | null;
  }>> {
    const { data, error } = await this.supabase.admin
      .from('order_line_items')
      .select('id, catalog_item_id, quantity, unit_price, policy_snapshot')
      .in('order_id', orderIds);
    if (error) throw error;
    return ((data ?? []) as Array<{
      id: string;
      catalog_item_id: string;
      quantity: number;
      unit_price: number | null;
      policy_snapshot: { unit?: 'per_item' | 'per_person' | 'flat_rate' | null } | null;
    }>).map((row) => ({
      ...row,
      unit: row.policy_snapshot?.unit ?? null,
    }));
  }
}

// ── Pure helpers (exported for testing) ───────────────────────────────────

export function computeLineTotal(
  line: {
    quantity: number;
    unit_price: number | null;
    unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  },
  attendeeCount: number | null,
): number {
  if (line.unit_price == null) return 0;
  switch (line.unit) {
    case 'per_person': {
      const att = attendeeCount ?? 1;
      return Number(line.unit_price) * line.quantity * att;
    }
    case 'flat_rate':
      return Number(line.unit_price);
    case 'per_item':
    default:
      return Number(line.unit_price) * line.quantity;
  }
}

/**
 * Estimate the number of occurrences in the next 365 days for a given
 * recurrence_rule. Used purely for annualised-cost display — the canonical
 * count comes from the recurrence engine. Conservative defaults (assume
 * weekly = 52, monthly = 12, daily = 365) keep this O(1) without hitting
 * the DB. Bounded by `until`/`count` when supplied.
 */
export function estimateAnnualisedOccurrences(
  rule: { until?: string; count?: number; freq?: string; interval?: number } | null,
): number | null {
  if (!rule) return null;
  if (rule.count) return rule.count;
  const interval = rule.interval && rule.interval > 0 ? rule.interval : 1;
  let perYear = 0;
  switch (rule.freq) {
    case 'DAILY':
      perYear = Math.floor(365 / interval);
      break;
    case 'WEEKLY':
      perYear = Math.floor(52 / interval);
      break;
    case 'MONTHLY':
      perYear = Math.floor(12 / interval);
      break;
    case 'YEARLY':
      perYear = Math.max(1, Math.floor(1 / interval));
      break;
    default:
      return null;
  }
  if (rule.until) {
    const days = Math.max(0, Math.floor((Date.parse(rule.until) - Date.now()) / (24 * 3600 * 1000)));
    if (days < 365) {
      const fraction = days / 365;
      return Math.max(0, Math.floor(perYear * fraction));
    }
  }
  return perYear;
}
