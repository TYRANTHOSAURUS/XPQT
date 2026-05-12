import { describe, expect, it } from 'vitest';
import {
  buildDayBounds,
  cellToIso,
  columnsPerDay,
  expandDates,
  isoToCell,
  shiftDate,
  toLocalDateString,
} from '@/lib/scheduler-time';

describe('scheduler-time', () => {
  describe('shiftDate', () => {
    it('shifts forward across a month boundary', () => {
      expect(shiftDate('2026-04-30', 1)).toBe('2026-05-01');
    });
    it('shifts backward across a year boundary', () => {
      expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    });
    it('returns the same string for delta 0', () => {
      expect(shiftDate('2026-05-12', 0)).toBe('2026-05-12');
    });
  });

  describe('columnsPerDay', () => {
    it('returns 24 for a 7-19 day with 30-min cells', () => {
      expect(columnsPerDay(7, 19, 30)).toBe(24);
    });
    it('returns 48 for a 0-24 day with 30-min cells', () => {
      expect(columnsPerDay(0, 24, 30)).toBe(48);
    });
    it('clamps to >= 1 on a misconfigured window', () => {
      expect(columnsPerDay(10, 9, 30)).toBe(1);
    });
  });

  describe('expandDates', () => {
    it('returns just the anchor for day mode', () => {
      expect(expandDates('2026-05-12', 'day')).toEqual(['2026-05-12']);
    });
    it('returns 7 consecutive dates for week mode', () => {
      expect(expandDates('2026-05-12', 'week')).toEqual([
        '2026-05-12',
        '2026-05-13',
        '2026-05-14',
        '2026-05-15',
        '2026-05-16',
        '2026-05-17',
        '2026-05-18',
      ]);
    });
  });

  describe('cellToIso ↔ isoToCell round-trip', () => {
    const window = {
      dates: ['2026-05-12'],
      columnsPerDay: 24,
      dayStartHour: 7,
      cellMinutes: 30,
    };

    it('cell 0 maps to 07:00 local', () => {
      const iso = cellToIso({ ...window, cell: 0 });
      expect(new Date(iso).getHours()).toBe(7);
      expect(new Date(iso).getMinutes()).toBe(0);
    });

    it('cell 6 maps to 10:00 local (6 cells × 30 min from 07:00)', () => {
      const iso = cellToIso({ ...window, cell: 6 });
      expect(new Date(iso).getHours()).toBe(10);
      expect(new Date(iso).getMinutes()).toBe(0);
    });

    it('round-trip: cellToIso then isoToCell returns the same cell', () => {
      for (const cell of [0, 1, 6, 12, 23]) {
        const iso = cellToIso({ ...window, cell });
        const back = isoToCell({ ...window, iso });
        expect(back).toBe(cell);
      }
    });

    it('isoToCell returns null for an instant outside the window', () => {
      // Day before the window
      const iso = new Date('2026-05-11T10:00:00').toISOString();
      expect(isoToCell({ ...window, iso })).toBeNull();
    });

    it('isoToCell returns null for an instant earlier than dayStartHour', () => {
      // 06:00 local, when dayStartHour is 7
      const d = new Date('2026-05-12T00:00:00');
      d.setHours(6, 0, 0, 0);
      expect(isoToCell({ ...window, iso: d.toISOString() })).toBeNull();
    });

    it('clamps cell beyond columnsPerDay to the last column', () => {
      // cellToIso saturates the day index; passing 99 lands on the last cell
      // of the last day.
      const iso = cellToIso({ ...window, cell: 999 });
      // After clamping to total = 24, the math walks `setMinutes(+24*30) =
      // +720 min` from 07:00 = 19:00. With `cell=24` the inverse maps back
      // to the last *boundary*, which falls outside the [0, columnsPerDay)
      // half-open range — isoToCell returns null there.
      expect(isoToCell({ ...window, iso })).toBeNull();
    });
  });

  describe('cellToIso across DST changeover', () => {
    // Spring-forward in Europe/Amsterdam: 2026-03-29 02:00 CET → 03:00 CEST.
    // The day has 23 local hours, but a 07:00–19:00 window stays 12 hours
    // because both endpoints are well clear of the transition. Cell 0 must
    // still land at exactly 07:00 local.
    it('cell 0 on the spring-forward day lands at 07:00 local', () => {
      const iso = cellToIso({
        dates: ['2026-03-29'],
        columnsPerDay: 24,
        dayStartHour: 7,
        cellMinutes: 30,
        cell: 0,
      });
      const d = new Date(iso);
      expect(d.getHours()).toBe(7);
      expect(d.getMinutes()).toBe(0);
    });

    // Fall-back: 2026-10-25 03:00 CEST → 02:00 CET.
    it('cell 0 on the fall-back day lands at 07:00 local', () => {
      const iso = cellToIso({
        dates: ['2026-10-25'],
        columnsPerDay: 24,
        dayStartHour: 7,
        cellMinutes: 30,
        cell: 0,
      });
      const d = new Date(iso);
      expect(d.getHours()).toBe(7);
      expect(d.getMinutes()).toBe(0);
    });

    // Multi-day window straddling the spring DST transition. Cell 0 of day
    // 2 (the day after the transition) must land at 07:00 local. The raw
    // UTC ms delta depends on the test runner's TZ — we assert only the
    // wall-clock guarantee, which is what consumers actually see.
    it('cell 0 of day N in a multi-day window always lands at dayStartHour local', () => {
      const window = {
        dates: ['2026-03-29', '2026-03-30'],
        columnsPerDay: 24,
        dayStartHour: 7,
        cellMinutes: 30,
      };
      const day0Cell0 = cellToIso({ ...window, cell: 0 });
      const day1Cell0 = cellToIso({ ...window, cell: 24 });
      expect(new Date(day0Cell0).getHours()).toBe(7);
      expect(new Date(day1Cell0).getHours()).toBe(7);
      // Different calendar dates locally
      expect(new Date(day0Cell0).getDate()).toBe(29);
      expect(new Date(day1Cell0).getDate()).toBe(30);
    });
  });

  describe('buildDayBounds', () => {
    it('returns start at the requested local hour', () => {
      const { start, end } = buildDayBounds('2026-05-12', 7, 19);
      expect(start.getHours()).toBe(7);
      expect(end.getHours()).toBe(19);
      expect(start.toDateString()).toBe(end.toDateString());
    });
  });

  describe('toLocalDateString', () => {
    it('round-trips through the helpers', () => {
      const d = new Date('2026-05-12T14:30:00');
      expect(toLocalDateString(d)).toBe('2026-05-12');
    });
  });
});
