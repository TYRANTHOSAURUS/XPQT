/**
 * Scheduler grid time math — DST-correct helpers for the work-order
 * planning board (`/desk/planning`). Pure functions, no React, no fetching.
 *
 * The Benelux market means the tenant time zone is `Europe/Amsterdam` and
 * 2026 has DST transitions on 29 March (CET→CEST, 23-hour day) and
 * 25 October (CEST→CET, 25-hour day). The helpers here walk wall-clock via
 * `Date.setHours` / `Date.setMinutes` rather than UTC-millisecond arithmetic
 * so a drop on "Mon 10:00" lands at 10:00 local even when the visible
 * window crosses a DST changeover.
 *
 * The room-booking scheduler (`apps/web/src/pages/desk/scheduler/`) has its
 * own copy of equivalent math inside `use-scheduler-window.ts`. The two
 * grids share the math conceptually but not the code — we deliberately
 * avoided coupling the planning board to a hook with room-specific state.
 * When (if) the abstraction becomes obvious from two consumers, lift here.
 */

/** A local-zone date like `yyyy-MM-dd`. */
export type LocalDateString = string;

/**
 * Bounds of a single working day in the local zone. `start` is at
 * `startHour:00`, `end` is at `endHour:00`.
 */
export function buildDayBounds(
  date: LocalDateString,
  startHour: number,
  endHour: number,
): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00`);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(endHour, 0, 0, 0);
  return { start, end };
}

/**
 * Shift a `yyyy-MM-dd` string by `days` calendar days. Returns the same
 * format. Goes through a local Date so month / year rollovers work.
 */
export function shiftDate(date: LocalDateString, days: number): LocalDateString {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalDateString(d);
}

/** Format a Date as `yyyy-MM-dd` in local zone. */
export function toLocalDateString(d: Date): LocalDateString {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Map a cell index inside the visible window to an absolute ISO instant.
 *
 * The cell belongs to a specific day (`cell / columnsPerDay`). Inside that
 * day the offset is `(cell % columnsPerDay) * cellMinutes` from
 * `dayStartHour:00` LOCAL. `setHours` + `setMinutes` are zone-aware so
 * crossing a DST transition produces the correct UTC instant — the naive
 * `windowStartMs + cell * msPerCell` math assumed every cell was the same
 * width, which breaks on a 23-hour / 25-hour day.
 */
export function cellToIso(args: {
  dates: LocalDateString[];
  columnsPerDay: number;
  dayStartHour: number;
  cellMinutes: number;
  cell: number;
}): string {
  const { dates, columnsPerDay, dayStartHour, cellMinutes, cell } = args;
  const total = dates.length * columnsPerDay;
  const safeCell = Math.max(0, Math.min(cell, total));
  const dayIdx = Math.min(dates.length - 1, Math.floor(safeCell / columnsPerDay));
  const within = safeCell - dayIdx * columnsPerDay;
  const date = new Date(`${dates[dayIdx]}T00:00:00`);
  date.setHours(dayStartHour, 0, 0, 0);
  date.setMinutes(date.getMinutes() + within * cellMinutes);
  return date.toISOString();
}

/**
 * Inverse of `cellToIso`. Given an absolute ISO instant, return the cell
 * index inside the visible window, or `null` if the instant is outside the
 * window. Used by drop-target hit-testing and existing-block placement.
 *
 * On a DST changeover the day's local minute count is 23×60 or 25×60
 * instead of 24×60, so we compute the minutes-from-day-start via
 * wall-clock arithmetic rather than `(instant - dayStart) / 60_000`.
 */
export function isoToCell(args: {
  dates: LocalDateString[];
  columnsPerDay: number;
  dayStartHour: number;
  cellMinutes: number;
  iso: string;
}): number | null {
  const { dates, columnsPerDay, dayStartHour, cellMinutes, iso } = args;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const dateStr = toLocalDateString(instant);
  const dayIdx = dates.indexOf(dateStr);
  if (dayIdx === -1) return null;

  const dayStart = new Date(`${dateStr}T00:00:00`);
  dayStart.setHours(dayStartHour, 0, 0, 0);
  const minutesFromDayStart =
    instant.getHours() * 60 +
    instant.getMinutes() -
    (dayStart.getHours() * 60 + dayStart.getMinutes());
  if (minutesFromDayStart < 0) return null;

  const cellWithin = Math.floor(minutesFromDayStart / cellMinutes);
  if (cellWithin >= columnsPerDay) return null;

  return dayIdx * columnsPerDay + cellWithin;
}

/**
 * Number of `cellMinutes`-sized columns between `dayStartHour` and
 * `dayEndHour`. Always >= 1 (clamps so a misconfigured `dayEndHour <
 * dayStartHour` does not produce a 0-column grid).
 */
export function columnsPerDay(
  dayStartHour: number,
  dayEndHour: number,
  cellMinutes: number,
): number {
  return Math.max(1, Math.round(((dayEndHour - dayStartHour) * 60) / cellMinutes));
}

/** The list of dates rendered as columns for a given anchor + view mode. */
export function expandDates(
  anchor: LocalDateString,
  viewMode: 'day' | 'week',
): LocalDateString[] {
  if (viewMode === 'day') return [anchor];
  return Array.from({ length: 7 }, (_, i) => shiftDate(anchor, i));
}
