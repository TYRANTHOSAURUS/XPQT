import { useCallback, useMemo, useState } from 'react';

/**
 * Scheduler view window state — the date / view-mode + filter state for
 * `/desk/scheduler`. Pure local state (URL syncing is a follow-up); the
 * page reads the derived `startAtIso` / `endAtIso` to drive the window
 * fetch and grid render.
 *
 * View modes:
 *   - `day`  → 1 day, 7 AM → 7 PM by default (configurable hours below).
 *   - `week` → 7 days starting on `anchorDate`.
 *
 * Cell granularity is 30 minutes (matches §3 spec default; UI snap layer
 * may collapse to 15-min in a follow-up).
 */

export type SchedulerViewMode = 'day' | 'week';

export interface SchedulerWindowState {
  anchorDate: string;             // yyyy-mm-dd local
  viewMode: SchedulerViewMode;
  dayStartHour: number;           // 0–23, inclusive
  dayEndHour: number;             // 1–24, exclusive
  cellMinutes: number;            // 15 or 30 in v1; 30 default
  buildingId: string | null;
  floorId: string | null;
  roomTypeFilter: string | null;
  amenities: string[];
  search: string;
  bookForPersonId: string | null; // when set: rule tags + override flow active
}

const TODAY = (() => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
})();

function buildDayBounds(dateStr: string, startHour: number, endHour: number): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00`);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(endHour, 0, 0, 0);
  return { start, end };
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function useSchedulerWindow() {
  const [state, setState] = useState<SchedulerWindowState>({
    anchorDate: TODAY,
    viewMode: 'day',
    dayStartHour: 7,
    dayEndHour: 19,
    cellMinutes: 30,
    buildingId: null,
    floorId: null,
    roomTypeFilter: null,
    amenities: [],
    search: '',
    bookForPersonId: null,
  });

  const update = useCallback(
    <K extends keyof SchedulerWindowState>(key: K, value: SchedulerWindowState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const goToToday = useCallback(() => {
    setState((prev) => ({ ...prev, anchorDate: TODAY }));
  }, []);

  const navigate = useCallback((delta: number) => {
    setState((prev) => {
      const step = prev.viewMode === 'week' ? 7 : 1;
      return { ...prev, anchorDate: shiftDate(prev.anchorDate, step * delta) };
    });
  }, []);

  // The list of dates rendered as columns (week view stacks 7 days).
  const dates = useMemo<string[]>(() => {
    if (state.viewMode === 'day') return [state.anchorDate];
    return Array.from({ length: 7 }, (_, i) => shiftDate(state.anchorDate, i));
  }, [state.viewMode, state.anchorDate]);

  // Derived: ISO range for the entire visible window. Used by the
  // `useSchedulerReservations` hook + the picker call.
  const { startAtIso, endAtIso } = useMemo(() => {
    const first = buildDayBounds(dates[0], state.dayStartHour, state.dayEndHour).start;
    const last = buildDayBounds(dates[dates.length - 1], state.dayStartHour, state.dayEndHour).end;
    return { startAtIso: first.toISOString(), endAtIso: last.toISOString() };
  }, [dates, state.dayStartHour, state.dayEndHour]);

  // Adjacent windows for idle prefetch. We project the same view-mode
  // step (1 day or 7 days) backwards and forwards from the current
  // anchor; the result is what the toolbar's prev/next buttons would
  // produce, so prefetching them turns clicks into instant paints.
  const adjacentWindows = useMemo(() => {
    const step = state.viewMode === 'week' ? 7 : 1;
    const prevAnchor = shiftDate(state.anchorDate, -step);
    const nextAnchor = shiftDate(state.anchorDate, step);
    const span = (anchor: string): { startAtIso: string; endAtIso: string } => {
      const list =
        state.viewMode === 'day'
          ? [anchor]
          : Array.from({ length: 7 }, (_, i) => shiftDate(anchor, i));
      const first = buildDayBounds(list[0], state.dayStartHour, state.dayEndHour).start;
      const last = buildDayBounds(list[list.length - 1], state.dayStartHour, state.dayEndHour).end;
      return { startAtIso: first.toISOString(), endAtIso: last.toISOString() };
    };
    return { prev: span(prevAnchor), next: span(nextAnchor) };
  }, [state.viewMode, state.anchorDate, state.dayStartHour, state.dayEndHour]);

  // Number of half-hour (or cellMinutes) columns per day.
  const columnsPerDay = useMemo(
    () => Math.max(1, Math.round(((state.dayEndHour - state.dayStartHour) * 60) / state.cellMinutes)),
    [state.dayStartHour, state.dayEndHour, state.cellMinutes],
  );

  /**
   * Map a cell index inside the visible window to an absolute ISO string.
   *
   * The cell belongs to a specific day (`cell / columnsPerDay`), and inside
   * that day the offset is `(cell % columnsPerDay) * cellMinutes` from
   * `dayStartHour:00` LOCAL — `setHours` handles the day's actual
   * wall-clock hours correctly across DST. The naive
   * `windowStartMs + cell * msPerCell` math assumed every cell was the
   * same width, which breaks on DST changeover days because the affected
   * day is 23 or 25 hours instead of 24 — drag-create at "Mon 10am" in
   * a week view spanning a spring-forward Sunday would land at 9:55am or
   * 10:05am.
   */
  const cellToIso = useCallback(
    (cell: number): string => {
      const safeCell = Math.max(0, Math.min(cell, dates.length * columnsPerDay));
      const dayIdx = Math.min(dates.length - 1, Math.floor(safeCell / columnsPerDay));
      const within = safeCell - dayIdx * columnsPerDay;
      const date = new Date(`${dates[dayIdx]}T00:00:00`);
      date.setHours(state.dayStartHour, 0, 0, 0);
      date.setMinutes(date.getMinutes() + within * state.cellMinutes);
      return date.toISOString();
    },
    [dates, columnsPerDay, state.dayStartHour, state.cellMinutes],
  );

  return {
    state,
    update,
    goToToday,
    navigate,
    dates,
    startAtIso,
    endAtIso,
    adjacentWindows,
    columnsPerDay,
    cellToIso,
  };
}
