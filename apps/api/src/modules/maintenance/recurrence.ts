/**
 * Recurrence helpers for the Slice C PM (preventive-maintenance) generator.
 *
 * Plan: ai/slice-c-plan.md §2 (decision #1) + §4 (advance + initial
 * computation). Hand-rolled math — RRULE library integration deferred to
 * v1.5 once a customer asks for "every 1st Monday of the month" etc.
 *
 * Three exports:
 *   - advanceRecurrence(from, interval, unit) — advance once by N units.
 *   - advanceToNextFuture(from, interval, unit, now, max?) — advance until
 *     the result is strictly in the future relative to `now`. Bounded so a
 *     pathological anchor (1970-01-01, interval=1 day) cannot spin
 *     forever; default cap is 4096 iterations.
 *   - computeInitialNextRunAt(anchorDate, interval, unit, now) — derive
 *     the FIRST next_run_at from an anchor_date. The plan's schema stores
 *     anchor as a DATE (no time-of-day); we materialise it at the
 *     ANCHOR_TIME_OF_DAY_UTC marker (09:00 UTC) so spawned WOs land at a
 *     predictable hour. If the anchor is in the past, walk forward until
 *     it isn't.
 *
 * Month / year math respects month-end semantics (anchor 2026-01-31 +
 * 1 month = 2026-02-28) by clamping the day-of-month after the naive
 * add. Leap year (2024-02-29 + 1 year = 2025-02-28) falls out of the
 * same clamp. Verified in recurrence.spec.ts.
 *
 * UTC everywhere — no tz arithmetic in v1. Business-hours calendar
 * adjustment is explicitly deferred (plan §1 "out of scope").
 */

export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';

/**
 * Default time-of-day stamped onto anchor_date when deriving next_run_at.
 * 09:00 UTC ≈ 10:00–11:00 in the Benelux working window (CET +1 / CEST +2).
 * Operators can override planned_start_at on the spawned WO; the anchor is
 * just the recurrence cadence marker.
 */
export const ANCHOR_TIME_OF_DAY_UTC: { hours: number; minutes: number } = {
  hours: 9,
  minutes: 0,
};

const DEFAULT_ADVANCE_CAP = 4096;

const VALID_UNITS: ReadonlySet<RecurrenceUnit> = new Set([
  'day',
  'week',
  'month',
  'year',
]);

export function isRecurrenceUnit(value: unknown): value is RecurrenceUnit {
  return typeof value === 'string' && VALID_UNITS.has(value as RecurrenceUnit);
}

export function advanceRecurrence(
  from: Date,
  interval: number,
  unit: RecurrenceUnit,
): Date {
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error(
      `advanceRecurrence: interval must be a positive integer; got ${interval}`,
    );
  }
  if (!isRecurrenceUnit(unit)) {
    throw new Error(`advanceRecurrence: invalid unit ${String(unit)}`);
  }

  if (unit === 'day') {
    const next = new Date(from.getTime());
    next.setUTCDate(next.getUTCDate() + interval);
    return next;
  }
  if (unit === 'week') {
    const next = new Date(from.getTime());
    next.setUTCDate(next.getUTCDate() + interval * 7);
    return next;
  }
  if (unit === 'month') {
    return addCalendarMonths(from, interval);
  }
  return addCalendarMonths(from, interval * 12);
}

export function advanceToNextFuture(
  from: Date,
  interval: number,
  unit: RecurrenceUnit,
  now: Date,
  maxIterations: number = DEFAULT_ADVANCE_CAP,
): Date {
  let cursor = from;
  let iter = 0;
  while (cursor.getTime() <= now.getTime()) {
    cursor = advanceRecurrence(cursor, interval, unit);
    iter++;
    if (iter > maxIterations) {
      throw new Error(
        `advanceToNextFuture: exceeded ${maxIterations} iterations advancing from ${from.toISOString()} by ${interval} ${unit}`,
      );
    }
  }
  return cursor;
}

export function computeInitialNextRunAt(
  anchorDate: string,
  interval: number,
  unit: RecurrenceUnit,
  now: Date,
): Date {
  const anchorTs = parseAnchorDateToUtc(anchorDate);
  if (anchorTs.getTime() > now.getTime()) {
    return anchorTs;
  }
  return advanceToNextFuture(anchorTs, interval, unit, now);
}

/**
 * Parse an `anchor_date` (YYYY-MM-DD string from the Postgres DATE column)
 * into a UTC Date stamped at ANCHOR_TIME_OF_DAY_UTC. Strict: rejects
 * malformed input so the caller surfaces a validation error rather than
 * a silent NaN that propagates into the next_run_at column.
 */
export function parseAnchorDateToUtc(anchorDate: string): Date {
  if (typeof anchorDate !== 'string') {
    throw new Error(
      `parseAnchorDateToUtc: expected string; got ${typeof anchorDate}`,
    );
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorDate);
  if (!match) {
    throw new Error(
      `parseAnchorDateToUtc: expected YYYY-MM-DD; got ${anchorDate}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`parseAnchorDateToUtc: out-of-range value in ${anchorDate}`);
  }
  const ts = Date.UTC(
    year,
    month - 1,
    day,
    ANCHOR_TIME_OF_DAY_UTC.hours,
    ANCHOR_TIME_OF_DAY_UTC.minutes,
    0,
    0,
  );
  const result = new Date(ts);
  if (result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) {
    throw new Error(`parseAnchorDateToUtc: invalid calendar date ${anchorDate}`);
  }
  return result;
}

function addCalendarMonths(from: Date, months: number): Date {
  const fromYear = from.getUTCFullYear();
  const fromMonth = from.getUTCMonth();
  const fromDay = from.getUTCDate();
  const totalMonths = fromMonth + months;
  const targetYear = fromYear + Math.floor(totalMonths / 12);
  const normalisedTargetMonth = ((totalMonths % 12) + 12) % 12;
  const lastDayOfTarget = lastDayOfMonthUtc(targetYear, normalisedTargetMonth);
  const clampedDay = Math.min(fromDay, lastDayOfTarget);
  const ts = Date.UTC(
    targetYear,
    normalisedTargetMonth,
    clampedDay,
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  );
  return new Date(ts);
}

function lastDayOfMonthUtc(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
