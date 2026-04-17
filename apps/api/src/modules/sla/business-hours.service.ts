import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

export interface WorkingDay {
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
}

export interface Holiday {
  date: string; // 'YYYY-MM-DD'
  name?: string;
  recurring?: boolean; // if true, matches every year on MM-DD
}

export interface BusinessHoursCalendar {
  time_zone: string;
  working_hours: Record<string, WorkingDay | null>;
  holidays: Holiday[];
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

@Injectable()
export class BusinessHoursService {
  /**
   * Add `minutes` of business time to `start`, respecting the calendar's working hours,
   * holidays, and timezone. If `calendar` is null, falls back to wall-clock addition.
   */
  addBusinessMinutes(calendar: BusinessHoursCalendar | null, start: Date, minutes: number): Date {
    if (!calendar) {
      return new Date(start.getTime() + minutes * 60_000);
    }
    if (minutes <= 0) return start;

    const tz = calendar.time_zone || 'UTC';
    let cursor = DateTime.fromJSDate(start, { zone: tz });
    let remaining = minutes;
    let safety = 0;
    const maxIterations = 400; // ~1 year of working days, prevents infinite loops on bad config

    while (remaining > 0 && safety++ < maxIterations) {
      const window = this.windowFor(calendar, cursor);
      if (!window) {
        cursor = this.startOfNextDay(cursor);
        continue;
      }
      const [winStart, winEnd] = window;
      if (cursor < winStart) cursor = winStart;
      if (cursor >= winEnd) {
        cursor = this.startOfNextDay(cursor);
        continue;
      }
      const availableMinutes = Math.floor(winEnd.diff(cursor, 'minutes').minutes);
      if (availableMinutes <= 0) {
        cursor = this.startOfNextDay(cursor);
        continue;
      }
      const take = Math.min(remaining, availableMinutes);
      cursor = cursor.plus({ minutes: take });
      remaining -= take;
    }

    return cursor.toJSDate();
  }

  private windowFor(
    calendar: BusinessHoursCalendar,
    cursor: DateTime,
  ): [DateTime, DateTime] | null {
    if (this.isHoliday(calendar, cursor)) return null;

    const dayKey = DAY_KEYS[cursor.weekday === 7 ? 0 : cursor.weekday];
    const wd = calendar.working_hours?.[dayKey];
    if (!wd) return null;

    const [sh, sm] = wd.start.split(':').map(Number);
    const [eh, em] = wd.end.split(':').map(Number);
    const start = cursor.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
    const end = cursor.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
    if (end <= start) return null;
    return [start, end];
  }

  private isHoliday(calendar: BusinessHoursCalendar, cursor: DateTime): boolean {
    if (!calendar.holidays?.length) return false;
    const mmdd = cursor.toFormat('MM-dd');
    const full = cursor.toFormat('yyyy-MM-dd');
    return calendar.holidays.some((h) => {
      if (!h.date) return false;
      if (h.recurring) return h.date.slice(5) === mmdd;
      return h.date === full;
    });
  }

  /**
   * Count business minutes between `from` and `to` (non-negative).
   * Used to correctly shift due_at after a ticket leaves a paused state.
   */
  businessMinutesBetween(calendar: BusinessHoursCalendar | null, from: Date, to: Date): number {
    if (to <= from) return 0;
    if (!calendar) return Math.floor((to.getTime() - from.getTime()) / 60_000);

    const tz = calendar.time_zone || 'UTC';
    let cursor = DateTime.fromJSDate(from, { zone: tz });
    const end = DateTime.fromJSDate(to, { zone: tz });
    let total = 0;
    let safety = 0;
    const maxIterations = 400;

    while (cursor < end && safety++ < maxIterations) {
      const window = this.windowFor(calendar, cursor);
      if (!window) {
        cursor = this.startOfNextDay(cursor);
        continue;
      }
      const [winStart, winEnd] = window;
      if (cursor < winStart) cursor = winStart;
      if (cursor >= winEnd) {
        cursor = this.startOfNextDay(cursor);
        continue;
      }
      const segmentEnd = winEnd < end ? winEnd : end;
      total += Math.max(0, Math.floor(segmentEnd.diff(cursor, 'minutes').minutes));
      cursor = segmentEnd;
      if (segmentEnd === winEnd) cursor = this.startOfNextDay(cursor);
    }
    return total;
  }

  private startOfNextDay(cursor: DateTime): DateTime {
    return cursor.plus({ days: 1 }).startOf('day');
  }
}
