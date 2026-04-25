import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { ConflictGuardService } from './conflict-guard.service';
import type { ActorContext, RecurrenceRule, RecurrenceScope, Reservation } from './dto/types';
import type { BookingFlowService } from './booking-flow.service';

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
   * The series materialiser depends on BookingFlowService. We inject lazily
   * to avoid a circular dep with the bookingFlow → recurrenceRollover seam.
   * The service may be left undefined in lightweight unit tests that only
   * exercise pure expansion.
   */
  private bookingFlow: BookingFlowService | null = null;

  // System actor used by the materialiser + rollover cron when there's no
  // human caller. Has no override permission — recurrence-materialised rows
  // only ever land if the rules + conflict guard allow them.
  private static readonly SYSTEM_ACTOR: ActorContext = {
    user_id: 'system:recurrence',
    person_id: null,
    is_service_desk: false,
    has_override_rules: false,
  };

  // The optional Supabase service is only required when calling
  // materialize / splitSeries / cron. Passed via constructor when the module
  // wires the service; tests using `new RecurrenceService()` keep working.
  constructor(
    @Optional() private readonly supabase?: SupabaseService,
    @Optional() private readonly conflict?: ConflictGuardService,
    @Optional() private readonly tenants?: TenantService,
  ) {}

  /** Wire the booking flow lazily to break the circular dep. */
  setBookingFlow(bookingFlow: BookingFlowService) {
    this.bookingFlow = bookingFlow;
  }

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

  /**
   * Materialise additional occurrences for an existing series. Per spec §G:
   * for each occurrence the expander returns *past the current
   * materialized_through* (and not already on disk), call
   * BookingFlowService.create with `source='auto'`. Conflict-guard 23P01 is
   * caught and counted as a skip rather than aborting the run.
   *
   * Caller passes a master row (the first reservation of the series) to seed
   * the schema (space, requester, attendees, duration, buffers).
   *
   * Returns a list of created reservation IDs and a count of skipped
   * occurrences (slot already taken by someone else).
   */
  async materialize(
    seriesId: string,
    throughDate?: Date,
  ): Promise<{ created: string[]; skipped_conflicts: number }> {
    if (!this.supabase || !this.bookingFlow) {
      throw new Error('RecurrenceService.materialize requires Supabase + BookingFlowService injection');
    }

    const { data: seriesRow, error: seriesErr } = await this.supabase.admin
      .from('recurrence_series')
      .select('*')
      .eq('id', seriesId)
      .maybeSingle();
    if (seriesErr || !seriesRow) {
      throw new Error(`recurrence_series ${seriesId} not found`);
    }
    const series = seriesRow as {
      id: string;
      tenant_id: string;
      recurrence_rule: RecurrenceRule;
      series_start_at: string;
      series_end_at: string | null;
      max_occurrences: number;
      holiday_calendar_id: string | null;
      materialized_through: string;
      parent_reservation_id: string | null;
    };

    if (!series.parent_reservation_id) {
      throw new Error(`recurrence_series ${seriesId} has no parent_reservation_id`);
    }

    const { data: masterRow, error: masterErr } = await this.supabase.admin
      .from('reservations')
      .select('*')
      .eq('id', series.parent_reservation_id)
      .maybeSingle();
    if (masterErr || !masterRow) {
      throw new Error(`master reservation ${series.parent_reservation_id} not found`);
    }
    const master = masterRow as Reservation;

    const masterStart = new Date(master.start_at);
    const masterEnd = new Date(master.end_at);
    const durationMinutes = Math.max(
      1,
      Math.round((masterEnd.getTime() - masterStart.getTime()) / 60000),
    );

    // Cap the materialised window. The cron passes a future date; ad-hoc
    // calls (created on first booking) extend ~90 days forward.
    const horizon = throughDate ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const seriesEnd = series.series_end_at ? new Date(series.series_end_at) : null;
    const effectiveHorizon = seriesEnd && seriesEnd < horizon ? seriesEnd : horizon;

    const holidayDates = await this.loadHolidayDates(series.holiday_calendar_id);

    // Expand from anchor (master's start) through the horizon.
    const occurrences = this.expand({
      rule: series.recurrence_rule,
      anchorStart: masterStart,
      durationMinutes,
      materializedThrough: effectiveHorizon,
      holidayDates,
      maxOccurrences: series.max_occurrences,
    });

    // Find which occurrence indices are already on disk for this series so we
    // don't double-create on cron re-runs.
    const { data: existingRows } = await this.supabase.admin
      .from('reservations')
      .select('recurrence_index')
      .eq('tenant_id', series.tenant_id)
      .eq('recurrence_series_id', seriesId);

    const existingIndices = new Set(
      ((existingRows ?? []) as Array<{ recurrence_index: number | null }>)
        .map((r) => r.recurrence_index)
        .filter((i): i is number => typeof i === 'number'),
    );

    // Per-tick cap to avoid spikes (spec §G).
    const PER_TICK_CAP = 100;

    const created: string[] = [];
    let skipped = 0;

    for (const occ of occurrences) {
      if (created.length >= PER_TICK_CAP) break;
      if (existingIndices.has(occ.index)) continue;
      // Skip the master occurrence — it's already inserted as the parent row.
      if (occ.index === (master.recurrence_index ?? 0) && existingIndices.size === 0) {
        // First-time materialise: the master is index 0 (or whatever the
        // master used). Skip it because it already exists from
        // BookingFlowService.create().
        if (Math.abs(occ.start.getTime() - masterStart.getTime()) < 1000) continue;
      }

      try {
        const created_row = await this.bookingFlow.create(
          {
            reservation_type: master.reservation_type,
            space_id: master.space_id,
            requester_person_id: master.requester_person_id,
            host_person_id: master.host_person_id ?? null,
            start_at: occ.start.toISOString(),
            end_at: occ.end.toISOString(),
            attendee_count: master.attendee_count ?? undefined,
            attendee_person_ids: master.attendee_person_ids ?? undefined,
            recurrence_series_id: seriesId,
            recurrence_master_id: master.id,
            recurrence_index: occ.index,
            source: 'auto',
          },
          RecurrenceService.SYSTEM_ACTOR,
        );
        created.push(created_row.id);
      } catch (err) {
        // 23P01 (conflict guard) → skip, don't fail the whole run.
        if (this.conflict && this.conflict.isExclusionViolation(err)) {
          skipped += 1;
          continue;
        }
        // Approval-required / deny → skip with a warning. The user still got
        // their first booking; downstream failures shouldn't blow up the run.
        const e = err as { response?: { code?: string }; message?: string };
        const code = e.response?.code;
        if (code === 'rule_deny' || code === 'reservation_slot_conflict') {
          skipped += 1;
          continue;
        }
        this.log.warn(`materialize ${seriesId}: occurrence ${occ.index} unexpected: ${e.message}`);
        skipped += 1;
      }
    }

    // Bump materialized_through if we extended it.
    const newThrough = effectiveHorizon.toISOString();
    if (newThrough > series.materialized_through) {
      await this.supabase.admin
        .from('recurrence_series')
        .update({ materialized_through: newThrough })
        .eq('id', seriesId);
    }

    return { created, skipped_conflicts: skipped };
  }

  /**
   * Nightly rollover. For each series whose materialized_through is within
   * 90 days of now, materialise the next 90 days. Capped per tick.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'recurrenceRollover' })
  async recurrenceRollover(): Promise<void> {
    if (!this.supabase) return;
    const cutoff = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await this.supabase.admin
      .from('recurrence_series')
      .select('id, tenant_id')
      .lt('materialized_through', cutoff)
      .limit(50);

    if (error) {
      this.log.error(`recurrenceRollover scan error: ${error.message}`);
      return;
    }

    if (!data || data.length === 0) return;
    this.log.log(`recurrenceRollover: extending ${data.length} series`);

    const horizon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    for (const row of data as Array<{ id: string; tenant_id: string }>) {
      // The cron fires outside any HTTP request — there's no TenantContext.
      // materialize() → bookingFlow.create() reads TenantContext.current(),
      // so we must look up the live tenant + run the materialization inside it.
      try {
        const tenant = this.tenants ? await this.tenants.resolveById(row.tenant_id) : null;
        if (!tenant) {
          this.log.warn(`recurrenceRollover ${row.id}: tenant ${row.tenant_id} not found, skipping`);
          continue;
        }
        await TenantContext.run(tenant, async () => {
          const result = await this.materialize(row.id, horizon);
          if (result.created.length || result.skipped_conflicts) {
            this.log.log(
              `recurrenceRollover ${row.id}: created=${result.created.length} skipped=${result.skipped_conflicts}`,
            );
          }
        });
      } catch (err) {
        this.log.warn(`recurrenceRollover ${row.id} failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Split a recurrence series at `reservationId` and on. The given occurrence
   * + every subsequent occurrence move to a fresh series_id (new
   * recurrence_series row, cloned from the source). Returns the new series id.
   */
  async splitSeries(reservationId: string): Promise<string> {
    if (!this.supabase) {
      throw new Error('RecurrenceService.splitSeries requires Supabase injection');
    }

    const { data: pivot } = await this.supabase.admin
      .from('reservations')
      .select('id, tenant_id, start_at, recurrence_series_id, recurrence_index')
      .eq('id', reservationId)
      .maybeSingle();
    if (!pivot) throw new Error(`reservation ${reservationId} not found`);
    const p = pivot as {
      id: string;
      tenant_id: string;
      start_at: string;
      recurrence_series_id: string | null;
      recurrence_index: number | null;
    };
    if (!p.recurrence_series_id) {
      throw new Error('reservation is not part of a recurring series');
    }

    const { data: srcSeriesRow } = await this.supabase.admin
      .from('recurrence_series')
      .select('*')
      .eq('id', p.recurrence_series_id)
      .maybeSingle();
    if (!srcSeriesRow) {
      throw new Error(`recurrence_series ${p.recurrence_series_id} not found`);
    }
    const srcSeries = srcSeriesRow as {
      id: string;
      tenant_id: string;
      recurrence_rule: RecurrenceRule;
      series_start_at: string;
      series_end_at: string | null;
      max_occurrences: number;
      holiday_calendar_id: string | null;
      materialized_through: string;
      parent_reservation_id: string | null;
    };

    // Create the new series row anchored at this occurrence.
    const { data: newSeriesRow, error: seriesErr } = await this.supabase.admin
      .from('recurrence_series')
      .insert({
        tenant_id: srcSeries.tenant_id,
        recurrence_rule: srcSeries.recurrence_rule,
        series_start_at: p.start_at,
        series_end_at: srcSeries.series_end_at,
        max_occurrences: srcSeries.max_occurrences,
        holiday_calendar_id: srcSeries.holiday_calendar_id,
        materialized_through: srcSeries.materialized_through,
        parent_reservation_id: p.id,
      })
      .select('id')
      .single();
    if (seriesErr || !newSeriesRow) {
      throw new Error(`splitSeries failed: ${seriesErr?.message ?? 'unknown'}`);
    }
    const newSeriesId = (newSeriesRow as { id: string }).id;

    // Move this occurrence + all later occurrences onto the new series_id.
    const { error: updErr } = await this.supabase.admin
      .from('reservations')
      .update({ recurrence_series_id: newSeriesId, recurrence_master_id: p.id })
      .eq('tenant_id', srcSeries.tenant_id)
      .eq('recurrence_series_id', srcSeries.id)
      .gte('start_at', p.start_at);
    if (updErr) throw new Error(`splitSeries reseat failed: ${updErr.message}`);

    // Cap the source series so no more occurrences materialise past the pivot.
    await this.supabase.admin
      .from('recurrence_series')
      .update({ series_end_at: p.start_at })
      .eq('id', srcSeries.id);

    return newSeriesId;
  }

  /**
   * Cancel forward — used by 'this_and_following' / 'series' cancel scopes.
   * Status flipped to 'cancelled' and the series is capped so the rollover
   * job won't re-materialise the dropped occurrences.
   */
  async cancelForward(
    reservationId: string,
    scope: Extract<RecurrenceScope, 'this_and_following' | 'series'>,
    _opts: { reason?: string } = {},
  ): Promise<{ cancelled: number }> {
    if (!this.supabase) {
      throw new Error('RecurrenceService.cancelForward requires Supabase injection');
    }
    const { data: pivot } = await this.supabase.admin
      .from('reservations')
      .select('id, tenant_id, start_at, recurrence_series_id')
      .eq('id', reservationId)
      .maybeSingle();
    if (!pivot) throw new Error(`reservation ${reservationId} not found`);
    const p = pivot as {
      id: string; tenant_id: string; start_at: string; recurrence_series_id: string | null;
    };
    if (!p.recurrence_series_id) {
      throw new Error('reservation is not part of a recurring series');
    }

    let q = this.supabase.admin
      .from('reservations')
      .update({ status: 'cancelled' })
      .eq('tenant_id', p.tenant_id)
      .eq('recurrence_series_id', p.recurrence_series_id)
      .in('status', ['confirmed', 'checked_in', 'pending_approval']);

    if (scope === 'this_and_following') {
      q = q.gte('start_at', p.start_at);
    }
    // 'series' → no time gate; cancels everything in the series.

    const { data, error } = await q.select('id');
    if (error) throw new Error(`cancelForward failed: ${error.message}`);

    // Cap the series so the rollover doesn't re-create.
    await this.supabase.admin
      .from('recurrence_series')
      .update({ series_end_at: scope === 'this_and_following' ? p.start_at : new Date(0).toISOString() })
      .eq('id', p.recurrence_series_id);

    return { cancelled: (data ?? []).length };
  }

  // --- helpers ---

  private async loadHolidayDates(calendarId: string | null): Promise<Set<string>> {
    if (!calendarId || !this.supabase) return new Set();
    const { data } = await this.supabase.admin
      .from('business_hours_calendars')
      .select('holidays')
      .eq('id', calendarId)
      .maybeSingle();
    const holidays = (data as { holidays?: Array<{ date?: string } | string> } | null)?.holidays;
    if (!holidays || !Array.isArray(holidays)) return new Set();
    const out = new Set<string>();
    for (const h of holidays) {
      if (typeof h === 'string') out.add(h.slice(0, 10));
      else if (h && typeof h.date === 'string') out.add(h.date.slice(0, 10));
    }
    return out;
  }

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
