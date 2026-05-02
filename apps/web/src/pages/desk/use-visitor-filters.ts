import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { formatShortDate } from '@/lib/format';

/**
 * URL-backed visitor filter state. The desk /visitors page uses this as
 * the single source of truth — toolbar search, sidebar views, and the
 * chip bar all read/write here. Sharing the URL means a filtered view
 * is a copy-paste link.
 *
 * Mirrors `use-ticket-filters.ts`. Visitors don't have a "scope" concept
 * the way bookings do — every filter is just a URL param. Multi-value
 * filters (`status`) live as comma-separated strings; everything else is
 * a single value.
 *
 * View presets group "what does the desk care about *right now*". They
 * collapse a coherent set of filters behind a one-click sidebar entry,
 * matching tickets' "Assigned to me / Unassigned / SLA at risk" pattern.
 *
 * `loose_ends` is the only preset that crosses an axis the URL can't
 * fully express — it's an alias the desk page reads to switch from the
 * visitors list to a yesterday-loose-ends fallback view. The list
 * endpoint still respects every other URL param while that preset is
 * active so date + status filters work the same.
 */

export type VisitorViewId =
  | 'today'
  | 'expected'
  | 'arrived'
  | 'pending_approval'
  | 'loose_ends'
  | 'all'
  | 'recent';

const TODAY_STATUSES = ['expected', 'arrived', 'in_meeting'] as const;
const ARRIVED_STATUSES = ['arrived', 'in_meeting'] as const;

interface VisitorViewPreset {
  label: string;
  /** Produces the raw URL param set. */
  params: () => Record<string, string>;
}

export const visitorViewPresets: Record<VisitorViewId, VisitorViewPreset> = {
  today: {
    label: "Today",
    params: () => ({ view: 'today', date: 'today', status: TODAY_STATUSES.join(',') }),
  },
  expected: {
    label: 'Expected',
    params: () => ({ view: 'expected', date: 'today', status: 'expected' }),
  },
  arrived: {
    label: 'On site',
    params: () => ({ view: 'arrived', date: 'today', status: ARRIVED_STATUSES.join(',') }),
  },
  pending_approval: {
    label: 'Pending approval',
    params: () => ({ view: 'pending_approval', status: 'pending_approval' }),
  },
  loose_ends: {
    label: "Yesterday's loose ends",
    params: () => ({ view: 'loose_ends' }),
  },
  all: {
    label: 'All visitors',
    params: () => ({ view: 'all' }),
  },
  recent: {
    label: 'Recent',
    params: () => ({ view: 'recent', date: 'recent' }),
  },
};

export const VISITOR_VIEW_ORDER: VisitorViewId[] = [
  'today',
  'expected',
  'arrived',
  'pending_approval',
  'loose_ends',
  'all',
  'recent',
];

export interface VisitorRawFilters {
  q: string;
  view: VisitorViewId | null;
  status: string[];
  /** Special date tokens (`today`, `tomorrow`, `recent`) OR an ISO date
   *  `YYYY-MM-DD` for a specific calendar day. */
  date: string | null;
  building: string | null;
  visitorType: string | null;
  host: string | null;
}

const splitList = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const joinList = (v: string[]): string | undefined => (v.length ? v.join(',') : undefined);

export function useVisitorFilters() {
  const [params, setParams] = useSearchParams();
  const { appUser } = useAuth();
  const currentUserId = appUser?.id ?? null;

  const raw: VisitorRawFilters = useMemo(
    () => ({
      q: params.get('q') ?? '',
      view: (params.get('view') as VisitorViewId | null) ?? null,
      status: splitList(params.get('status')),
      date: params.get('date'),
      building: params.get('building'),
      visitorType: params.get('type'),
      host: params.get('host'),
    }),
    [params],
  );

  const patch = useCallback(
    (next: Partial<Record<keyof VisitorRawFilters | 'type', string | string[] | null>>) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          // The URL key for visitor-type is "type" (shorter), but the raw
          // shape uses `visitorType` for clarity. Allow callers to write
          // either key here.
          const aliased: Record<string, string | string[] | null | undefined> = { ...next };
          if ('visitorType' in aliased) {
            aliased.type = aliased.visitorType;
            delete aliased.visitorType;
          }
          for (const [key, value] of Object.entries(aliased)) {
            if (
              value === null ||
              value === undefined ||
              value === '' ||
              (Array.isArray(value) && value.length === 0)
            ) {
              copy.delete(key);
            } else if (Array.isArray(value)) {
              const joined = joinList(value);
              if (joined) copy.set(key, joined);
              else copy.delete(key);
            } else {
              copy.set(key, value);
            }
          }
          return copy;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const applyView = useCallback(
    (id: VisitorViewId) => {
      const preset = visitorViewPresets[id].params();
      setParams(new URLSearchParams(preset), { replace: false });
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    setParams(new URLSearchParams(), { replace: false });
  }, [setParams]);

  const activeCount = useMemo(() => {
    let n = 0;
    if (raw.status.length) n++;
    if (raw.date) n++;
    if (raw.building) n++;
    if (raw.visitorType) n++;
    if (raw.host) n++;
    return n;
  }, [raw]);

  return {
    raw,
    currentUserId,
    patch,
    applyView,
    clearAll,
    activeCount,
    viewPresets: visitorViewPresets,
  };
}

/**
 * Day-bound predicate for client-side filtering. The reception backend
 * gives us today's data via `/reception/today` and per-building. For
 * other days we fall back to filtering the data we already have in the
 * cache against the `date` URL param. Returns true if `ts` falls on the
 * selected day. `today` and `recent` always return true (server side
 * has already scoped them); `tomorrow` requires the date to be the next
 * calendar day; ISO dates match exact local-day membership.
 */
export function visitorDateMatches(date: string | null, ts: string | null): boolean {
  if (!date) return true;
  if (!ts) return false;
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return false;
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const today = startOfDay(new Date());
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const tDay = startOfDay(t);
  if (date === 'today') return tDay.getTime() === today.getTime();
  if (date === 'tomorrow') return tDay.getTime() === tomorrow.getTime();
  if (date === 'recent') return true;
  // ISO date YYYY-MM-DD interpreted as local day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [yyyy, mm, dd] = date.split('-').map(Number);
    const target = new Date(yyyy, mm - 1, dd);
    return tDay.getTime() === target.getTime();
  }
  return true;
}

/**
 * Render a date param for chip display. Returns "Today", "Tomorrow", a
 * formatted month/day for ISO dates, or null when the value is empty
 * or unrecognised.
 */
export function visitorDateLabel(date: string | null): string | null {
  if (!date) return null;
  if (date === 'today') return 'Today';
  if (date === 'tomorrow') return 'Tomorrow';
  if (date === 'recent') return 'Recent';
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [yyyy, mm, dd] = date.split('-').map(Number);
    const d = new Date(yyyy, mm - 1, dd);
    // formatShortDate is the en-US "Apr 24" formatter from lib/format —
    // imported lazily here to avoid a circular import path at module
    // init (use-visitor-filters loads early on the desk shell).
    return formatShortDate(d);
  }
  return date;
}
