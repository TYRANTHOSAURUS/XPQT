import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

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

export type SchedulerSort =
  | 'name'
  | 'capacity_asc'
  | 'capacity_desc'
  | 'status';

/**
 * Status-driven quick view, surfaced in the desk sidebar. Maps to
 * `rule_outcome.effect` on the row level. `all` shows everything;
 * specific values filter to that effect group. Only meaningful when
 * a `bookForPersonId` is set (otherwise every room is `allow`).
 */
export type SchedulerStatusView =
  | 'all'
  | 'available'
  | 'requires_approval'
  | 'restricted'
  | 'warning';

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
  sort: SchedulerSort;
  statusView: SchedulerStatusView;
  bookForPersonId: string | null; // when set: rule tags + override flow active
}

const TODAY = (() => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
})();

const SORT_VALUES = new Set<string>(['name', 'capacity_asc', 'capacity_desc', 'status']);
const STATUS_VIEW_VALUES = new Set<string>([
  'all',
  'available',
  'requires_approval',
  'restricted',
  'warning',
]);

// Map state key → URL search param key. Keys not in this map are
// local-only state (e.g. dayStartHour) and never round-trip through
// the URL — they're presentation tweaks, not filters worth sharing.
const STATE_TO_URL_KEY: Partial<Record<keyof SchedulerWindowState, string>> = {
  anchorDate: 'date',
  viewMode: 'view',
  buildingId: 'building',
  floorId: 'floor',
  roomTypeFilter: 'type',
  amenities: 'amenities',
  search: 'q',
  sort: 'sort',
  statusView: 'status',
  bookForPersonId: 'book_for',
};

function serializeForUrl<K extends keyof SchedulerWindowState>(
  _key: K,
  value: SchedulerWindowState[K],
): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(',') : null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : null;
  return null;
}

function bootstrapFromUrl(searchString: string): Partial<SchedulerWindowState> {
  const sp = new URLSearchParams(searchString);
  const out: Partial<SchedulerWindowState> = {};
  const date = sp.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.anchorDate = date;
  const view = sp.get('view');
  if (view === 'day' || view === 'week') out.viewMode = view;
  out.buildingId = sp.get('building');
  out.floorId = sp.get('floor');
  out.roomTypeFilter = sp.get('type');
  out.search = sp.get('q') ?? '';
  const sort = sp.get('sort');
  if (sort && SORT_VALUES.has(sort)) out.sort = sort as SchedulerSort;
  const status = sp.get('status');
  if (status && STATUS_VIEW_VALUES.has(status)) out.statusView = status as SchedulerStatusView;
  out.bookForPersonId = sp.get('book_for');
  const amenities = sp.get('amenities');
  if (amenities) out.amenities = amenities.split(',').filter(Boolean);
  return out;
}

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
  // Hydrate once from the URL so deep-linked filters (`/desk/scheduler?
  // building=…`) take effect on first paint instead of flashing the
  // unfiltered grid for a frame before the URL → state effect runs.
  const [state, setState] = useState<SchedulerWindowState>(() => ({
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
    sort: 'name',
    statusView: 'all',
    bookForPersonId: null,
    ...bootstrapFromUrl(window.location.search),
  }));

  // ── URL ↔ state sync ────────────────────────────────────────────────
  // The desk sidebar drives a subset of the scheduler's filters via
  // query params (`?building=…&sort=…&status=…&type=…&q=…`). We treat
  // those URL params as one of two equal sources of truth: changes from
  // the toolbar push to URL, clicks in the sidebar push to URL, and a
  // single effect mirrors URL → state. Internal `update()` calls also
  // drive the URL so deep links stay shareable.
  const [params, setParams] = useSearchParams();

  // Track the last URL we wrote so the URL → state effect doesn't
  // double-react to our own writes (would cause a render thrash on
  // every keystroke in the search box).
  const lastWriteRef = useRef<string>('');

  useEffect(() => {
    const key = params.toString();
    if (key === lastWriteRef.current) return;
    setState((prev) => {
      const next: SchedulerWindowState = { ...prev };
      const building = params.get('building');
      const floor = params.get('floor');
      const type = params.get('type');
      const q = params.get('q');
      const sort = params.get('sort');
      const status = params.get('status');
      const view = params.get('view');
      const date = params.get('date');
      const bookFor = params.get('book_for');
      const amenities = params.get('amenities');

      if (building !== prev.buildingId) next.buildingId = building;
      if (floor !== prev.floorId) next.floorId = floor;
      if (type !== prev.roomTypeFilter) next.roomTypeFilter = type;
      if ((q ?? '') !== prev.search) next.search = q ?? '';
      if (sort && SORT_VALUES.has(sort) && sort !== prev.sort) next.sort = sort as SchedulerSort;
      if (status && STATUS_VIEW_VALUES.has(status) && status !== prev.statusView) {
        next.statusView = status as SchedulerStatusView;
      } else if (!status && prev.statusView !== 'all') {
        next.statusView = 'all';
      }
      if (view === 'day' || view === 'week') {
        if (view !== prev.viewMode) next.viewMode = view;
      }
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date !== prev.anchorDate) {
        next.anchorDate = date;
      }
      if (bookFor !== prev.bookForPersonId) next.bookForPersonId = bookFor;
      if (amenities !== null) {
        const list = amenities.split(',').filter(Boolean);
        const same = list.length === prev.amenities.length &&
          list.every((a, i) => a === prev.amenities[i]);
        if (!same) next.amenities = list;
      }
      return next;
    });
  }, [params]);

  const update = useCallback(
    <K extends keyof SchedulerWindowState>(key: K, value: SchedulerWindowState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));

      // Mirror to URL for the subset that's URL-backed. Local-only
      // settings (dayStartHour/dayEndHour/cellMinutes) skip this
      // branch — they're rarely changed and would clutter every link.
      const urlKey = STATE_TO_URL_KEY[key];
      if (!urlKey) return;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const serialized = serializeForUrl(key, value);
          if (serialized == null || serialized === '') {
            next.delete(urlKey);
          } else {
            next.set(urlKey, serialized);
          }
          lastWriteRef.current = next.toString();
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
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
