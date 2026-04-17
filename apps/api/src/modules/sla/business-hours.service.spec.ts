import { BusinessHoursService, BusinessHoursCalendar } from './business-hours.service';

const weekdays = {
  monday: { start: '08:00', end: '17:00' },
  tuesday: { start: '08:00', end: '17:00' },
  wednesday: { start: '08:00', end: '17:00' },
  thursday: { start: '08:00', end: '17:00' },
  friday: { start: '08:00', end: '17:00' },
  saturday: null,
  sunday: null,
};

const utcCal: BusinessHoursCalendar = {
  time_zone: 'UTC',
  working_hours: weekdays,
  holidays: [],
};

describe('BusinessHoursService', () => {
  const svc = new BusinessHoursService();

  it('falls back to wall-clock when no calendar', () => {
    const start = new Date('2026-04-20T10:00:00Z'); // Monday
    const out = svc.addBusinessMinutes(null, start, 60);
    expect(out.toISOString()).toBe('2026-04-20T11:00:00.000Z');
  });

  it('adds within a single working day', () => {
    const start = new Date('2026-04-20T10:00:00Z'); // Monday 10:00 UTC
    const out = svc.addBusinessMinutes(utcCal, start, 120);
    expect(out.toISOString()).toBe('2026-04-20T12:00:00.000Z');
  });

  it('skips weekend when crossing day boundary', () => {
    // Friday 16:00 UTC + 2h → should land Monday 09:00 UTC (1h Fri + 1h Mon)
    const start = new Date('2026-04-24T16:00:00Z');
    const out = svc.addBusinessMinutes(utcCal, start, 120);
    expect(out.toISOString()).toBe('2026-04-27T09:00:00.000Z');
  });

  it('advances to start of window when cursor is before open', () => {
    // Monday 06:00 UTC + 1h → 09:00 UTC (1h after 08:00 open)
    const start = new Date('2026-04-20T06:00:00Z');
    const out = svc.addBusinessMinutes(utcCal, start, 60);
    expect(out.toISOString()).toBe('2026-04-20T09:00:00.000Z');
  });

  it('advances to next working day when cursor is after close', () => {
    // Monday 18:00 UTC + 60m → Tue 09:00 UTC
    const start = new Date('2026-04-20T18:00:00Z');
    const out = svc.addBusinessMinutes(utcCal, start, 60);
    expect(out.toISOString()).toBe('2026-04-21T09:00:00.000Z');
  });

  it('respects calendar time zone (Asia/Singapore = UTC+8)', () => {
    // Working hours 08:00-17:00 in Singapore. Cursor at 00:00 UTC Monday = 08:00 Singapore.
    // +60m → 01:00 UTC = 09:00 Singapore.
    const sgCal: BusinessHoursCalendar = { ...utcCal, time_zone: 'Asia/Singapore' };
    const start = new Date('2026-04-20T00:00:00Z');
    const out = svc.addBusinessMinutes(sgCal, start, 60);
    expect(out.toISOString()).toBe('2026-04-20T01:00:00.000Z');
  });

  it('skips holidays (recurring)', () => {
    // Make Apr 20 a recurring holiday. Same request lands on Apr 21 instead.
    const cal: BusinessHoursCalendar = {
      ...utcCal,
      holidays: [{ date: '2020-04-20', recurring: true, name: 'test' }],
    };
    const start = new Date('2026-04-20T10:00:00Z');
    const out = svc.addBusinessMinutes(cal, start, 60);
    expect(out.toISOString()).toBe('2026-04-21T09:00:00.000Z');
  });

  it('skips holidays (one-off)', () => {
    const cal: BusinessHoursCalendar = {
      ...utcCal,
      holidays: [{ date: '2026-04-20', name: 'one-off' }],
    };
    const start = new Date('2026-04-20T10:00:00Z');
    const out = svc.addBusinessMinutes(cal, start, 60);
    expect(out.toISOString()).toBe('2026-04-21T09:00:00.000Z');
  });

  it('returns start unchanged for zero minutes', () => {
    const start = new Date('2026-04-20T10:00:00Z');
    expect(svc.addBusinessMinutes(utcCal, start, 0).toISOString()).toBe(start.toISOString());
  });

  describe('businessMinutesBetween', () => {
    it('counts minutes within a single working window', () => {
      const from = new Date('2026-04-20T10:00:00Z'); // Monday
      const to = new Date('2026-04-20T12:00:00Z');
      expect(svc.businessMinutesBetween(utcCal, from, to)).toBe(120);
    });

    it('excludes non-working time', () => {
      // Fri 16:00 → Mon 09:00 = 1h Fri + 1h Mon = 120m
      const from = new Date('2026-04-24T16:00:00Z');
      const to = new Date('2026-04-27T09:00:00Z');
      expect(svc.businessMinutesBetween(utcCal, from, to)).toBe(120);
    });

    it('returns 0 when pause was entirely outside hours', () => {
      // Sat + Sun inside Mon non-working window → no business minutes
      const from = new Date('2026-04-25T10:00:00Z'); // Saturday
      const to = new Date('2026-04-26T10:00:00Z'); // Sunday
      expect(svc.businessMinutesBetween(utcCal, from, to)).toBe(0);
    });

    it('wall-clock fallback when no calendar', () => {
      const from = new Date('2026-04-20T10:00:00Z');
      const to = new Date('2026-04-20T11:30:00Z');
      expect(svc.businessMinutesBetween(null, from, to)).toBe(90);
    });
  });
});
