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

const fullFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

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
