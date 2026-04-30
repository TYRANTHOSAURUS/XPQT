/**
 * Shared formatting helpers.
 *
 * Keep every user-visible number / date rendering going through these so the
 * app reads cohesively. Linear, Vercel, Notion all hand-roll equivalents —
 * we just lean on `Intl.*` which is already in the bundle.
 */

const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const plainFormatter = new Intl.NumberFormat(undefined);

/**
 * Compact numbers ≥ 1000 (1.5K, 23M). Plain for the rest so a counter at
 * 42 still reads as 42, not 42.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1000) return plainFormatter.format(n);
  return compactFormatter.format(n);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const RELATIVE_TIME_BUCKETS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

/**
 * Relative time ("2 minutes ago", "in 3 days"). Pass a Date, ISO string, or
 * epoch ms. Returns "—" for bad input so the UI never renders "Invalid Date".
 */
export function formatRelativeTime(input: Date | string | number | null | undefined): string {
  if (input == null) return '—';
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diffSeconds = Math.round((ts - Date.now()) / 1000);
  for (const [unit, secondsInUnit] of RELATIVE_TIME_BUCKETS) {
    if (Math.abs(diffSeconds) >= secondsInUnit || unit === 'second') {
      const value = Math.round(diffSeconds / secondsInUnit);
      return rtf.format(value, unit);
    }
  }
  return rtf.format(0, 'second');
}

/**
 * Compact past-relative ("5m", "2h", "3d"). For dense table cells where
 * the full RTF wording ("2 hours ago") would crowd the column. Ignores
 * future timestamps — those become "now" — because the columns this is
 * for (Age, Created) only show past events.
 */
export function formatRelativeTimeCompact(input: Date | string | number | null | undefined): string {
  if (input == null) return '—';
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSeconds < 60) return 'now';
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

const fullFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

/**
 * Short month + day ("Apr 24"). Use for chart tick labels and dense lists
 * where a full date would crowd the layout.
 */
export function formatShortDate(input: Date | string | number | null | undefined): string {
  if (input == null) return '';
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return '';
  return shortDateFormatter.format(new Date(ts));
}

/**
 * Full date + time — use as tooltip content when the visible label is a
 * relative time, so power users can hover for the precise timestamp.
 */
export function formatFullTimestamp(
  input: Date | string | number | null | undefined,
): string {
  if (input == null) return '';
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return '';
  return fullFormatter.format(new Date(ts));
}

const dayLabelFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const dayRangeLabelFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/**
 * Navigation header label for a single day ("Mon, Jan 6, 2025") or a
 * date within a range ("Mon, Jan 6"). The longer form is used when only
 * one date is shown; the shorter form is used when combining two dates
 * into a range string (caller joins with " – ").
 */
export function formatDayLabel(
  input: Date | string | null | undefined,
  form: 'full' | 'range' = 'full',
): string {
  if (input == null) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  return form === 'range'
    ? dayRangeLabelFormatter.format(d)
    : dayLabelFormatter.format(d);
}

const timeShortFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Time-only display ("3:14 PM"). Used by the bundle services drawer to
 * show service-window starts compactly next to a status icon.
 */
export function formatTimeShort(input: Date | string | number | null | undefined): string {
  if (input == null) return '';
  const ts = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(ts)) return '';
  return timeShortFormatter.format(new Date(ts));
}

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/**
 * Currency display with the locale's symbol. Renders an em-dash for
 * null/non-finite — the booking-confirm dialog uses this when a service
 * line has no price (priceless line: "—" reads as "ask for a quote").
 *
 * Defaults to USD until per-tenant currency lands.
 */
export function formatCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return currencyFormatter.format(value);
}

/**
 * Humanize minutes for booking durations: 30m / 1h / 1.5h / 2h. Used by
 * the picker chip group, booking detail drawers, and analytics tick
 * labels.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes}m`;
  if (minutes === 60) return '1h';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${(minutes / 60).toFixed(1).replace(/\.0$/, '')}h`;
}
