import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors, isAppError, type AppError } from '../../common/errors';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { ConflictGuardService } from './conflict-guard.service';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { buildSplitSeriesIdempotencyKey } from '@prequest/shared';
import type { ActorContext, RecurrenceRule, RecurrenceScope } from './dto/types';
import type { BookingFlowService } from './booking-flow.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from './reservation-projection';

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

/**
 * Booking-audit Slice 7 (audit 03 P2-1) — audit-event types ported
 * VERBATIM from the retired BookingCompensationService
 * (booking-compensation.service.ts:13-14). Emitted to `audit_events`
 * by `deleteOrphanOccurrence` so ops have a discoverable surface for
 * orphaned occurrence bookings. Naming follows the `booking.<verb>`
 * convention so compensation events sort with their siblings.
 */
const AUDIT_COMPENSATION_FAILED = 'booking.compensation_failed';
const AUDIT_COMPENSATION_PARTIAL = 'booking.compensation_partial_failure';

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
  /**
   * Sub-project 2 fan-out: when a master booking has services attached,
   * clone its orders + lines + asset_reservations for each new occurrence.
   * Wired lazily because OrdersModule imports ServiceCatalogModule which
   * imports RoomBookingRulesModule — a circular dep at the import level.
   *
   * Post-canonicalisation (2026-05-02): the booking IS the bundle (00277:27),
   * so the per-occurrence "bundle id" passed downstream equals the
   * occurrence's booking id. Field name kept as `bundleId` for OrderService
   * signature compatibility — the OrdersModule rewrite is a separate slice.
   * `newReservation.id` here is the occurrence's BOOKING id (Slice A
   * BookingFlowService.create return shape).
   */
  private orders: { cloneOrderForOccurrence: (args: {
    masterOrderId: string;
    newReservation: { id: string; start_at: string; end_at: string };
    masterReservationStartAt: string;
    bundleId: string;
    recurrenceSeriesId: string | null;
    requesterPersonId: string;
  }) => Promise<unknown> } | null = null;

  /**
   * Sub-project 2 cascade wiring was REMOVED by booking-audit Slice 2
   * (audit 03 P0-1/P1-5): the only consumer was `cancelForward`'s
   * non-atomic per-occurrence `cancelOrdersForReservation` loop, which is
   * now retired (the atomic `cancel_booking_with_cascade` RPC 00408 owns
   * the whole cascade — orders/OLIs/asset_reservations/work_orders/
   * approvals — for every scope, called via ReservationService.cancelOne).
   * No lazy `setBundleCascade` setter remains; the dead wiring was dropped
   * from reservations.module.ts in the same change.
   */

  // System actor used by the materialiser + rollover cron when there's no
  // human caller. Has no override permission — recurrence-materialised rows
  // only ever land if the rules + conflict guard allow them.
  private static readonly SYSTEM_ACTOR: ActorContext = {
    user_id: 'system:recurrence',
    // Synthetic — the materialiser only calls bookingFlow.create, never
    // the F-CRIT-1 edit RPCs. Mirror user_id so the required field is set.
    auth_uid: 'system:recurrence',
    person_id: null,
    is_service_desk: false,
    has_override_rules: false,
  };

  // F-CRIT-1 landmine guard (I1): split_recurrence_series.p_actor_user_id
  // is `uuid`-typed (00411:97). A non-uuid string (e.g. the synthetic
  // SYSTEM_ACTOR.auth_uid = 'system:recurrence', line above) sent to a
  // uuid bind 500s on supabase-js/PostgREST BEFORE the SQL runs — the
  // RPC's null-actor branch (00411:135) never gets the chance to handle
  // it. Coerce any absent OR synthetic `system:*` sentinel auth_uid to
  // null so the RPC takes its null-actor path (audit actor_user_id =
  // null) instead of crashing. A genuine JWT uuid passes through. Only
  // the editScope-commit caller (a real JWT) reaches splitSeries today,
  // so this is currently latent — but every splitSeries-class caller
  // that could pass a synthetic actor must route auth_uid through here.
  private static actorAuthUidForRpc(actor: ActorContext): string | null {
    const uid = actor.auth_uid;
    if (!uid || uid.startsWith('system:')) return null;
    return uid;
  }

  // The optional Supabase service is only required when calling
  // materialize / splitSeries / cron. Passed via constructor when the module
  // wires the service; tests using `new RecurrenceService()` keep working.
  //
  // Booking-audit Slice 7 (audit 03 P2-1) — the legacy
  // BookingTransactionBoundary + BookingCompensationService injects were
  // retired. The occurrence-clone compensation is now a focused private
  // direct-delete helper (`deleteOrphanOccurrence`) that calls the
  // `delete_booking_with_guard` RPC (00292 / 00373) directly and reproduces
  // the audit-emit + don't-advance-materialized_through semantics the
  // materialize() loop keys on.
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
   * Wire the orders fan-out lazily — same circular-dep avoidance as
   * `setBookingFlow`. When unset, recurrence materialises reservations
   * normally and skips the bundle fan-out (no service cloning).
   */
  setOrdersFanOut(handler: NonNullable<RecurrenceService['orders']>) {
    this.orders = handler;
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
   * BookingFlowService.create with `source='recurrence'` (Slice 8 P2-2 —
   * the resolved value; was `'auto'` until the shim was removed).
   * Conflict-guard 23P01 is caught and counted as a skip rather than
   * aborting the run.
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
      throw AppErrors.server('booking.recurrence_not_injected', { detail: 'RecurrenceService.materialize requires Supabase + BookingFlowService injection' });
    }

    // /full-review v3 closure I3 — tenant_id on every read/write.
    //
    // Pre-fix: the series lookup was `.eq('id', seriesId)` only. Even
    // though admin client bypasses RLS, the missing tenant filter
    // violates the #0 invariant: every query must scope to a tenant.
    // The cron caller wraps materialize() in TenantContext.run(...) per
    // recurrence.service.ts:660-668 so the context is always set when
    // we reach this method through the cron path. Ad-hoc callers
    // (admin tooling) must do the same.
    const ctxTenantId = TenantContext.currentOrNull()?.id ?? null;

    const seriesQuery = this.supabase.admin
      .from('recurrence_series')
      .select('*')
      .eq('id', seriesId);
    if (ctxTenantId) seriesQuery.eq('tenant_id', ctxTenantId);
    const { data: seriesRow, error: seriesErr } = await seriesQuery.maybeSingle();
    if (seriesErr || !seriesRow) {
      throw AppErrors.server('booking.recurrence_series_not_found', { detail: `recurrence_series ${seriesId} not found` });
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
      // Renamed from parent_reservation_id (00278:179-181). Now points at
      // bookings.id; each occurrence is its own booking.
      parent_booking_id: string | null;
    };

    if (!series.parent_booking_id) {
      throw AppErrors.server('booking.recurrence_series_not_found', { detail: `recurrence_series ${seriesId} has no parent_booking_id` });
    }

    // Defensive: if there's a TenantContext, the series we loaded MUST
    // belong to it (the explicit eq above already enforced that). When
    // called outside a context (legacy ad-hoc callers), trust series.tenant_id
    // as the authoritative scope and use it for every subsequent query.
    const tenantId = ctxTenantId ?? series.tenant_id;

    // Read the master booking + its primary slot to seed each new occurrence.
    // Pre-rewrite this was one read of `reservations`; now it's a 2-step
    // read through `bookings` + `booking_slots` (00277:27,116). The legacy
    // `Reservation` shape is reconstructed via the projection helper so
    // downstream cloning code (which still consumes `Reservation`) doesn't
    // change.
    const masterBookingId = series.parent_booking_id;
    const { data: masterSlotRow, error: masterErr } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .eq('booking_id', masterBookingId)
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (masterErr || !masterSlotRow) {
      throw AppErrors.server('booking.master_not_found', { detail: `master booking ${masterBookingId} not found` });
    }
    const master = slotWithBookingToReservation(
      masterSlotRow as unknown as SlotWithBookingEmbed,
    );
    // If the user cancelled forward from the very first occurrence, the
    // master row itself is now cancelled. Continuing here would happily
    // re-materialise occurrences anchored on a cancelled row — visually
    // the series would resurrect itself. The capped `series_end_at`
    // already protects the rollover cron from picking this series up,
    // but ad-hoc materialize() callers (admin tooling, manual extends)
    // shouldn't be able to bypass that. Treat as a no-op.
    if (
      master.status === 'cancelled' ||
      master.status === 'released' ||
      master.recurrence_skipped
    ) {
      this.log.warn(
        `materialize ${seriesId}: master ${master.id} is ${master.status}, skipping`,
      );
      return { created: [], skipped_conflicts: 0 };
    }

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
    // don't double-create on cron re-runs. Recurrence index lives on the
    // BOOKING (00277:75) post-canonicalisation, not the slot.
    const { data: existingRows } = await this.supabase.admin
      .from('bookings')
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
    // /full-review v3 closure I4 — distinguish EXPECTED failures (skip
    // OK; advance materialized_through) from UNEXPECTED failures (do
    // NOT advance; retry on next call).
    //
    // Expected (compensation-aware skip):
    //   - GiST exclusion (23P01) — slot taken, occurrence permanently
    //     unavailable for this anchor. Skip + advance.
    //   - rule_deny / reservation_slot_conflict — rule outcome at
    //     create-time; user-correctable. Skip + advance (re-tries
    //     don't help; the rule still denies).
    //
    // Unexpected (retry signal):
    //   - booking.compensation_failed (RPC blew up, booking persists in
    //     unknown state). Manual recovery in audit_events; on next
    //     materialize() the occurrence may finally clone cleanly. Do
    //     NOT advance materialized_through past it.
    //   - booking.partial_failure (recurrence_series blocker). The
    //     orphan booking persists; ops must clear the blocker first.
    //     Same retry signal: don't advance.
    //   - Any other unknown exception. We don't know if the booking
    //     committed or not, so be conservative and retry.
    let sawUnexpectedFailure = false;

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
            // recurrence_master_id dropped from canonical schema — series
            // → bookings is one-direction (00277). The series row's
            // parent_booking_id (00278:179-181) is the only link.
            recurrence_index: occ.index,
            // Booking-audit Slice 8 (audit 03 P2-2) — was `source:'auto'`;
            // resolution is now hoisted to this producer. The recurrence
            // materialiser is ALWAYS the recurrence actor
            // (RecurrenceService.SYSTEM_ACTOR.user_id = 'system:recurrence',
            // recurrence.service.ts:100) so the resolved value is always
            // `'recurrence'` — pass it directly instead of emitting the
            // removed `'auto'` shim and letting the consumer re-derive it.
            source: 'recurrence',
          },
          RecurrenceService.SYSTEM_ACTOR,
        );

        // Sub-project 2 fan-out: if the master has services, clone its
        // orders + lines + asset_reservations onto the new occurrence.
        //
        // Post-canonicalisation (2026-05-02): the booking IS the bundle
        // (00277:27). We pass the OCCURRENCE's booking id (created_row.id)
        // as the `bundleId` so the cloned orders attach to the new
        // occurrence's booking — not the master's.
        //
        // Booking-audit Slice 7 (audit 03 P2-1) — clone-with-compensation,
        // direct (no BookingTransactionBoundary / BookingCompensationService).
        //
        // Pre-Slice-7: the clone step was wrapped in
        // `BookingTransactionBoundary.runWithCompensation(occId, clone,
        // (id) => compensation.deleteBooking(id))` (booking-transaction-
        // boundary.ts:77-149 + booking-compensation.service.ts:58-126).
        // Both legacy classes are retired. Their behaviour is reproduced
        // VERBATIM inline here:
        //
        //   1. run `cloneBundleOrdersToOccurrence` (UNCHANGED — it
        //      legitimately needs the TS JSONLogic rule resolver via
        //      OrderService.cloneOrderForOccurrence; stays in TS).
        //   2. on throw → `deleteOrphanOccurrence(occId, tenantId)` which
        //      calls `delete_booking_with_guard` (00292/00373) DIRECTLY
        //      and reproduces BookingCompensationService.deleteBooking's
        //      structured outcome + audit_events emission:
        //        - RPC error / malformed → emit booking.compensation_failed
        //          audit (booking-compensation.service.ts:73-82,99-106)
        //          then return {kind:'compensation_failed'}.
        //        - {kind:'rolled_back'} → no audit (clean rollback;
        //          booking-compensation.service.ts:108-112).
        //        - {kind:'partial_failure'} → emit
        //          booking.compensation_partial_failure audit
        //          (booking-compensation.service.ts:114-125).
        //   3. map the outcome to the SAME throw the boundary raised
        //      (booking-transaction-boundary.ts:91-148) so the existing
        //      catch below behaves byte-identically:
        //        - compensate threw / compensation_failed → throw
        //          AppErrors.server('booking.compensation_failed',
        //          {cause:originalErr}) (boundary.ts:106-116).
        //        - rolled_back → re-throw the ORIGINAL clone error
        //          (boundary.ts:118-128) — preserves the existing
        //          "original 23P01 → conflict skip + advance" path.
        //        - partial_failure → throw
        //          AppErrors.server('booking.partial_failure',
        //          {cause:originalErr}) (boundary.ts:130-147).
        //
        // The catch below is UNCHANGED — every reproduced throw lands on
        // the same branch it did with the boundary (AppError has no
        // `.response`, so booking.compensation_failed / .partial_failure
        // fall to the catch-all `sawUnexpectedFailure=true` →
        // materialized_through is NOT advanced; an original 23P01 on the
        // rolled_back path matches `conflict.isExclusionViolation` →
        // skip + advance, exactly as before).
        if (this.orders && this.supabase) {
          const cloneArgs = {
            masterReservationId: master.id,             // = master booking id
            masterStartAt: master.start_at,
            // Occurrence's booking id — clones land on the NEW booking.
            bundleId: created_row.id,
            seriesId,
            newReservation: {
              id: created_row.id,                       // also booking id
              start_at: created_row.start_at,
              end_at: created_row.end_at,
            },
            requesterPersonId: master.requester_person_id,
          };
          try {
            await this.cloneBundleOrdersToOccurrence(cloneArgs);
          } catch (cloneErr) {
            // Reproduces InProcessBookingTransactionBoundary.
            // runWithCompensation (booking-transaction-boundary.ts:82-148).
            const outcome = await this.deleteOrphanOccurrence(
              created_row.id,
              tenantId,
            );
            if (outcome.kind === 'compensation_failed') {
              // boundary.ts:106-116 — compensate() blew up. Server-class.
              this.log.error(
                `compensation RPC failed for booking ${created_row.id}: ${
                  (cloneErr as Error).message
                }`,
              );
              throw AppErrors.server('booking.compensation_failed', {
                cause: cloneErr,
              });
            }
            if (outcome.kind === 'rolled_back') {
              // boundary.ts:118-128 — booking + cascades gone; re-throw
              // the ORIGINAL clone error so the existing catch keys on it
              // (e.g. an original 23P01 → conflict skip + advance).
              this.log.warn(
                `booking ${created_row.id} rolled back after clone failed: ${
                  (cloneErr as Error).message
                }`,
              );
              throw cloneErr;
            }
            // boundary.ts:130-147 — partial_failure: booking still alive
            // (recurrence_series blocker). Server-class; ops must clear
            // the blocker. The audit_events row was already emitted by
            // deleteOrphanOccurrence.
            this.log.warn(
              `booking ${created_row.id} partial_failure on compensation: ` +
                `blocked_by=${outcome.blockedBy.join(',')}; original error: ${
                  (cloneErr as Error).message
                }`,
            );
            throw AppErrors.server('booking.partial_failure', {
              cause: cloneErr,
            });
          }
        }
        // /full-review v3 closure I4 — push only AFTER the clone (and any
        // compensation rollback) committed. On the rollback path the
        // booking was deleted by deleteOrphanOccurrence; pushing here
        // would lie about the surviving set. Order: create → clone →
        // (compensate on failure) → push to `created`.
        created.push(created_row.id);
      } catch (err) {
        // /full-review v3 closure I4 — categorise the failure.
        //
        // EXPECTED: 23P01 (GiST exclusion / conflict guard) → the slot
        // is permanently taken for this anchor; skipping AND advancing
        // materialized_through is correct (re-attempts won't unblock).
        if (this.conflict && this.conflict.isExclusionViolation(err)) {
          skipped += 1;
          continue;
        }
        // rule_deny / reservation_slot_conflict → rule outcome at
        // create-time, user-correctable.
        //
        // audit-03 slice1 (D-9): every value thrown into this catch is an
        // `AppError` (booking.compensation_failed / .partial_failure via
        // AppErrors.server at :601/:626; rule_deny via AppErrors.forbidden
        // in booking-flow.service.ts:182/:842; reservation_slot_conflict
        // via AppErrors.conflict booking-flow.service.ts:311). `AppError`
        // has `.code: KnownErrorCode` and NO `.response` — the old
        // `e.response?.code` was ALWAYS undefined, so every dedicated
        // triage branch below was DEAD and control always fell to the
        // catch-all (which sets sawUnexpectedFailure=true → no advance).
        // Read `code` off the real AppError so the dedicated triage log
        // lines fire; keep the `message` fallback (used in the logs).
        //
        // D-9 is observability-ONLY. The catch-all set
        // sawUnexpectedFailure=true for EVERY thrown AppError (rule_deny
        // included) → the gate at :725 (`!sawUnexpectedFailure`) did NOT
        // advance materialized_through. To keep the net series-state
        // effect byte-identical to pre-fix, this now-live branch ALSO
        // sets sawUnexpectedFailure=true (preserving no-advance). The
        // ONLY behavioural delta D-9 introduces is that a dedicated
        // rule-deny triage log fires instead of the generic catch-all
        // log. Whether rule_deny SHOULD skip-and-advance (the comment
        // formerly claimed "Skip + advance" but the dead branch never
        // did) is a real but separate pre-existing finding — tracked as
        // D-10, deferred to a future booking-audit recurrence slice with
        // its own smoke. NOT changed here.
        const e = err as { message?: string };
        const code: string | undefined = isAppError(err)
          ? (err as AppError).code
          : undefined;
        if (code === 'rule_deny' || code === 'reservation_slot_conflict') {
          this.log.warn(
            `materialize ${seriesId}: occurrence ${occ.index} create-time rule outcome ${code} (user-correctable; not advancing — see D-10): ${e.message}`,
          );
          // D-9: preserve pre-fix no-advance (catch-all parity). Do NOT
          // remove this without shipping D-10 + its dedicated smoke.
          sawUnexpectedFailure = true;
          skipped += 1;
          continue;
        }
        // UNEXPECTED: clone failures reach this catch via the boundary's
        // re-throw. Two sub-cases:
        //   - booking.partial_failure: the orphan booking persists
        //     because compensation was blocked (recurrence_series, etc).
        //     Retry next tick after manual recovery.
        //   - booking.compensation_failed: the compensation RPC itself
        //     blew up; booking exists in unknown post-attach state.
        //     Retry next tick.
        // Both are persistent "don't advance" signals — when we drop
        // out of the loop we will NOT bump materialized_through past
        // these occurrences, so the next materialize() call (cron or
        // ad-hoc) will reattempt the same indices.
        if (code === 'booking.partial_failure') {
          this.log.error(
            `materialize ${seriesId}: occurrence ${occ.index} clone failed AND compensation blocked — manual recovery required: ${e.message}`,
          );
          sawUnexpectedFailure = true;
          skipped += 1;
          continue;
        }
        if (code === 'booking.compensation_failed') {
          this.log.error(
            `materialize ${seriesId}: occurrence ${occ.index} compensation RPC failed — booking may persist in unknown state: ${e.message}`,
          );
          sawUnexpectedFailure = true;
          skipped += 1;
          continue;
        }
        // UNEXPECTED: everything else. We don't know if the row committed
        // or not (DB flake, network blip during the post-create read,
        // rule-engine OOM, etc.). Conservative default: don't advance.
        // Retry next tick.
        this.log.warn(
          `materialize ${seriesId}: occurrence ${occ.index} unexpected (will retry): ${e.message}`,
        );
        sawUnexpectedFailure = true;
        skipped += 1;
      }
    }

    // Bump materialized_through if we extended it.
    //
    // /full-review v3 closure I3 — tenant_id filter on the update
    // prevents an accidentally-wide write (defence-in-depth; admin
    // client bypasses RLS so the filter is the only scope).
    //
    // /full-review v3 closure I4 — also gated on sawUnexpectedFailure.
    // If any occurrence in this run failed for an unexpected reason
    // (compensation_failed, partial_failure, unknown error), do NOT
    // advance — the next materialize() call must reattempt those
    // indices once ops clears the blocker.
    const newThrough = effectiveHorizon.toISOString();
    if (newThrough > series.materialized_through && !sawUnexpectedFailure) {
      await this.supabase.admin
        .from('recurrence_series')
        .update({ materialized_through: newThrough })
        .eq('tenant_id', tenantId)
        .eq('id', seriesId);
    }

    return { created, skipped_conflicts: skipped };
  }

  /**
   * Per spec §5.1, sub-project 2 fan-out. For each order on the master
   * reservation's bundle, clone it onto the new occurrence. Lines with
   * `repeats_with_series=false` are skipped by the cloner; asset GiST
   * conflicts surface as `recurrence_skipped=true` per line.
   *
   * /full-review v3 closure I4 — propagate failures.
   *
   * Pre-fix: this method swallowed every per-order clone error
   * ("Best-effort"). The result was that an asset GiST conflict, FK
   * failure, or transient DB error during clone would silently leave
   * the occurrence's booking in a partially-cloned state — orphan
   * services on later orders that didn't get cloned.
   *
   * Post-fix: errors propagate to the caller. The caller in materialize
   * deletes the occurrence's booking on any throw (Slice 7:
   * `deleteOrphanOccurrence` — replaces the retired
   * BookingTransactionBoundary.runWithCompensation). That's the correct
   * trade-off: better to compensate (delete + re-try next tick) than to
   * leave the user with a half-cloned occurrence and no recovery path.
   *
   * The list-orders error (rare, indicates DB outage) also propagates.
   */
  private async cloneBundleOrdersToOccurrence(args: {
    masterReservationId: string;
    masterStartAt: string;
    bundleId: string;
    seriesId: string;
    newReservation: { id: string; start_at: string; end_at: string };
    requesterPersonId: string;
  }): Promise<void> {
    if (!this.supabase || !this.orders) return;
    // Find the master booking's orders. Post-canonicalisation
    // `orders.booking_id` (00278:109) is the canonical column tying an
    // order to its parent booking.
    //
    // /full-review v3 closure I3 — tenant_id filter on the read.
    // materialize() is called inside TenantContext.run(...) by both the
    // cron path and the ad-hoc admin tooling path; if the context is
    // unset (legacy callers), skip the filter rather than throw — the
    // FK chain orders.booking_id → bookings.tenant_id still keeps the
    // query within the booking's tenant.
    const ctxTenantId = TenantContext.currentOrNull()?.id ?? null;
    const ordersQuery = this.supabase.admin
      .from('orders')
      .select('id')
      .eq('booking_id', args.masterReservationId);
    if (ctxTenantId) ordersQuery.eq('tenant_id', ctxTenantId);
    const { data: orders, error } = await ordersQuery;
    if (error) {
      // Throw rather than swallow — caller wraps this in
      // runWithCompensation so the orphan booking gets cleaned up.
      throw AppErrors.server('booking.recurrence_failed', { cause: error });
    }
    for (const o of (orders ?? []) as Array<{ id: string }>) {
      // Per-order errors propagate. With compensation wrapping at the
      // call site, a single bad order kills the occurrence cleanly
      // (delete + skip) rather than leaving partial state.
      await this.orders.cloneOrderForOccurrence({
        masterOrderId: o.id,
        newReservation: args.newReservation,
        masterReservationStartAt: args.masterStartAt,
        bundleId: args.bundleId,
        recurrenceSeriesId: args.seriesId,
        requesterPersonId: args.requesterPersonId,
      });
    }
  }

  /**
   * Booking-audit Slice 7 (audit 03 P2-1) — direct orphan-occurrence
   * compensation. PORT of `BookingCompensationService.deleteBooking`
   * (booking-compensation.service.ts:58-126) — the legacy class is
   * retired. This is intentionally a focused private method on
   * RecurrenceService (no new injectable, no boundary abstraction), called
   * from materialize()'s clone catch.
   *
   * Calls the `delete_booking_with_guard` RPC (00292:54-56 /
   * 00373:68-70 — signature `(p_booking_id uuid, p_tenant_id uuid)`,
   * returns jsonb `{kind:'rolled_back'}` or `{kind:'partial_failure',
   * blocked_by:[...]}`) DIRECTLY with the SAME arg object
   * BookingCompensationService.deleteBooking passed
   * (booking-compensation.service.ts:61-64:
   * `{ p_booking_id: bookingId, p_tenant_id: tenantId }`).
   *
   * Reproduces the audit_events emission VERBATIM
   * (booking-compensation.service.ts:13-14 event_type constants +
   * :135-161 tryAudit best-effort insert shape):
   *   - RPC error → `booking.compensation_failed`, details
   *     `{ rpc_error: <msg> }` (booking-compensation.service.ts:73-75).
   *   - malformed payload → `booking.compensation_failed`, details
   *     `{ rpc_error:'malformed_payload', rpc_data:<data> }`
   *     (booking-compensation.service.ts:99-102).
   *   - rolled_back → NO audit (clean rollback;
   *     booking-compensation.service.ts:108-112).
   *   - partial_failure → `booking.compensation_partial_failure`, details
   *     `{ blocked_by:[...] }` (booking-compensation.service.ts:118-120).
   * Every audit row carries `tenant_id`, `entity_type:'booking'`,
   * `entity_id:<bookingId>` exactly as
   * booking-compensation.service.ts:142-148.
   *
   * Returns the structured outcome the materialize() clone-catch maps to
   * the boundary's throws (boundary.ts:91-148): `compensation_failed`
   * (RPC error / malformed — the boundary's `compensate threw` path) ·
   * `rolled_back` · `partial_failure`. Tenant is passed explicitly (the
   * admin client bypasses RLS; the RPC is tenant-scoped on p_tenant_id —
   * same convention as the ported method,
   * booking-compensation.service.ts:53-56).
   */
  private async deleteOrphanOccurrence(
    bookingId: string,
    tenantId: string,
  ): Promise<
    | { kind: 'rolled_back' }
    | { kind: 'partial_failure'; blockedBy: string[] }
    | { kind: 'compensation_failed' }
  > {
    if (!this.supabase) return { kind: 'compensation_failed' };

    const { data, error } = await this.supabase.admin.rpc(
      'delete_booking_with_guard',
      { p_booking_id: bookingId, p_tenant_id: tenantId },
    );

    if (error) {
      // booking-compensation.service.ts:66-83 — emit audit BEFORE the
      // server-class failure so ops have a discoverable orphan signal.
      this.log.error(
        `delete_booking_with_guard RPC failed for booking ${bookingId}: ${error.message}`,
      );
      await this.tryAudit(
        tenantId,
        bookingId,
        AUDIT_COMPENSATION_FAILED,
        { rpc_error: error.message },
      );
      return { kind: 'compensation_failed' };
    }

    // booking-compensation.service.ts:86-106 — supabase-js surfaces a
    // `returns jsonb` function as a parsed object.
    const parsed = data as
      | { kind: 'rolled_back' }
      | { kind: 'partial_failure'; blocked_by: string[] }
      | null;

    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
      this.log.error(
        `delete_booking_with_guard returned malformed payload for booking ${bookingId}: ${JSON.stringify(
          data,
        )}`,
      );
      await this.tryAudit(tenantId, bookingId, AUDIT_COMPENSATION_FAILED, {
        rpc_error: 'malformed_payload',
        rpc_data: data,
      });
      return { kind: 'compensation_failed' };
    }

    if (parsed.kind === 'rolled_back') {
      // booking-compensation.service.ts:108-112 — clean rollback, no audit.
      return { kind: 'rolled_back' };
    }

    // booking-compensation.service.ts:114-125 — partial_failure: emit the
    // discoverable audit row, then return the blockers.
    const blockedBy = Array.isArray(parsed.blocked_by)
      ? parsed.blocked_by
      : [];
    await this.tryAudit(tenantId, bookingId, AUDIT_COMPENSATION_PARTIAL, {
      blocked_by: blockedBy,
    });
    return { kind: 'partial_failure', blockedBy };
  }

  /**
   * Best-effort audit emit — PORT of
   * BookingCompensationService.tryAudit (booking-compensation.service.ts:
   * 135-161). A failed audit insert must NOT mask the underlying
   * compensation problem: log and proceed.
   */
  private async tryAudit(
    tenantId: string,
    bookingId: string,
    eventType: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.supabase) return;
    try {
      const { error } = await this.supabase.admin
        .from('audit_events')
        .insert({
          tenant_id: tenantId,
          event_type: eventType,
          entity_type: 'booking',
          entity_id: bookingId,
          details,
        });
      if (error) {
        this.log.error(
          `audit_events insert failed for ${eventType} on booking ${bookingId}: ${error.message}`,
        );
      }
    } catch (err) {
      this.log.error(
        `audit_events insert threw for ${eventType} on booking ${bookingId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Nightly rollover. For each series whose materialized_through is within
   * 90 days of now, materialise the next 90 days. Capped per tick.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'recurrenceRollover' })
  async recurrenceRollover(): Promise<void> {
    if (!this.supabase) return;
    const cutoff = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    // Only extend live series. Without `series_end_at` filtering, capped /
    // cancelled series whose materialized_through is older than the cutoff
    // (always, after a 'series' cancel) starve the 50-row budget and waste
    // loop iterations on no-ops. `is null` keeps unbounded series eligible.
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase.admin
      .from('recurrence_series')
      .select('id, tenant_id')
      .lt('materialized_through', cutoff)
      .or(`series_end_at.is.null,series_end_at.gt.${nowIso}`)
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
   * Split a recurrence series at `bookingId` and on. The given occurrence
   * + every subsequent occurrence move to a fresh series id (new
   * recurrence_series row, cloned from the source). Returns the new
   * series id.
   *
   * Booking-audit remediation Slice 4 (audit 03 P1-2): this is now a
   * THIN one-call wrapper over the atomic, idempotent
   * `split_recurrence_series` RPC (migration 00411). The legacy body was
   * the exact non-atomic, non-idempotent choreography the audit flagged
   * as P1-2: (1) INSERT recurrence_series, (2) UPDATE forward bookings,
   * (3) UPDATE source series, plus a swallowed best-effort audit_events
   * insert, with NO actor + NO idempotency. A crash between writes 1 and
   * 2 left an orphan recurrence_series; a retry of the surrounding
   * editScope minted a SECOND orphan series (the brittle TS
   * `skipSplitSeries` pre-check papered over the non-idempotency). All
   * 3 writes + the audit are now ONE PL/pgSQL transaction, gated on
   * command_operations keyed on (bookingId, clientRequestId). A retry
   * of the same editScope re-calls this RPC with the SAME key → the
   * RPC returns the SAME new_series_id, no orphan series — which is
   * what made the TS pre-check obsolete (removed in the same change,
   * see ReservationService.editScope).
   *
   * F-CRIT-1: p_actor_user_id is the JWT subject (auth_uid), NOT
   * users.id — the RPC resolves `where u.auth_uid = p_actor_user_id`
   * (Slice-1 D-1 lesson). p_actor_user_id is `uuid`-typed (00411:97);
   * synthetic `system:*` sentinels (e.g. SYSTEM_ACTOR.auth_uid =
   * 'system:recurrence', recurrence.service.ts:97) are NOT valid uuids
   * and would 500 on the supabase-js/PostgREST uuid bind before reaching
   * the SQL. They are coerced to null by `actorAuthUidForRpc` below; the
   * RPC handles a null actor (00411:135 skips the lookup, audit
   * actor_user_id = null). Real JWT callers (the only production caller
   * is editScope-commit) pass a genuine uuid auth_uid through unchanged.
   */
  async splitSeries(
    bookingId: string,
    actor: ActorContext,
    clientRequestId: string,
  ): Promise<string> {
    if (!this.supabase) {
      throw AppErrors.server('booking.recurrence_not_injected', {
        detail: 'RecurrenceService.splitSeries requires Supabase injection',
      });
    }

    // Tenant scope: the active TenantContext. editScope (the sole
    // production caller) always runs inside a resolved tenant; the
    // recurrence cron sets TenantContext.run per series before any
    // materialise/split (recurrence.service.ts recurrenceRollover).
    const tenantId = TenantContext.current().id;

    const idempotencyKey = buildSplitSeriesIdempotencyKey(
      bookingId,
      clientRequestId,
    );

    const { data: rpcData, error: rpcErr } = await this.supabase.admin.rpc(
      'split_recurrence_series',
      {
        p_booking_id: bookingId,
        p_tenant_id: tenantId,
        // F-CRIT-1: the RPC resolves this via `where u.auth_uid =
        // p_actor_user_id` (00411:140). Must be the JWT subject
        // (auth_uid), NOT users.id, or every split fails with
        // split_recurrence_series.actor_not_found (Slice-1 D-1 lesson).
        // p_actor_user_id is uuid-typed (00411:97); synthetic system:*
        // sentinels are coerced to null (the RPC permits a null actor —
        // 00411:135), NOT passed as a non-uuid string that would 500 on
        // the uuid bind. See RecurrenceService.actorAuthUidForRpc.
        p_actor_user_id: RecurrenceService.actorAuthUidForRpc(actor),
        p_idempotency_key: idempotencyKey,
      },
    );
    if (rpcErr) {
      // Recognised RPC raises (split_recurrence_series.actor_not_found
      // 404, .not_found 404, .not_recurring 422,
      // command_operations.payload_mismatch 409,
      // command_operations.unexpected_state 500) route through
      // mapRpcErrorToAppError exactly like the cancel + edit wrappers
      // (reservation.service.ts:522 / :1059 / :1871). All 3 dotted
      // codes are registered: STATUS_BY_CODE in map-rpc-error.ts + the
      // KnownErrorCode union/registry in packages/shared/src/error-codes.ts
      // + EN/NL messages. booking.recurrence_failed is the booking-scoped
      // 500 fallback for any unrecognised raise (already registered).
      throw mapRpcErrorToAppError(rpcErr, {
        fallbackCode: 'booking.recurrence_failed',
      });
    }

    const result = (rpcData ?? {}) as { new_series_id?: string };
    if (!result.new_series_id) {
      // The RPC always returns { new_series_id, ... } on success (and
      // returns its cached_result verbatim on replay, same shape). A
      // missing field is a contract break, not a client error.
      throw AppErrors.server('booking.recurrence_failed', {
        detail: 'split_recurrence_series returned no new_series_id',
      });
    }
    return result.new_series_id;
  }

  /**
   * Cancel forward — DEPRECATED / RETIRED by booking-audit Slice 2
   * (audit 03 P0-1 / P1-5).
   *
   * The previous body was the exact non-atomic cascade the audit flagged
   * as P0-1: separate bookings/slots/series writes + a swallowed
   * per-occurrence bundleCascade, NO `booking.cancelled` outbox emit
   * (P1-5). `ReservationService.cancelOne` now routes ALL scopes
   * (this | this_and_following | series) through the atomic
   * `cancel_booking_with_cascade` RPC (00408), which resolves + locks
   * the forward/series set, cascades in one transaction, caps the
   * series, and emits `booking.cancelled` per occurrence.
   *
   * This method had ZERO callers after the cancelOne rewrite (verified:
   * the only production caller was reservation.service.ts:459, removed
   * in the same change; no spec references it). Rather than leave a
   * non-atomic cascade dormant for a future caller to silently
   * re-introduce the P0-1/P1-5 bug, the body now hard-fails and points
   * at the atomic path. Keeping the public method (instead of deleting
   * it) preserves the `RecurrenceService` surface for any dynamic/
   * reflective caller while making misuse loud, not silently corrupting.
   */
  async cancelForward(
    bookingId: string,
    scope: Extract<RecurrenceScope, 'this_and_following' | 'series'>,
    _opts: { reason?: string } = {},
  ): Promise<{ cancelled: number }> {
    throw AppErrors.server('booking.recurrence_failed', {
      detail:
        `RecurrenceService.cancelForward is retired (booking-audit Slice 2, ` +
        `P0-1/P1-5). Cancel via ReservationService.cancelOne(bookingId, ` +
        `actor, { scope: '${scope}' }) — it routes through the atomic ` +
        `cancel_booking_with_cascade RPC (migration 00408). ` +
        `(bookingId=${bookingId})`,
    });
  }

  // --- helpers ---

  private async loadHolidayDates(calendarId: string | null): Promise<Set<string>> {
    if (!calendarId || !this.supabase) return new Set();
    // /full-review v3 closure I3 — business_hours_calendars is tenant-
    // owned (00006_business_hours.sql:5). Without a tenant filter, an
    // admin-client lookup by id alone could return another tenant's
    // calendar (FK would be valid, RLS bypassed). With the filter, a
    // mismatched calendarId silently returns no rows → empty holidays
    // set, which is the safe default (no occurrences are skipped).
    const ctxTenantId = TenantContext.currentOrNull()?.id ?? null;
    const calQuery = this.supabase.admin
      .from('business_hours_calendars')
      .select('holidays')
      .eq('id', calendarId);
    if (ctxTenantId) calQuery.eq('tenant_id', ctxTenantId);
    const { data } = await calQuery.maybeSingle();
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
