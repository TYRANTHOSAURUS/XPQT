import {
  advanceRecurrence,
  advanceToNextFuture,
  computeInitialNextRunAt,
  isRecurrenceUnit,
  parseAnchorDateToUtc,
} from './recurrence';

describe('recurrence', () => {
  describe('advanceRecurrence', () => {
    it('advances by day', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'day').toISOString()).toBe(
        '2026-05-14T09:00:00.000Z',
      );
      expect(advanceRecurrence(from, 14, 'day').toISOString()).toBe(
        '2026-05-27T09:00:00.000Z',
      );
    });

    it('advances by week', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'week').toISOString()).toBe(
        '2026-05-20T09:00:00.000Z',
      );
      expect(advanceRecurrence(from, 2, 'week').toISOString()).toBe(
        '2026-05-27T09:00:00.000Z',
      );
    });

    it('advances by month', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'month').toISOString()).toBe(
        '2026-06-13T09:00:00.000Z',
      );
      expect(advanceRecurrence(from, 3, 'month').toISOString()).toBe(
        '2026-08-13T09:00:00.000Z',
      );
    });

    it('advances by year', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'year').toISOString()).toBe(
        '2027-05-13T09:00:00.000Z',
      );
    });

    it('clamps day-of-month on month-end (Jan 31 + 1 month = Feb 28)', () => {
      const from = new Date('2026-01-31T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'month').toISOString()).toBe(
        '2026-02-28T09:00:00.000Z',
      );
    });

    it('clamps day-of-month on month-end (Aug 31 + 1 month = Sep 30)', () => {
      const from = new Date('2026-08-31T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'month').toISOString()).toBe(
        '2026-09-30T09:00:00.000Z',
      );
    });

    it('clamps leap-day on year advance (2024-02-29 + 1 year = 2025-02-28)', () => {
      const from = new Date('2024-02-29T09:00:00.000Z');
      expect(advanceRecurrence(from, 1, 'year').toISOString()).toBe(
        '2025-02-28T09:00:00.000Z',
      );
    });

    it('keeps day-of-month when target month has the day (2024-02-29 + 4 year = 2028-02-29)', () => {
      const from = new Date('2024-02-29T09:00:00.000Z');
      expect(advanceRecurrence(from, 4, 'year').toISOString()).toBe(
        '2028-02-29T09:00:00.000Z',
      );
    });

    it('rejects non-positive interval', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      expect(() => advanceRecurrence(from, 0, 'day')).toThrow();
      expect(() => advanceRecurrence(from, -1, 'day')).toThrow();
    });

    it('rejects unknown unit', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      expect(() => advanceRecurrence(from, 1, 'fortnight' as never)).toThrow();
    });
  });

  describe('advanceToNextFuture', () => {
    it('returns from unchanged when already in the future', () => {
      const from = new Date('2026-06-01T09:00:00.000Z');
      const now = new Date('2026-05-13T09:00:00.000Z');
      expect(advanceToNextFuture(from, 1, 'month', now).toISOString()).toBe(
        '2026-06-01T09:00:00.000Z',
      );
    });

    it('advances until future when starting in the past (monthly)', () => {
      const from = new Date('2026-01-15T09:00:00.000Z');
      const now = new Date('2026-04-20T09:00:00.000Z');
      expect(advanceToNextFuture(from, 1, 'month', now).toISOString()).toBe(
        '2026-05-15T09:00:00.000Z',
      );
    });

    it('advances exactly once when one step puts cursor in the future (daily)', () => {
      const from = new Date('2026-05-13T09:00:00.000Z');
      const now = new Date('2026-05-13T10:00:00.000Z');
      expect(advanceToNextFuture(from, 1, 'day', now).toISOString()).toBe(
        '2026-05-14T09:00:00.000Z',
      );
    });

    it('caps iteration to prevent infinite loop on pathological anchor', () => {
      const from = new Date('1970-01-01T09:00:00.000Z');
      const now = new Date('2026-05-13T09:00:00.000Z');
      expect(() => advanceToNextFuture(from, 1, 'day', now, 100)).toThrow(
        /exceeded 100 iterations/,
      );
    });
  });

  describe('parseAnchorDateToUtc', () => {
    it('parses YYYY-MM-DD into 09:00 UTC', () => {
      expect(parseAnchorDateToUtc('2026-05-13').toISOString()).toBe(
        '2026-05-13T09:00:00.000Z',
      );
    });

    it('rejects malformed strings', () => {
      expect(() => parseAnchorDateToUtc('2026-5-13')).toThrow();
      expect(() => parseAnchorDateToUtc('13-05-2026')).toThrow();
      expect(() => parseAnchorDateToUtc('not a date')).toThrow();
    });

    it('rejects out-of-range calendar values', () => {
      expect(() => parseAnchorDateToUtc('2026-13-01')).toThrow();
      expect(() => parseAnchorDateToUtc('2026-02-30')).toThrow();
      expect(() => parseAnchorDateToUtc('2026-02-29')).toThrow();
    });
  });

  describe('computeInitialNextRunAt', () => {
    it('returns the anchor when anchor is in the future', () => {
      const now = new Date('2026-05-13T09:00:00.000Z');
      expect(
        computeInitialNextRunAt('2026-06-01', 1, 'month', now).toISOString(),
      ).toBe('2026-06-01T09:00:00.000Z');
    });

    it('advances forward when anchor is in the past', () => {
      const now = new Date('2026-05-13T12:00:00.000Z');
      expect(
        computeInitialNextRunAt('2026-01-01', 1, 'month', now).toISOString(),
      ).toBe('2026-06-01T09:00:00.000Z');
    });

    it('handles daily cadence anchored last week', () => {
      const now = new Date('2026-05-13T12:00:00.000Z');
      expect(
        computeInitialNextRunAt('2026-05-06', 1, 'day', now).toISOString(),
      ).toBe('2026-05-14T09:00:00.000Z');
    });
  });

  describe('isRecurrenceUnit', () => {
    it('accepts the four canonical units', () => {
      expect(isRecurrenceUnit('day')).toBe(true);
      expect(isRecurrenceUnit('week')).toBe(true);
      expect(isRecurrenceUnit('month')).toBe(true);
      expect(isRecurrenceUnit('year')).toBe(true);
    });

    it('rejects junk', () => {
      expect(isRecurrenceUnit('fortnight')).toBe(false);
      expect(isRecurrenceUnit(null)).toBe(false);
      expect(isRecurrenceUnit(undefined)).toBe(false);
      expect(isRecurrenceUnit(7)).toBe(false);
    });
  });
});
