import { RecurrenceService } from './recurrence.service';

describe('RecurrenceService.expand', () => {
  const svc = new RecurrenceService();

  describe('daily', () => {
    it('emits N occurrences when count is set', () => {
      const occ = svc.expand({
        rule: { frequency: 'daily', interval: 1, count: 5 },
        anchorStart: new Date('2026-05-01T09:00:00Z'),
        durationMinutes: 60,
      });
      expect(occ).toHaveLength(5);
      expect(occ[0].start.toISOString()).toBe('2026-05-01T09:00:00.000Z');
      expect(occ[1].start.toISOString()).toBe('2026-05-02T09:00:00.000Z');
      expect(occ[4].start.toISOString()).toBe('2026-05-05T09:00:00.000Z');
    });

    it('respects "until"', () => {
      const occ = svc.expand({
        rule: { frequency: 'daily', interval: 1, until: '2026-05-03T09:00:00Z' },
        anchorStart: new Date('2026-05-01T09:00:00Z'),
        durationMinutes: 60,
      });
      expect(occ).toHaveLength(3);
    });

    it('honors interval (every 2 days)', () => {
      const occ = svc.expand({
        rule: { frequency: 'daily', interval: 2, count: 4 },
        anchorStart: new Date('2026-05-01T09:00:00Z'),
        durationMinutes: 60,
      });
      expect(occ.map(o => o.start.toISOString())).toEqual([
        '2026-05-01T09:00:00.000Z',
        '2026-05-03T09:00:00.000Z',
        '2026-05-05T09:00:00.000Z',
        '2026-05-07T09:00:00.000Z',
      ]);
    });

    it('skips holidays', () => {
      const holidays = new Set(['2026-05-02', '2026-05-04']);
      const occ = svc.expand({
        rule: { frequency: 'daily', interval: 1, count: 3 },  // counts BEFORE holiday filter
        anchorStart: new Date('2026-05-01T09:00:00Z'),
        durationMinutes: 60,
        holidayDates: holidays,
      });
      // Holiday-skip drops occurrences from the materialised set; we still
      // visit `count` candidates so the result is at most `count`.
      expect(occ.length).toBeLessThanOrEqual(3);
      const dates = occ.map(o => o.start.toISOString().slice(0, 10));
      expect(dates).not.toContain('2026-05-02');
      expect(dates).not.toContain('2026-05-04');
    });

    it('caps at maxOccurrences', () => {
      const occ = svc.expand({
        rule: { frequency: 'daily', interval: 1 }, // no count
        anchorStart: new Date('2026-05-01T09:00:00Z'),
        durationMinutes: 60,
        maxOccurrences: 7,
        materializedThrough: new Date('2026-12-31T00:00:00Z'),
      });
      expect(occ).toHaveLength(7);
    });

    it('caps at materializedThrough', () => {
      const occ = svc.expand({
        rule: { frequency: 'daily', interval: 1 },
        anchorStart: new Date('2026-05-01T09:00:00Z'),
        durationMinutes: 60,
        materializedThrough: new Date('2026-05-04T23:59:59Z'),
      });
      // 1, 2, 3, 4 — four days within the window
      expect(occ).toHaveLength(4);
    });
  });

  describe('weekly', () => {
    it('emits one per week using anchor weekday when by_day is omitted', () => {
      // 2026-05-01 is a Friday
      const occ = svc.expand({
        rule: { frequency: 'weekly', interval: 1, count: 4 },
        anchorStart: new Date('2026-05-01T10:00:00Z'),
        durationMinutes: 30,
      });
      expect(occ).toHaveLength(4);
      // Each occurrence on a Friday, 7 days apart
      occ.forEach((o, i) => {
        if (i === 0) return;
        const delta = o.start.getTime() - occ[i - 1].start.getTime();
        expect(delta).toBe(7 * 24 * 60 * 60 * 1000);
      });
    });

    it('emits multiple by_day per week, ordered by weekday', () => {
      const occ = svc.expand({
        rule: { frequency: 'weekly', interval: 1, by_day: ['MO', 'WE', 'FR'], count: 6 },
        anchorStart: new Date('2026-05-01T10:00:00Z'),  // Friday
        durationMinutes: 30,
      });
      expect(occ).toHaveLength(6);
      // First should be the anchor (Friday); next should be Monday
      expect(occ[0].start.toISOString().slice(0, 10)).toBe('2026-05-01');
      expect(occ[1].start.toISOString().slice(0, 10)).toBe('2026-05-04');  // Mon
      expect(occ[2].start.toISOString().slice(0, 10)).toBe('2026-05-06');  // Wed
      expect(occ[3].start.toISOString().slice(0, 10)).toBe('2026-05-08');  // Fri
    });

    it('honors interval (every 2nd week)', () => {
      const occ = svc.expand({
        rule: { frequency: 'weekly', interval: 2, by_day: ['MO'], count: 3 },
        anchorStart: new Date('2026-05-04T10:00:00Z'),  // Monday
        durationMinutes: 30,
      });
      expect(occ.map(o => o.start.toISOString().slice(0, 10))).toEqual([
        '2026-05-04', '2026-05-18', '2026-06-01',
      ]);
    });
  });

  describe('monthly', () => {
    it('emits same day-of-month each month', () => {
      const occ = svc.expand({
        rule: { frequency: 'monthly', interval: 1, count: 3 },
        anchorStart: new Date('2026-05-15T14:00:00Z'),
        durationMinutes: 60,
      });
      expect(occ.map(o => o.start.toISOString().slice(0, 10))).toEqual([
        '2026-05-15', '2026-06-15', '2026-07-15',
      ]);
    });

    it('skips months without the specified day-of-month', () => {
      const occ = svc.expand({
        rule: { frequency: 'monthly', interval: 1, by_month_day: 31, count: 4 },
        anchorStart: new Date('2026-01-31T10:00:00Z'),
        durationMinutes: 60,
      });
      // January, March, May, July — Feb (28-day), April (30-day) skipped
      const isoDates = occ.map(o => o.start.toISOString().slice(0, 10));
      expect(isoDates[0]).toBe('2026-01-31');
      expect(isoDates).not.toContain('2026-02-28');
      expect(isoDates).not.toContain('2026-04-30');
    });
  });
});

describe('RecurrenceService.previewImpact', () => {
  const svc = new RecurrenceService();

  it('summarizes affected occurrences with sample of 10', () => {
    const result = svc.previewImpact({
      rule: { frequency: 'daily', interval: 1, count: 30 },
      fromStart: new Date('2026-05-01T09:00:00Z'),
      durationMinutes: 60,
    });
    expect(result.affected_occurrences).toBe(30);
    expect(result.sample).toHaveLength(10);
  });
});
