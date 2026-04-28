import { ApiError } from '@/lib/api';
import type { RankedRoom } from '@/api/room-booking';

/**
 * Tiny helpers shared across the composer's section components.
 * Extracted from booking-composer.tsx in 2026-04-28's split slice — kept
 * here as plain functions (no React, no hooks) so unit tests don't need
 * a render harness.
 */

/** Convert ISO timestamp → the local string an `<input type="datetime-local">`
 *  expects (YYYY-MM-DDTHH:mm). Empty string for null/invalid. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** Round-up the current time to the next quarter hour. Used when the
 *  composer opens with no pre-seeded time so the date inputs show a
 *  sensible default instead of empty. */
export function nextQuarterHour(): Date {
  const d = new Date();
  const m = d.getMinutes();
  const next = Math.ceil((m + 1) / 15) * 15;
  d.setMinutes(next, 0, 0);
  return d;
}

/** Pull RankedRoom alternatives out of a 409 conflict-guard error so the
 *  composer can render "this slot was just taken — try these" inline.
 *  NOTE: backend currently returns `conflicts` (time slots), not
 *  `alternatives` (rooms). The UI guards on `length > 0` so it just
 *  doesn't render until the API contract is widened. */
export function extractAlternatives(error: unknown): RankedRoom[] {
  if (!(error instanceof ApiError)) return [];
  if (error.status !== 409) return [];
  const details = error.details;
  if (
    typeof details === 'object' &&
    details !== null &&
    'alternatives' in details &&
    Array.isArray((details as { alternatives?: unknown }).alternatives)
  ) {
    return (details as { alternatives: RankedRoom[] }).alternatives;
  }
  return [];
}

/** Mirrors the backend's `estimateAnnualisedOccurrences` including the
 *  `until` bound. Caps at the natural year limit when no count/until is
 *  set — a "weekly forever" rule annualises to 52, not infinity. The
 *  canonical figure comes from `CostService.computeBundleCost` after the
 *  bundle lands; this is preview-only. */
export function estimateOccurrences(
  frequency: 'daily' | 'weekly' | 'monthly',
  interval: number,
  count: number,
  until: string | null,
  startAtIso: string,
): number {
  const safeInterval = Math.max(1, interval);
  const yearCap = (() => {
    switch (frequency) {
      case 'daily':
        return Math.floor(365 / safeInterval);
      case 'weekly':
        return Math.floor(52 / safeInterval);
      case 'monthly':
        return Math.floor(12 / safeInterval);
      default:
        return 0;
    }
  })();

  // Time-bounded cap when `until` is set — "weekly until 6 weeks out"
  // → cap at 6 not 52.
  let timeCap = Infinity;
  if (until) {
    const startMs = new Date(startAtIso).getTime();
    const untilMs = new Date(until).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(untilMs) && untilMs > startMs) {
      const days = Math.floor((untilMs - startMs) / 86_400_000) + 1;
      switch (frequency) {
        case 'daily':
          timeCap = Math.floor(days / safeInterval);
          break;
        case 'weekly':
          timeCap = Math.floor(days / 7 / safeInterval);
          break;
        case 'monthly':
          timeCap = Math.floor(days / 30 / safeInterval);
          break;
      }
    }
  }

  const explicitCount = count > 0 ? count : Infinity;
  return Math.max(0, Math.min(explicitCount, yearCap, timeCap));
}

/** Convert a YYYY-MM-DD date string to an ISO timestamp at 23:59:59.999
 *  in the user's local zone. Backend recurrence honors `until` as an
 *  inclusive bound — without end-of-day a recurring 9 AM meeting on the
 *  chosen date would be excluded because date-only parses to midnight. */
export function endOfDayIso(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((s) => Number(s));
  if (!y || !m || !d) return dateStr;
  const local = new Date(y, m - 1, d, 23, 59, 59, 999);
  return local.toISOString();
}
