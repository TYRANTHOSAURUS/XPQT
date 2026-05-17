import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import { ConflictGuardService } from './conflict-guard.service';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { buildSplitSeriesIdempotencyKey } from '@prequest/shared';
import {
  BOOKING_TX_BOUNDARY,
  type BookingTransactionBoundary,
} from './booking-transaction-boundary';
import { BookingCompensationService } from './booking-compensation.service';
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
  // /full-review v3 closure I4 — compensation boundary + service injected so
  // each occurrence's clone-orders step is wrapped in runWithCompensation.
  // If the clone throws, the boundary deletes the orphan occurrence booking
  // (or surfaces partial_failure when a sub-series blocks deletion).
  // Both Optional so tests using `new RecurrenceService()` keep working — the
  // wrapper short-circuits to direct invocation when neither is provided.
  constructor(
    @Optional() private readonly supabase?: SupabaseService,
    @Optional() private readonly conflict?: ConflictGuardService,
    @Optional() private readonly tenants?: TenantService,
    @Optional() @Inject(BOOKING_TX_BOUNDARY)
    private readonly txBoundary?: BookingTransactionBoundary,
    @Optional() private readonly compensation?: BookingCompensationService,
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
            source: 'auto',
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
        // /full-review v3 closure I4 — wrap the clone step in
        // BookingTransactionBoundary.runWithCompensation. Pre-fix:
        // bookingFlow.create(...) ran with services=[] (atomic on its
        // own; the compensation boundary in BookingFlowService gates on
        // input.services.length > 0 and skips when empty). Then the
        // separate cloneBundleOrdersToOccurrence call ran AFTER the
        // booking was committed. If the clone threw, the orphan
        // occurrence booking persisted; the catch block below incremented
        // `skipped += 1` but the room stayed reserved indefinitely.
        //
        // Wrapping the clone in runWithCompensation means: clone throws →
        // boundary calls compensation.deleteBooking(occurrence.id) which
        // invokes the delete_booking_with_guard RPC (00292) → orphan
        // booking + slots are removed. The boundary then re-throws the
        // original error, which our outer catch handles below.
        //
        // Fallback: if either txBoundary or compensation isn't injected
        // (lightweight tests), fall back to direct invocation. Tests
        // covering the wrapped path pass both. The fallback is the
        // pre-fix behaviour and preserves backward compatibility for
        // callers that haven't wired the boundary.
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
          if (this.txBoundary && this.compensation) {
            const comp = this.compensation;
            await this.txBoundary.runWithCompensation(
              created_row.id,
              () => this.cloneBundleOrdersToOccurrence(cloneArgs),
              (id) => comp.deleteBooking(id),
            );
          } else {
            await this.cloneBundleOrdersToOccurrence(cloneArgs);
          }
        }
        // /full-review v3 closure I4 — push only AFTER the clone (and
        // any boundary rollback) committed. On the rollback path the
        // booking was deleted by compensation; pushing here would lie
        // about the surviving set. Order: create → clone (boundary-
        // wrapped) → push to `created`.
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
        // EXPECTED: rule_deny / reservation_slot_conflict → rule outcome
        // at create-time, user-correctable. Skip + advance.
        const e = err as { response?: { code?: string }; message?: string };
        const code = e.response?.code;
        if (code === 'rule_deny' || code === 'reservation_slot_conflict') {
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
   * wraps this in BookingTransactionBoundary.runWithCompensation, which
   * deletes the occurrence's booking on any throw. That's the correct
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
