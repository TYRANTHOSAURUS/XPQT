import type { RecurrenceUnit } from '@/api/maintenance-plans';

const UNIT_NOUN_SINGULAR: Record<RecurrenceUnit, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
};

const UNIT_NOUN_PLURAL: Record<RecurrenceUnit, string> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

/**
 * "Every 1 month" / "Every 3 weeks". Mirrors the backend recurrence model
 * (apps/api/src/modules/maintenance/recurrence.ts).
 */
export function describeRecurrence(
  interval: number,
  unit: RecurrenceUnit,
): string {
  if (!Number.isInteger(interval) || interval <= 0) return '—';
  const noun = interval === 1 ? UNIT_NOUN_SINGULAR[unit] : UNIT_NOUN_PLURAL[unit];
  return `Every ${interval} ${noun}`;
}
