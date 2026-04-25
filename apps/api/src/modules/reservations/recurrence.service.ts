import { Injectable, Logger } from '@nestjs/common';
import type { RecurrenceRule } from './dto/types';

/**
 * RecurrenceService — pure expander + materialisation helpers.
 *
 * The expander produces concrete (start, end) pairs from a RecurrenceRule
 * starting at a given anchor. Materialisation (writing reservations rows)
 * lives in BookingFlowService since it has to run rules + conflict guard
 * per occurrence.
 *
 * Patterns supported (per spec §5 — practical, not full RRULE):
 * - daily (every N days)
 * - weekly (specific by_day list, every N weeks)
 * - monthly (same by_month_day, every N months)
 *
 * Caps: max_occurrences (default 365); a horizon end (until or count).
 *
 * Holiday-skip: if a generated occurrence falls on a holiday in the
 * holiday calendar, it is dropped from the materialised set.
 */

const DAY_MAP: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

@Injectable()
export class RecurrenceService {
  private readonly log = new Logger(RecurrenceService.name);

  /**
   * Expand a recurrence rule into concrete occurrence start/end pairs.
   * Anchored at `anchorStart` (the master's start_at) and duration `durationMinutes`.
   * Caps to `materializedThrough` (rolling-window) if provided.
   * Skips dates in `holidayDates`.
   */
  expand(args: {
    rule: RecurrenceRule;
    anchorStart: Date;
    durationMinutes: number;
    materializedThrough?: Date;
    holidayDates?: Set<string>;             // ISO date strings YYYY-MM-DD in calendar's tz
    maxOccurrences?: number;                // hard cap, default 365
  }): Array<{ start: Date; end: Date; index: number }> {
    const {
      rule, anchorStart, durationMinutes,
      materializedThrough, holidayDates, maxOccurrences = 365,
    } = args;

    const out: Array<{ start: Date; end: Date; index: number }> = [];
    const horizonByCount = rule.count ?? Number.POSITIVE_INFINITY;
    const horizonByUntil = rule.until ? new Date(rule.until) : null;
    const horizonByWindow = materializedThrough ?? null;

    const interval = Math.max(rule.interval, 1);
    const durationMs = durationMinutes * 60 * 1000;

    const passes = (d: Date) => {
      if (horizonByUntil && d > horizonByUntil) return false;
      if (horizonByWindow && d > horizonByWindow) return false;
      return true;
    };

    const isHoliday = (d: Date) => {
      if (!holidayDates) return false;
      return holidayDates.has(this.toIsoDate(d));
    };

    let index = 0;
    let cursor = new Date(anchorStart.getTime());

    if (rule.frequency === 'daily') {
      while (passes(cursor) && out.length < Math.min(horizonByCount, maxOccurrences)) {
        if (!isHoliday(cursor)) {
          out.push({
            start: new Date(cursor.getTime()),
            end: new Date(cursor.getTime() + durationMs),
            index: index++,
          });
        }
        cursor.setUTCDate(cursor.getUTCDate() + interval);
      }
      return out;
    }

    if (rule.frequency === 'weekly') {
      // by_day: list of weekdays. If absent, use the anchor's weekday.
      const byDayDows = (rule.by_day && rule.by_day.length > 0)
        ? rule.by_day.map((d) => DAY_MAP[d]).filter((n) => n !== undefined)
        : [anchorStart.getUTCDay()];

      // Walk week-by-week. Within each week, emit one occurrence per
      // by_day weekday, in ascending order, that's >= anchor on the
      // first iteration and unrestricted thereafter.
      let weekStart = this.startOfWeek(cursor);                 // Sunday-anchored
      while (out.length < Math.min(horizonByCount, maxOccurrences)) {
        for (const dow of byDayDows.sort((a, b) => a - b)) {
          const dayDate = new Date(weekStart.getTime());
          dayDate.setUTCDate(weekStart.getUTCDate() + dow);
          // preserve time-of-day from anchor
          dayDate.setUTCHours(
            anchorStart.getUTCHours(),
            anchorStart.getUTCMinutes(),
            anchorStart.getUTCSeconds(),
            anchorStart.getUTCMilliseconds(),
          );
          if (dayDate < anchorStart) continue;
          if (!passes(dayDate)) return out;
          if (!isHoliday(dayDate)) {
            out.push({
              start: new Date(dayDate.getTime()),
              end: new Date(dayDate.getTime() + durationMs),
              index: index++,
            });
          }
          if (out.length >= Math.min(horizonByCount, maxOccurrences)) return out;
        }
        weekStart.setUTCDate(weekStart.getUTCDate() + 7 * interval);
      }
      return out;
    }

    if (rule.frequency === 'monthly') {
      const byMonthDay = rule.by_month_day ?? anchorStart.getUTCDate();
      while (out.length < Math.min(horizonByCount, maxOccurrences)) {
        const candidate = new Date(cursor.getTime());
        candidate.setUTCDate(byMonthDay);
        candidate.setUTCHours(
          anchorStart.getUTCHours(),
          anchorStart.getUTCMinutes(),
          anchorStart.getUTCSeconds(),
          anchorStart.getUTCMilliseconds(),
        );
        // If the month doesn't have that day (e.g. Feb 30), skip the month.
        if (candidate.getUTCMonth() === cursor.getUTCMonth() && candidate >= anchorStart && passes(candidate)) {
          if (!isHoliday(candidate)) {
            out.push({
              start: new Date(candidate.getTime()),
              end: new Date(candidate.getTime() + durationMs),
              index: index++,
            });
          }
        }
        cursor.setUTCMonth(cursor.getUTCMonth() + interval);
        if (!passes(cursor)) break;
      }
      return out;
    }

    this.log.warn(`Unsupported frequency: ${rule.frequency as string}`);
    return out;
  }

  /**
   * Compute an impact preview when an edit-this-and-following or series-edit
   * is requested. Pure — does not write.
   */
  previewImpact(args: {
    rule: RecurrenceRule;
    fromStart: Date;
    durationMinutes: number;
    materializedThrough?: Date;
    holidayDates?: Set<string>;
  }): { affected_occurrences: number; sample: Date[] } {
    const occ = this.expand({
      rule: args.rule,
      anchorStart: args.fromStart,
      durationMinutes: args.durationMinutes,
      materializedThrough: args.materializedThrough,
      holidayDates: args.holidayDates,
    });
    return {
      affected_occurrences: occ.length,
      sample: occ.slice(0, 10).map((o) => o.start),
    };
  }

  // --- helpers ---

  private startOfWeek(d: Date): Date {
    const out = new Date(d.getTime());
    const dow = out.getUTCDay();
    out.setUTCDate(out.getUTCDate() - dow);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }

  private toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
