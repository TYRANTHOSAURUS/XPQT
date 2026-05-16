import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppError, AppErrors } from '../../common/errors';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { buildEditBookingIdempotencyKey } from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertTenantOwned, assertTenantOwnedAll, UUID_RE } from '../../common/tenant-validation';
import { ConflictGuardService } from './conflict-guard.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { RecurrenceService } from './recurrence.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { AssembleEditPlanService } from './assemble-edit-plan.service';
import { BundleCascadeService } from '../booking-bundles/bundle-cascade.service';
import { BundleEventBus } from '../booking-bundles/bundle-event-bus';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from './reservation-projection';
import type { ActorContext, RecurrenceScope, Reservation } from './dto/types';

/**
 * ReservationService — read paths, simple lifecycle, and edit/cancel/restore.
 *
 * Booking-creation pipeline (the orchestrator) lives in BookingFlowService
 * (file booking-flow.service.ts) which integrates with the rule resolver
 * from Phase B. This service handles the simpler, rule-resolver-independent
 * lifecycle methods.
 *
 * Booking-canonicalisation rewrite (2026-05-02): every read of `reservations`
 * is now a read of `booking_slots` joined with `bookings` (00277:27,116).
 * The legacy flat `Reservation` shape is preserved in API responses via
 * `slotWithBookingToReservation` so frontend callers don't change in this
 * slice. The `id` field on returned rows is now the BOOKING id (00278 +
 * Slice A), not the slot id — see BookingFlowService for the breaking-change
 * rationale.
 *
 * What edits/cancels touch:
 *   - status / check-in / cancellation-grace fields → updated on
 *     `booking_slots` (per-slot semantics; multi-room can have one slot
 *     cancelled while others continue per 00277:142-144).
 *   - space_id / start_at / end_at on edit → updated on the SLOT (the actual
 *     resource window). For single-slot v1 bookings we also keep the
 *     booking-level location_id/start_at/end_at in sync so visibility +
 *     "my bookings" lookups stay consistent.
 *   - Audit events for booking-level lifecycle (created, cancelled,
 *     restored) carry `entity_type='booking'` (Slice A); per-slot events
 *     (check-in, auto-release) carry `entity_type='booking_slot'`.
 */
@Injectable()
export class ReservationService {
  private readonly log = new Logger(ReservationService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conflict: ConflictGuardService,
    private readonly visibility: ReservationVisibilityService,
    @Optional() private readonly recurrence?: RecurrenceService,
    @Optional() private readonly notifications?: BookingNotificationsService,
    @Optional() private readonly bundleCascade?: BundleCascadeService,
    @Optional() private readonly bundleEventBus?: BundleEventBus,
    // B.4 step 2D-D — `editSlot` cuts over to `assembleEditPlan` +
    // `edit_booking` RPC. Optional only so legacy unit tests that
    // construct ReservationService without DI can keep compiling; the
    // editSlot path asserts non-null at call time and surfaces a 500
    // if an instance lands in that path without the dependency wired.
    @Optional() private readonly assembleEditPlan?: AssembleEditPlanService,
  ) {}

  // === Reads ===

  async findOne(id: string, authUid: string): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);

    // Denormalize the parent-trail of the booked space so the booking
    // detail "Where" row can render "Building › Floor › Room" without
    // the frontend having to fetch the full tenant tree just to walk
    // parents. Best-effort — a missing path doesn't fail the read, but
    // it IS logged because a silent failure here masks (a) a stale env
    // missing the migration, (b) a permission error from the rpc, or
    // (c) an outage of the function — all of which we want to see.
    try {
      const { data: pathData, error: rpcErr } = await this.supabase.admin
        .rpc('space_path', { p_space_id: r.space_id });
      if (rpcErr) {
        this.log.warn(
          `space_path rpc failed for booking ${r.id} (space_id=${r.space_id}): ${rpcErr.message}`,
        );
        return r;
      }
      const path = Array.isArray(pathData) ? (pathData as string[]) : null;
      return { ...r, space_path: path && path.length > 0 ? path : null };
    } catch (err) {
      this.log.warn(
        `space_path rpc threw for booking ${r.id} (space_id=${r.space_id}): ${(err as Error).message}`,
      );
      return r;
    }
  }

  /**
   * Mutation-path counterpart to `findOne(id, authUid)`. Resolves
   * visibility against an `ActorContext` (which holds `user_id`, the
   * app-side users.id, NOT auth_uid).
   */
  async findOneForActor(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    return r;
  }

  /**
   * Sibling slots in the same booking (multi-room atomic group). Used by
   * the booking detail surface so an operator can navigate to any room in
   * the group without leaving the detail context. Returns []  for
   * single-slot bookings.
   *
   * Post-canonicalisation (2026-05-02): groupings live on `booking_id`
   * (00277:119) instead of the dropped `multi_room_group_id` column. The
   * "siblings" are every other slot keyed to the same booking. Visibility
   * is inherited from the pivot booking — the group is atomic.
   */
  async listGroupSiblings(
    id: string,
    authUid: string,
  ): Promise<{
    items: Array<{ id: string; space_id: string; space_name: string | null; status: string }>;
  }> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const pivot = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(pivot, ctx);

    // Read every slot on this booking; if there's only one, no siblings.
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select('id, space_id, status, space:spaces(name)')
      .eq('tenant_id', tenantId)
      .eq('booking_id', id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw AppErrors.server('group_siblings_failed', { cause: error });

    type Row = { id: string; space_id: string; status: string; space?: { name: string | null } | null };
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length <= 1) return { items: [] };

    return {
      items: rows.map((r) => ({
        id: r.id,                       // slot id (per-slot for the multi-room rail)
        space_id: r.space_id,
        space_name: r.space?.name ?? null,
        status: r.status,
      })),
    };
  }

  /**
   * Internal: load a booking by id and return the legacy `Reservation`
   * projection. Picks the booking's PRIMARY slot (lowest display_order,
   * 00277:154) for slot-level fields. Multi-slot bookings still get a
   * single representative row through this path; per-slot reads use
   * `booking_slots` directly (e.g. listGroupSiblings).
   */
  private async findByIdOrThrow(id: string, tenantId: string): Promise<Reservation> {
    // Try slot-then-booking embed in one round-trip. The PostgREST embed
    // resolves through the booking_slots → bookings FK (00277:119).
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .eq('booking_id', id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) throw AppErrors.notFoundWithCode('booking_not_found', 'Booking not found.');
    return slotWithBookingToReservation(data as unknown as SlotWithBookingEmbed);
  }

  async listMine(authUid: string, opts: {
    scope?: 'upcoming' | 'past' | 'cancelled' | 'all';
    limit?: number;
    cursor?: string;
  }): Promise<{ items: Array<Reservation & { space_name?: string | null }>; next_cursor?: string }> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

    // Upcoming should sort closest-first (ascending start). Past / cancelled
    // read more naturally with most-recent first.
    const ascending = opts.scope === 'upcoming';

    // Read from booking_slots embedding the parent booking — gives us the
    // per-slot start_at + status that matches what the legacy reservations
    // table surfaced. Filter on booking-level requester_person_id by
    // pushing the predicate into the embedded relation.
    let q = this.supabase.admin
      .from('booking_slots')
      .select(`
        ${SLOT_WITH_BOOKING_SELECT},
        space:spaces(id,name,type)
      `)
      .eq('tenant_id', tenantId)
      .order('start_at', { ascending })
      .order('id', { ascending: true })
      .limit(limit + 1);

    if (ctx.person_id) {
      q = q.eq('bookings.requester_person_id', ctx.person_id);
    } else if (ctx.user_id) {
      q = q.eq('bookings.booked_by_user_id', ctx.user_id);
    } else {
      return { items: [] };
    }

    const now = new Date().toISOString();
    if (opts.scope === 'upcoming') {
      q = q.gte('end_at', now).not('status', 'in', '(cancelled,released)');
    } else if (opts.scope === 'past') {
      q = q.lt('end_at', now).not('status', 'in', '(cancelled)');
    } else if (opts.scope === 'cancelled') {
      q = q.in('status', ['cancelled', 'released']);
    }

    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf('__');
      if (sep > 0) {
        const cursorStart = opts.cursor.slice(0, sep);
        // Phase 1.2 — Bug #4: the cursor's id half is the SLOT id, not the
        // booking id. ORDER BY runs on `booking_slots.id` (this query is
        // against `from('booking_slots')`); the projection's `id` is the
        // BOOKING id (= bookings.id) under canonicalisation. Comparing the
        // booking id against the booking_slots.id column is a domain
        // mismatch — multi-room bookings (N slots, all sharing one
        // booking_id but each with a distinct slot id) skipped or
        // duplicated rows across page boundaries. Decoded var is named
        // `cursorSlotId` for parity with `${last.slot_id}` on the encode
        // side below.
        const cursorSlotId = opts.cursor.slice(sep + 2);
        q = ascending
          ? q.or(`start_at.gt.${cursorStart},and(start_at.eq.${cursorStart},id.gt.${cursorSlotId})`)
          : q.or(`start_at.lt.${cursorStart},and(start_at.eq.${cursorStart},id.gt.${cursorSlotId})`);
      }
    }

    const { data, error } = await q;
    // C3: DB-side read failure → server-class (5xx). I4: drop pgErr.message interpolation (logged via filter cause serializer).
    if (error) throw AppErrors.server('list_failed');

    type SlotRow = SlotWithBookingEmbed & {
      space?: { id: string; name: string; type: string } | null;
    };
    const all = ((data ?? []) as unknown as SlotRow[]);
    const rowsToReturn = all.slice(0, limit).map((r) => {
      const projected = slotWithBookingToReservation(r);
      return {
        ...projected,
        space_name: r.space?.name ?? null,
      };
    });
    // Phase 1.2 — Bug #4: encode the cursor's id half from `slot_id`
    // (= booking_slots.id, the ORDER BY column), NOT `id` (= booking.id).
    // See the matching decode comment above for the bug rationale.
    const next_cursor =
      all.length > limit && rowsToReturn.length > 0
        ? `${rowsToReturn[rowsToReturn.length - 1].start_at}__${rowsToReturn[rowsToReturn.length - 1].slot_id}`
        : undefined;
    return { items: rowsToReturn, next_cursor };
  }

  /**
   * Operator/admin list — every booking in the tenant, filterable by
   * scope + status. Used by /desk/bookings (the operator list view).
   * Throws ForbiddenException if the caller has no rooms.read_all/admin.
   *
   * Joins room name + requester name in one round-trip so the desk page
   * doesn't hydrate per-row.
   *
   * Post-rewrite: `has_bundle` historically meant "has at least one
   * service line attached" (the booking_bundle_id was nullable on
   * reservations). Under canonicalisation every booking IS a bundle, so
   * the meaningful question is "does this booking have orders". For now,
   * `has_bundle=true` falls back to "any orders linked via orders.booking_id"
   * — implemented as a join filter rather than the dropped column.
   */
  async listForOperator(authUid: string, opts: {
    scope?: 'upcoming' | 'past' | 'cancelled' | 'all' | 'pending_approval';
    status?: string[];
    limit?: number;
    has_bundle?: boolean;
  }): Promise<{ items: Array<Reservation & {
    space_name?: string | null;
    requester_first_name?: string | null;
    requester_last_name?: string | null;
  }>; }> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    this.visibility.assertOperatorOrAdmin(ctx);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    let q = this.supabase.admin
      .from('booking_slots')
      .select(`
        ${SLOT_WITH_BOOKING_SELECT},
        space:spaces(id,name,type),
        requester:bookings!inner(requester:persons!requester_person_id(id,first_name,last_name))
      `)
      .eq('tenant_id', tenantId)
      .order('start_at', { ascending: false })
      .limit(limit);

    const now = new Date().toISOString();
    if (opts.scope === 'upcoming') {
      q = q.gte('end_at', now).not('status', 'in', '(cancelled,released)');
    } else if (opts.scope === 'past') {
      q = q.lt('end_at', now);
    } else if (opts.scope === 'cancelled') {
      q = q.in('status', ['cancelled', 'released']);
    } else if (opts.scope === 'pending_approval') {
      q = q.eq('status', 'pending_approval');
    }
    if (opts.status?.length) q = q.in('status', opts.status);
    // has_bundle: filter to bookings that have at least one row in `orders`
    // pointing back via orders.booking_id (00278:109). Pre-rewrite this was
    // a `booking_bundle_id IS NOT NULL` check on reservations; under
    // canonicalisation the bundle IS the booking, so "has services" is the
    // right question.
    //
    // B.3.3 / 00298 — codex round-3 flagged the previous `.from('orders')
    // .select('booking_id') ...` shape as an N+1 antipattern. It pulled
    // EVERY orders row for the tenant (one row per order, not per
    // booking), then deduped client-side, then sent the deduped id list
    // back through .in('booking_id', ids) — which past ~1k ids hits
    // CDN/edge URL-length limits and either truncates or 414s.
    //
    // Fix: bookings_with_orders_for_tenant returns the deduped booking_id
    // set in one round-trip (DISTINCT subquery, partial-index scan via
    // idx_orders_booking from 00278:120-122). The TS layer just receives
    // the bounded set and feeds it to the existing .in() filter — no
    // dedup pass, no over-fetch.
    if (opts.has_bundle) {
      const { data: rpcData, error: ordersErr } = await this.supabase.admin
        .rpc('bookings_with_orders_for_tenant', { p_tenant_id: tenantId });
      // C3+I4: DB-side RPC failure → server-class, no pgErr.message interpolation.
      if (ordersErr) throw AppErrors.server('list_for_operator_orders');
      const ids = ((rpcData ?? []) as Array<string | { bookings_with_orders_for_tenant: string }>)
        .map((row) => (typeof row === 'string' ? row : row?.bookings_with_orders_for_tenant))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) {
        return { items: [] };
      }
      q = q.in('booking_id', ids);
    }

    const { data, error } = await q;
    if (error) throw AppErrors.server('list_for_operator_failed', { cause: error });

    type SlotRow = SlotWithBookingEmbed & {
      space?: { id: string; name: string; type: string } | null;
      requester?: { requester?: { id: string; first_name: string | null; last_name: string | null } | null } | null;
    };
    const items = ((data ?? []) as unknown as SlotRow[]).map((r) => {
      const projected = slotWithBookingToReservation(r);
      const requesterPerson = r.requester?.requester ?? null;
      return {
        ...projected,
        space_name: r.space?.name ?? null,
        requester_first_name: requesterPerson?.first_name ?? null,
        requester_last_name: requesterPerson?.last_name ?? null,
      };
    });
    return { items };
  }

  /**
   * Desk-scheduler window read. Returns every booking on `spaceIds` whose
   * effective_*_at range overlaps [start_at, end_at). Operator-or-admin
   * only — caller verifies via `assertOperatorOrAdmin`.
   *
   * Cancelled / released / completed rows are excluded; the grid only renders
   * blocks for active or pending bookings. (Released slots free the cell.)
   *
   * Returns rows in a single query (no N+1) so the page can paint 50 rooms ×
   * 7 days inside the §5.6 < 1.2 s perceived budget.
   */
  async listForWindow(
    authUid: string,
    args: { space_ids: string[]; start_at: string; end_at: string },
  ): Promise<{ items: Reservation[] }> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    this.visibility.assertOperatorOrAdmin(ctx);

    const spaceIds = (args.space_ids ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    if (spaceIds.length === 0) return { items: [] };
    const cappedSpaceIds = spaceIds.slice(0, 200);

    if (!args.start_at || !args.end_at) {
      throw AppErrors.validationFailed('scheduler_window_requires_range', { detail: 'scheduler_window requires a date range.' });
    }

    // Range overlap on slot-level effective_*_at (trigger-maintained per
    // 00277:194-201).
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .in('space_id', cappedSpaceIds)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', args.end_at)
      .gt('effective_end_at', args.start_at)
      .order('start_at', { ascending: true })
      .limit(2000);

    if (error) throw AppErrors.server('scheduler_window_failed', { cause: error });
    const items = ((data ?? []) as unknown as SlotWithBookingEmbed[]).map(slotWithBookingToReservation);
    return { items };
  }

  // === Lifecycle ===

  /**
   * Soft cancel. status='cancelled'. Sets cancellation_grace_until so a
   * follow-up restore can revert within the grace window.
   *
   * Post-canonicalisation: per-slot status (00277:142-144) is the
   * authoritative cancel signal. We update the booking's slots; the
   * booking-level status mirror is left in sync with the primary slot's
   * state for v1 single-slot bookings — multi-slot booking-level rollup
   * is a separate concern (a future view will compute it).
   */
  async cancelOne(id: string, actor: ActorContext, opts: {
    reason?: string;
    grace_minutes?: number;
    scope?: RecurrenceScope;
  }): Promise<Reservation | { scope: RecurrenceScope; cancelled: number; pivot: Reservation }> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    if (!this.visibility.canEdit(r, ctx)) throw AppErrors.forbidden('booking_not_editable', 'You cannot edit this booking.');
    if (r.status === 'cancelled') return r;
    if (r.status === 'completed') throw AppErrors.validationFailed('booking_completed', { detail: 'Booking is completed.' });

    // Recurrence-scoped cancel: fan-out cancel for this and following / series.
    if (opts.scope && opts.scope !== 'this') {
      if (!this.recurrence) {
        throw AppErrors.validationFailed('recurrence_unavailable', { detail: 'Recurrence service not configured.' });
      }
      if (!r.recurrence_series_id) {
        throw AppErrors.validationFailed('not_a_recurring_occurrence', { detail: 'Booking is not a recurring occurrence.' });
      }
      const result = await this.recurrence.cancelForward(id, opts.scope, { reason: opts.reason });
      if (this.notifications) void this.notifications.onCancelled(r, opts.reason);
      try {
        await this.supabase.admin.from('audit_events').insert({
          tenant_id: tenantId,
          event_type: 'booking.cancelled',
          entity_type: 'booking',
          entity_id: id,
          details: {
            booking_id: id, scope: opts.scope, cancelled_count: result.cancelled,
            reason: opts.reason ?? null,
          },
        });
      } catch { /* best-effort */ }
      return { scope: opts.scope, cancelled: result.cancelled, pivot: r };
    }

    const grace = opts.grace_minutes ?? 5;
    const cancellationGraceUntil = new Date(Date.now() + grace * 60 * 1000).toISOString();

    // Update every slot on this booking. For single-slot v1 there's just
    // one row; for multi-slot bookings we cancel the whole atomic group
    // (legacy behaviour preserved). Per-slot cancel within a multi-slot
    // booking is a future endpoint (separate slice).
    const { error: slotsErr } = await this.supabase.admin
      .from('booking_slots')
      .update({ status: 'cancelled', cancellation_grace_until: cancellationGraceUntil })
      .eq('tenant_id', tenantId)
      .eq('booking_id', id);
    // C3+I4: DB-side write failure → server-class, no pgErr.message interpolation.
    if (slotsErr) throw AppErrors.server('cancel_failed');

    // Mirror to booking-level status so /desk/bookings sees the cancel
    // immediately. Best-effort — the source-of-truth for cell rendering
    // is the slot status, but the booking-level status is what listMine /
    // listForOperator filter on today.
    await this.supabase.admin
      .from('bookings')
      .update({ status: 'cancelled' })
      .eq('tenant_id', tenantId)
      .eq('id', id);

    const updated = await this.findByIdOrThrow(id, tenantId);
    if (this.notifications) void this.notifications.onCancelled(updated, opts.reason);
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking.cancelled',
        entity_type: 'booking',
        entity_id: id,
        details: { booking_id: id, scope: 'this', reason: opts.reason ?? null },
      });
    } catch { /* best-effort */ }

    // Sub-project 2 cascade: cancel orders linked to this booking. The
    // helper now resolves orders via orders.booking_id (00278:109);
    // best-effort — a failure here doesn't undo the booking cancel.
    if (this.bundleCascade) {
      await this.bundleCascade.cancelOrdersForReservation({
        reservation_id: updated.id,                   // = booking id under canonicalisation
        reason: opts.reason ?? 'booking_cancelled',
      });
    }

    return updated;
  }

  /**
   * Restore a cancelled booking if still within cancellation_grace_until.
   * Re-runs conflict guard (someone else may have booked the slot).
   */
  async restore(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    if (!this.visibility.canEdit(r, ctx)) throw AppErrors.forbidden('booking_not_editable', 'You cannot edit this booking.');

    if (r.status !== 'cancelled') throw AppErrors.validationFailed('booking_not_cancelled', { detail: 'Booking is not cancelled.' });
    if (!r.cancellation_grace_until || new Date(r.cancellation_grace_until) < new Date()) {
      throw AppErrors.validationFailed('cancellation_grace_expired', { detail: 'Cancellation grace window has expired.' });
    }

    // Re-check conflict on the slot's effective window; need the slot id
    // to exclude.
    const { data: slotRow } = await this.supabase.admin
      .from('booking_slots')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('booking_id', id)
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();
    const slotIdToExclude = (slotRow as { id: string } | null)?.id ?? null;

    const conflicts = await this.conflict.preCheck({
      tenant_id: tenantId,
      space_id: r.space_id,
      effective_start_at: r.effective_start_at,
      effective_end_at: r.effective_end_at,
      exclude_ids: slotIdToExclude ? [slotIdToExclude] : [],
    });
    if (conflicts.length > 0) {
      throw AppErrors.validationFailed('booking_slot_taken', { detail: 'The slot is already taken.' });
    }

    // Re-confirm both layers.
    const { error: slotsErr } = await this.supabase.admin
      .from('booking_slots')
      .update({ status: 'confirmed', cancellation_grace_until: null })
      .eq('tenant_id', tenantId)
      .eq('booking_id', id);
    // C3+I4: DB-side write failure → server-class, no pgErr.message interpolation.
    if (slotsErr) throw AppErrors.server('restore_failed');

    await this.supabase.admin
      .from('bookings')
      .update({ status: 'confirmed' })
      .eq('tenant_id', tenantId)
      .eq('id', id);

    const updated = await this.findByIdOrThrow(id, tenantId);

    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking.restored',
        entity_type: 'booking',
        entity_id: id,
        details: { restored_by: actor.user_id },
      });
    } catch { /* best-effort */ }
    return updated;
  }

  /**
   * Skip a single occurrence (mark recurrence_skipped + cancelled).
   *
   * Post-canonicalisation: `recurrence_skipped` lives on `bookings`
   * (00277:77), so we toggle it there and cancel the slot(s).
   */
  async skipOccurrence(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const r = await this.findOneForActor(id, actor);
    if (!r.recurrence_series_id) {
      throw AppErrors.validationFailed('not_a_recurring_occurrence', { detail: 'Booking is not a recurring occurrence.' });
    }

    const { error: bookingErr } = await this.supabase.admin
      .from('bookings')
      .update({ status: 'cancelled', recurrence_skipped: true })
      .eq('tenant_id', tenantId)
      .eq('id', id);
    // C3+I4: DB-side write failure → server-class, no pgErr.message interpolation.
    if (bookingErr) throw AppErrors.server('skip_failed');

    const { error: slotsErr } = await this.supabase.admin
      .from('booking_slots')
      .update({ status: 'cancelled' })
      .eq('tenant_id', tenantId)
      .eq('booking_id', id);
    // C3+I4: DB-side write failure → server-class, no pgErr.message interpolation.
    if (slotsErr) throw AppErrors.server('skip_failed');

    return this.findByIdOrThrow(id, tenantId);
  }

  /**
   * Edit a single occurrence. Sets recurrence_overridden=true if part of a series.
   * Re-runs conflict guard if time/space changed.
   *
   * Post-canonicalisation: time/space changes update the SLOT (the actual
   * resource window). For single-slot bookings we also keep the
   * booking-level location_id/start_at/end_at in sync so visibility +
   * "my bookings" reads stay consistent (00277:41/44/45).
   *
   * Multi-slot bookings: edits via this single-occurrence path are scoped
   * to the booking's PRIMARY slot only (lowest display_order). Editing
   * non-primary slots goes through a future per-slot endpoint.
   */
  async editOne(
    id: string,
    actor: ActorContext,
    patch: {
      space_id?: string;
      start_at?: string;
      end_at?: string;
      attendee_count?: number;
      attendee_person_ids?: string[];
      // Self-review I-1 (2026-05-12): widened from `string` to
      // `string | null` so the public API can clear the booking-level
      // host. The assembler distinguishes `undefined` (preserve) from
      // `null` (clear) at assemble-edit-plan.service.ts:473-475 — but
      // the previous narrower type forced frontend callers to cast
      // around it. The RPC's `nullif(...,'')::uuid` at 00364:765 turns
      // an explicit null into SQL NULL, the "clear" semantics. UpdateReservationDto
      // at dto/dtos.ts:59 mirrors this widening.
      host_person_id?: string | null;
    },
    // B.4 step 2E — editOne is now a producer route. The controller
    // (reservation.controller.ts:291-323 post-cutover) is gated by
    // RequireClientRequestIdGuard, and forwards the validated header
    // value here. Combined with buildEditBookingIdempotencyKey at the
    // RPC call site below, this makes retries collapse on the
    // command_operations cached_result row (00364:330-410). Defense-in-
    // depth UUID validation lives in the editSlot path (reservation
    // .service.ts:1026-1029); editOne validates the same way below.
    clientRequestId: string,
  ): Promise<Reservation> {
    const tenantId = TenantContext.current().id;

    // self-review N-CODE-1 (B.4 step 2E) — defense-in-depth UUID
    // validation. Mirrors editSlot at reservation.service.ts:1026-1029.
    // The RequireClientRequestIdGuard already validates UUID shape at
    // the controller boundary; this catches non-controller callers
    // (workflow engine, future CLI) that build clientRequestId by other
    // means. Surfaces the contract violation as a clean
    // command_operations.unexpected_state instead of letting a malformed
    // key end up in the command_operations.idempotency_key column.
    if (!UUID_RE.test(clientRequestId)) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail: `editOne received malformed clientRequestId (length=${clientRequestId.length}).`,
      });
    }

    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    if (!this.visibility.canEdit(r, ctx)) throw AppErrors.forbidden('booking_not_editable', 'You cannot edit this booking.');

    // /full-review v3 closure I2 — preflight ALL validation before any
    // write. Pre-fix: editOne wrote geometry first (via editSlot RPC),
    // then slot-meta (UPDATE booking_slots), then booking-meta (UPDATE
    // bookings). A combined patch like `{ start_at: VALID, attendee_count: -1 }`
    // would commit the geometry write through the RPC, then fail the
    // slot-meta validation downstream — recreating the partial-write
    // class Phase 1 was eliminating.
    //
    // Preflight runs BEFORE any write, so validation rejections leave
    // every table untouched. The cleaner long-term fix is to move all
    // writes into a single RPC (deferred to Phase 2 — that's a real
    // refactor); for now this preflight closes the validation-failure
    // window, which is the dominant cause of partial writes in this
    // path. The narrow remaining window (RPC succeeds, then a network /
    // RLS / driver error on the meta UPDATEs) survives — it's the same
    // class as any two-write sequence and is documented at the meta-
    // write call sites.
    //
    // Validations enforced here:
    //   - attendee_count >= 0 (sentinel -1 was the codex-cited example;
    //     negative counts have no meaning and the DB CHECK on slots
    //     would reject them anyway, but only at write time).
    //   - attendee_count is an integer (no fractional people).
    //   - attendee_person_ids is an array if provided.
    //   - start_at < end_at when both are in the patch (geometry guard).
    //
    // Cross-table FK validity:
    //   - space_id → editSlot RPC validates inside the same atomic write
    //     (00294 C1 closure). Plan A.2 / Commit 6 adds a TS-layer
    //     pre-flight as defense-in-depth (see below).
    //   - host_person_id → Plan A.2 / gap map §reservation.service.ts:746.
    //     Pre-fix, this was "relies on FK + tenant filter on bookings"
    //     — but the bookings FK on host_person_id → persons(id) only
    //     proves global existence, NOT tenant ownership. supabase.admin
    //     bypasses RLS, so a foreign-tenant person uuid could be
    //     written and would surface as that person's display name +
    //     audit-trail leak. Validated below via assertTenantOwned.
    //   - attendee_person_ids → same gap on the slot-meta path
    //     (§reservation.service.ts:745). Validated below via
    //     assertTenantOwnedAll.
    if (patch.attendee_count !== undefined) {
      if (
        typeof patch.attendee_count !== 'number' ||
        !Number.isInteger(patch.attendee_count) ||
        patch.attendee_count < 0
      ) {
        throw AppErrors.validationFailed('booking.invalid_attendee_count', {
          detail: 'attendee_count must be a non-negative integer.',
        });
      }
    }
    if (patch.attendee_person_ids !== undefined && !Array.isArray(patch.attendee_person_ids)) {
      throw AppErrors.validationFailed('booking.invalid_attendee_person_ids', {
        detail: 'attendee_person_ids must be an array of person ids.',
      });
    }
    // Codex IMPORTANT-2 (2026-05-12): per-side parseability before the
    // pairwise ordering check. Pre-fix, `{ start_at: 'invalid-date' }`
    // (single side) slipped past the gated `start_at && end_at` block,
    // landed in the assembler, and then died in conflict-guard's
    // `new Date(args.start_at).toISOString()` (conflict-guard.service.ts
    // :155-160) with `RangeError: Invalid time value` — a 500 server
    // error instead of a deterministic 400. Validate each side
    // independently first; only run the pairwise check when both are
    // present AND parseable.
    if (patch.start_at !== undefined) {
      const s = new Date(patch.start_at).getTime();
      if (!Number.isFinite(s)) {
        throw AppErrors.validationFailed('booking.invalid_window', {
          detail: 'start_at must be an ISO timestamp.',
        });
      }
    }
    if (patch.end_at !== undefined) {
      const e = new Date(patch.end_at).getTime();
      if (!Number.isFinite(e)) {
        throw AppErrors.validationFailed('booking.invalid_window', {
          detail: 'end_at must be an ISO timestamp.',
        });
      }
    }
    if (patch.start_at !== undefined && patch.end_at !== undefined) {
      const s = new Date(patch.start_at).getTime();
      const e = new Date(patch.end_at).getTime();
      if (s >= e) {
        throw AppErrors.validationFailed('booking.invalid_window', {
          detail: 'start_at must be strictly before end_at.',
        });
      }
    }

    // Codex IMPORTANT-1 (2026-05-12): reject `space_id: null` and
    // `space_id: ''` explicitly. Pre-fix, the legacy pre-cutover editOne
    // used a truthy check (`if (patch.space_id && patch.space_id !==
    // r.space_id)`) so both values were silent no-ops. Post-cutover the
    // no-op predicate is `patch.space_id !== undefined && patch.space_id
    // !== r.space_id`; null and '' BOTH pass that gate (they're
    // !==undefined AND !==r.space_id which is a real uuid), so they
    // reach the assembler and either die in tenant-validation (`''`,
    // tenant-validation.ts:107 UUID_RE.test fails → reference.invalid_uuid)
    // or propagate further (null, since this method's assertTenantOwned
    // guard at :798 explicitly skips null). Either failure mode is
    // unclear to operators. Reject deterministically here with a
    // dedicated code so the UX message can say "pass undefined to
    // preserve the current room."
    if (patch.space_id === null || patch.space_id === '') {
      throw AppErrors.validationFailed('booking.invalid_space_id', {
        detail: 'space_id must be a non-empty uuid; pass undefined to preserve the current room.',
      });
    }

    // Plan A.2 / gap map §reservation.service.ts:745-746 — close the
    // host_person_id + attendee_person_ids cross-tenant smuggling vector
    // BEFORE the meta UPDATEs fire. Both columns FK to persons(id)
    // which is tenant-owned, but the FK doesn't enforce a composite
    // (id, tenant_id) check.
    // Self-review I-1 (2026-05-12): skip the tenant-owned check on
    // explicit `null` (host clear) — there's no person to validate.
    // The RPC's `nullif(...,'')::uuid` at 00364:765 converts JSON null
    // to SQL NULL and stores it directly. Without this guard,
    // assertTenantOwned would .eq('id', null) which is a query bug.
    if (patch.host_person_id !== undefined && patch.host_person_id !== null) {
      await assertTenantOwned(
        this.supabase,
        'persons',
        patch.host_person_id,
        tenantId,
        { entityName: 'host person' },
      );
    }
    if (patch.attendee_person_ids !== undefined && patch.attendee_person_ids.length > 0) {
      await assertTenantOwnedAll(
        this.supabase,
        'persons',
        patch.attendee_person_ids,
        tenantId,
        { entityName: 'attendee persons' },
      );
    }
    // Plan A.2 / Commit 6 / gap map §HIGH reservation-edits without
    // space-id validation. The atomic edit_booking_slot RPC validates
    // (id, tenant_id, active, reservable) inside the same transaction
    // (migration 00294). This TS pre-flight is defense-in-depth:
    //   1. Surfaces a friendlier reference.not_in_tenant 400 BEFORE the
    //      RPC fires — better operator UX than waiting for the P0001
    //      'space.invalid_or_cross_tenant' from inside the RPC.
    //   2. Protects any future code path that might bypass the RPC
    //      (the meta-only legacy path here doesn't hit the RPC at all
    //      when space_id is absent — but if a regression sneaks
    //      space_id back into a non-RPC path, this catches it).
    if (patch.space_id !== undefined && patch.space_id !== null) {
      await assertTenantOwned(
        this.supabase,
        'spaces',
        patch.space_id,
        tenantId,
        {
          activeOnly: true,
          reservableOnly: true,
          entityName: 'space',
        },
      );
    }

    // ── B.4 step 2E: cutover to assembleEditPlan({kind:'one'}) + edit_booking RPC ──
    //
    // Replaces the legacy C2 split:
    //   - geometry → delegate to editSlot (which already ran the RPC)
    //   - slot-meta → direct booking_slots UPDATE
    //   - booking-meta → direct bookings UPDATE
    //   - manual audit_events insert + recurrence_overridden flip
    //
    // Post-cutover everything flows through ONE atomic RPC, mirroring
    // editSlot at reservation.service.ts:1117-1308. Benefits:
    //   - Cross-table atomicity (slot + booking + approvals + audit are
    //     one transaction with FOR UPDATE on the booking row).
    //   - Idempotency on retries via command_operations + (bookingId,
    //     clientRequestId) keying.
    //   - Single audit shape (RPC writes a richer 'booking.edited' row
    //     with full before/after diff — 00364:976-999 — replacing the
    //     legacy slim 'booking.updated' insert at audit_events).
    //   - Approval reconciliation per §3.6.5 happens inside the RPC,
    //     not split across TS code.
    //
    // The TS-side preflights (validation gates above + assertTenantOwned
    // for host_person_id, attendee_person_ids, space_id) STAY — they
    // catch bad payloads BEFORE the DB round-trip and produce friendlier
    // error codes than the RPC's defense-in-depth raises.
    //
    // Citation discipline: mirrors editSlot's full RPC call sequence
    // below — DI guard → assembler call (kind='one') → idempotency-key
    // build → edit_booking RPC → 23P01 GiST mapping → visitor cascade
    // emit. (The B.4.A.5 pre-flight gate that used to sit between the
    // assembler call and the idempotency-key build was lifted in sub-
    // step H once notification dispatch shipped.) Codex NIT-1 (2026-05-12):
    // line-numbered
    // citations were drifting per commit; generalised to symbol/section
    // references so future edits don't silently break the citation
    // contract. Symbols + section names below are stable; line numbers
    // are not.
    //   - assembleEditPlan kind='one' wrapper:  assemble-edit-plan.service.ts
    //                                           (assembleOneEditPlan)
    //   - assembleEditPlan shared core:         assemble-edit-plan.service.ts
    //                                           (buildSingleSlotPlan)
    //   - RPC booking-patch shape:              00364 §3.0 (edit_booking)
    //   - RPC host_person_id apply:             00364 §host_person_id apply
    //   - RPC recurrence_overridden apply:      00364 §recurrence_overridden apply

    if (!this.assembleEditPlan) {
      // Defense-in-depth — DI wiring in the parent module provides the
      // dep, but a malformed test harness could miss it. Surface as 500
      // so the failure is loud, not silent. Mirrors editSlot's DI guard
      // below (same pattern: assembleEditPlan absence → command_operations
      // .unexpected_state).
      throw AppErrors.server('command_operations.unexpected_state', {
        detail: 'editOne: AssembleEditPlanService is not wired into ReservationService.',
      });
    }

    // Early-return no-op preserves the legacy editOne contract at
    // git show f5f01511^:reservation.service.ts:793-826 (pre-cutover):
    // a patch with no actual change was returned as `r` unchanged.
    //
    // Self-review C-1 (2026-05-12): the parity is ASYMMETRIC.
    //
    //   - GEOMETRY (space_id, start_at, end_at): VALUE-compare against
    //     `r`'s current primary-slot projection. `r` was loaded via
    //     findByIdOrThrow above which embeds the PRIMARY slot (display
    //     _order asc, created_at asc — reservation.service.ts:170-184),
    //     so `r.start_at`, `r.end_at`, `r.space_id` are the primary
    //     slot's geometry. Frontend resaves (operator opens the form,
    //     hits Save without changes) send the current values back as
    //     defined keys; a key-only check would treat that as a real
    //     edit, fire the RPC, write an audit row, and (on a series
    //     booking) detach via recurrence_overridden=true.
    //   - META (attendee_count, attendee_person_ids, host_person_id):
    //     KEY-compare (any defined key counts as an edit). Legacy
    //     editOne built slotMetaPatch/bookingMetaPatch on key
    //     definedness alone and short-circuited only when ALL three
    //     buckets were empty — the meta path didn't value-compare.
    //
    // Same predicate lives in the assembler's auto-set block at
    // assemble-edit-plan.service.ts:477-498 for the recurrence_overridden
    // flag — both layers must agree on what "no real edit" means.
    const hasGeometryChange =
      (patch.space_id !== undefined && patch.space_id !== r.space_id) ||
      (patch.start_at !== undefined && patch.start_at !== r.start_at) ||
      (patch.end_at !== undefined && patch.end_at !== r.end_at);
    const hasMetaKey =
      patch.attendee_count !== undefined ||
      patch.attendee_person_ids !== undefined ||
      patch.host_person_id !== undefined;
    if (!hasGeometryChange && !hasMetaKey) {
      return r;
    }

    // Resolve the booking's PRIMARY slot id (lowest display_order, ties
    // by created_at ascending). Self-review NIT-4 (2026-05-12): the
    // earlier citation pointed at assemble-edit-plan.service.ts:393-433
    // which is the approval-assembly block — wrong. The actual primary-
    // slot ordering definition is the read pattern below (used elsewhere
    // by findByIdOrThrow at reservation.service.ts:178-179 and by the
    // RPC's MIN/MAX/mirror logic at 00364), not a single shared helper.
    // Single read, no caching (the C2 lazy resolver is no longer needed —
    // only one path remains through the RPC).
    const { data: primarySlotRow, error: primarySlotErr } = await this.supabase.admin
      .from('booking_slots')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('booking_id', id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (primarySlotErr || !primarySlotRow) {
      throw AppErrors.validationFailed('booking.no_primary_slot', { detail: 'edit_failed:no_primary_slot' });
    }
    const primarySlotId = (primarySlotRow as { id: string }).id;

    // /full-review v3 closure I1 — load TARGET slot's pre-state for the
    // visitor cascade comparison (mirror of editSlot at reservation
    // .service.ts:1085). editOne edits affect the primary slot's
    // geometry (the RPC mirrors location_id / start_at / end_at onto
    // the booking only via single-slot MIN/MAX), so the cascade diffs
    // the PRIMARY slot's pre/post. Without this read the cascade would
    // compare the post-RPC primary slot against `r` (which is also a
    // primary-slot projection, but read pre-validation — slightly stale
    // if anything moved between findByIdOrThrow and the RPC).
    const targetSlotPre = await this.findByIdOrThrowAtSlot(primarySlotId, tenantId);

    const plan = await this.assembleEditPlan.assembleEditPlan({
      bookingId: id,
      tenantId,
      slotId: primarySlotId,
      patch: {
        kind: 'one',
        space_id: patch.space_id,
        start_at: patch.start_at,
        end_at: patch.end_at,
        attendee_count: patch.attendee_count,
        attendee_person_ids: patch.attendee_person_ids,
        host_person_id: patch.host_person_id,
      },
    });

    // B.4.A.5 sub-step H (2026-05-13) lifted the controller-vs-notification
    // gate here: notification dispatch is shipped (atomic inbox INSERT in
    // 00393/00394 + outbox handler + inbox surface + admin overrides), so
    // approval-flipping edits no longer need pre-flight refusal. The error
    // code `booking.edit_requires_notification_dispatch` is intentionally
    // retained in the registry for defense-in-depth — any future regression
    // that re-introduces the gate must reuse it. Sibling lifts: editSlot
    // below + editScope in assemble-edit-plan.service.ts.

    // B.4 Step 2F.3 — op discriminator. The 3rd arg ('one') namespaces
    // the idempotency key so a frontend that buggily reuses a
    // clientRequestId across editOne + editSlot + editScope mints distinct
    // command_operations rows instead of collapsing onto the first call's
    // cached result. See idempotency.ts:333-358 for the key shape; closes
    // the cross-op-collision followup in docs/follow-ups/b4-followups.md.
    const idempotencyKey = buildEditBookingIdempotencyKey(id, clientRequestId, 'one');

    const { error: rpcErr } = await this.supabase.admin.rpc('edit_booking', {
      p_booking_id: id,
      p_plan: plan as unknown as Record<string, unknown>,
      p_tenant_id: tenantId,
      // F-CRIT-1: the RPC resolves this via `where u.auth_uid = p_actor_
      // user_id` (00364:357-371, unchanged in 00394 v5). Must be the JWT
      // subject (auth_uid), NOT users.id, or every edit fails with
      // edit_booking.actor_not_found.
      p_actor_user_id: actor.auth_uid,
      p_idempotency_key: idempotencyKey,
    });
    if (rpcErr) {
      // GiST exclusion (booking_slots_no_overlap, migration 00277) → 409.
      // Mirrors editSlot's exclusion-violation branch — the constraint
      // fires inside the RPC's UPDATE before any RAISE has a chance to
      // translate it.
      if (this.conflict.isExclusionViolation(rpcErr)) {
        throw AppErrors.conflict('booking.slot_conflict', {
          detail: 'Slot conflicts with another booking.',
        });
      }
      // booking.edit_failed is the booking-scoped fallback (registered
      // in packages/shared/src/error-codes.ts; api+web copy in
      // messages.en.ts / messages.nl.ts). Under mapRpcErrorToAppError
      // this routes through AppErrors.server → 500 — same shape as
      // editSlot's slot_update_failed fallback (also a 500 server-class
      // per map-rpc-error.ts). Honest framing: an unrecognised RPC
      // raise is a server bug, not a payload bug.
      throw mapRpcErrorToAppError(rpcErr, { fallbackCode: 'booking.edit_failed' });
    }

    // Project the post-RPC slot via the slot-pinned read so the cascade
    // diff at the bottom of this method compares apples-to-apples (both
    // `targetSlotPre` and `updated` are findByIdOrThrowAtSlot projections
    // of the same primary slot). The returned Reservation has
    // `id = booking_id` per reservation-projection.ts:78 so editOne's
    // callers see the booking-shaped response.
    const updated = await this.findByIdOrThrowAtSlot(primarySlotId, tenantId);
    if (this.notifications) void this.notifications.onCreated(updated);

    // Visitor cascade emit on geometry change. Mirrors editSlot's
    // cascade block (same target-pre/post comparison pattern, same
    // `emitVisitorCascadeForBundle` call shape). editOne edits target
    // the primary slot, so cascading from the primary slot's diff is
    // correct here. The RPC doesn't know about the visitors module;
    // cascade stays a TS responsibility per the existing pattern.
    const movedTime = updated.start_at !== targetSlotPre.start_at;
    const changedRoom = updated.space_id !== targetSlotPre.space_id;
    if ((movedTime || changedRoom) && updated.id && this.bundleEventBus) {
      await this.emitVisitorCascadeForBundle({
        tenantId,
        bundleId: updated.id,
        oldStartAt: movedTime ? targetSlotPre.start_at : null,
        newStartAt: movedTime ? updated.start_at : null,
        oldSpaceId: changedRoom ? targetSlotPre.space_id : null,
        newSpaceId: changedRoom ? updated.space_id : null,
      });
    }

    return updated;
  }

  /**
   * Phase 1.4 — Bug #2: slot-targeted edit path.
   *
   * The desk scheduler PATCHed `/reservations/:id` with `id = booking.id`,
   * which routed to `editOne` and only ever touched the booking's PRIMARY
   * slot (lowest `display_order`). Dragging a non-primary slot of a
   * multi-room booking silently moved the primary instead — the bug this
   * method exists to fix.
   *
   * `editSlot` accepts an explicit slot id (the user-clicked row) plus its
   * declared parent booking id (URL contract), then runs the patch through
   * the `edit_booking_slot` RPC (00291). The RPC updates ONE slot AND
   * recomputes the parent booking's `start_at = MIN(slots)`, `end_at =
   * MAX(slots)`, plus mirrors `bookings.location_id = patch.space_id` only
   * when the edited slot is the booking's PRIMARY (lowest display_order,
   * ties by created_at ascending — NOT just `display_order = 0`).
   *
   * URL contract honesty (codex 2026-05-04): we assert
   * `slot.booking_id === bookingId` here at the SERVICE layer rather than
   * at the controller, so the controller stays a thin wrapper and a
   * single round-trip handles the not-found / url-mismatch / write paths.
   *
   * Errors:
   *   - `booking_slot.not_found` (404) — slot id doesn't exist for this tenant.
   *   - `booking_slot.url_mismatch` (400) — slot exists but its booking_id ≠
   *     `bookingId`. Defends against forged ids and stale frontend state.
   *   - `booking.edit_forbidden` (403) — caller passes visibility but not
   *     `canEdit` (read-only operator).
   *   - `booking.slot_conflict` (409) — GiST exclusion (`23P01`); another
   *     active slot already covers the requested window on the target space.
   *   - `booking.slot_update_failed` (400) — any other RPC failure.
   *
   * `editOne` (`PATCH /reservations/:id`) is the sibling producer
   * route for booking-level edits (host_person_id, attendee_count, and
   * primary-slot geometry). Post B.4 step 2E both routes call the
   * edit_booking RPC directly — there is no cross-method delegation.
   * Frontend callers split by intent:
   *   - `useEditBooking` for booking-level edits
   *   - `useEditBookingSlot` for slot-geometry edits (drag/resize/move)
   */
  async editSlot(
    bookingId: string,
    slotId: string,
    actor: ActorContext,
    clientRequestId: string,
    patch: { space_id?: string; start_at?: string; end_at?: string },
  ): Promise<Reservation> {
    const tenantId = TenantContext.current().id;

    // self-review N-CODE-1 (B.4 step 2D-D) — defense-in-depth UUID
    // validation. RequireClientRequestIdGuard already validates UUID
    // shape at the controller boundary (middleware UUID_RE.test → if
    // false, source=server_default → guard rejects 400). This check
    // catches non-controller callers (editOne delegation, workflow
    // engine, future CLI) that build clientRequestId by other means.
    // Cheap; surfaces the contract violation as a clean
    // command_operations.unexpected_state instead of letting a
    // malformed key end up in the buildEditBookingIdempotencyKey
    // helper / `command_operations.idempotency_key` column.
    if (!UUID_RE.test(clientRequestId)) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail: `editSlot received malformed clientRequestId (length=${clientRequestId.length}).`,
      });
    }

    // Pre-flight: resolve the slot's parent booking_id under tenant scope.
    // Two failure modes here, both must be detected BEFORE we hit the RPC
    // so we don't pollute the audit trail or risk side-effects on a
    // mismatched id:
    //   (a) slot row missing → booking_slot.not_found
    //   (b) slot exists, parent booking_id ≠ URL bookingId → booking_slot.url_mismatch
    const { data: slotRow, error: slotErr } = await this.supabase.admin
      .from('booking_slots')
      .select('booking_id')
      .eq('tenant_id', tenantId)
      .eq('id', slotId)
      .maybeSingle();
    if (slotErr) {
      throw AppErrors.server('booking.slot_update_failed', { cause: slotErr });
    }
    if (!slotRow) {
      throw AppErrors.notFoundWithCode('booking_slot.not_found', 'Slot not found.');
    }
    const slotBookingId = (slotRow as { booking_id: string }).booking_id;
    if (slotBookingId !== bookingId) {
      throw AppErrors.validationFailed('booking_slot.url_mismatch', {
        detail: 'slotId does not belong to bookingId.',
      });
    }

    // Auth: same shape as editOne (reservation.service.ts:613-616).
    // findByIdOrThrow loads the booking via SLOT_WITH_BOOKING_SELECT and
    // throws NotFoundException('booking_not_found') if the parent is gone
    // for this tenant.
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const reservation = await this.findByIdOrThrow(bookingId, tenantId);
    this.visibility.assertVisible(reservation, ctx);
    if (!this.visibility.canEdit(reservation, ctx)) {
      throw AppErrors.forbidden('booking.edit_forbidden', 'You do not have permission to edit this booking.');
    }

    // /full-review v3 closure I1 — load TARGET slot's pre-state for the
    // visitor cascade comparison.
    //
    // Pre-fix: the cascade compared `reservation` (PRIMARY slot
    // projection, loaded above for auth) vs `updated` (TARGET slot
    // projection, loaded after the RPC). For non-primary slot edits,
    // `reservation.start_at` and `reservation.space_id` were the
    // PRIMARY's values, NOT the target's — so the diff fired wrong /
    // missed events (visitors at slot B got reported with slot A's old
    // time/room, or no event at all when slot A happened to match the
    // post-RPC target state by coincidence).
    //
    // Fix: load the target slot's pre-state via findByIdOrThrowAtSlot
    // (the slot-pinned projection variant). Compare target-old vs
    // target-new at line ~990. The booking-level `reservation` stays
    // for auth (ctx + canEdit) — we just don't use its start_at /
    // space_id for the cascade diff anymore.
    const targetSlotPre = await this.findByIdOrThrowAtSlot(slotId, tenantId);

    // Codex IMPORTANT-2 (2026-05-12): per-side parseability + space_id
    // shape validation BEFORE the RPC. Pre-fix editSlot had no
    // timestamp preflight at all — a patch like `{ start_at:
    // 'invalid-date' }` reached the assembler and died inside
    // conflict-guard at `new Date(...).toISOString()`
    // (conflict-guard.service.ts:155-160) with `RangeError: Invalid time
    // value`, surfacing as 500 server-class. Mirrors the editOne
    // preflight above (reservation.service.ts:744-792).
    if (patch.start_at !== undefined) {
      const s = new Date(patch.start_at).getTime();
      if (!Number.isFinite(s)) {
        throw AppErrors.validationFailed('booking.invalid_window', {
          detail: 'start_at must be an ISO timestamp.',
        });
      }
    }
    if (patch.end_at !== undefined) {
      const e = new Date(patch.end_at).getTime();
      if (!Number.isFinite(e)) {
        throw AppErrors.validationFailed('booking.invalid_window', {
          detail: 'end_at must be an ISO timestamp.',
        });
      }
    }
    if (patch.start_at !== undefined && patch.end_at !== undefined) {
      const s = new Date(patch.start_at).getTime();
      const e = new Date(patch.end_at).getTime();
      if (s >= e) {
        throw AppErrors.validationFailed('booking.invalid_window', {
          detail: 'start_at must be strictly before end_at.',
        });
      }
    }
    // Codex IMPORTANT-1 (2026-05-12): symmetric with editOne — reject
    // `space_id: null` and `space_id: ''` deterministically. The
    // assertTenantOwned guard below would either skip (null) or surface
    // an unclear `reference.invalid_uuid` (empty string fails UUID_RE
    // at tenant-validation.ts:107). A dedicated code lets the UX
    // message say "pass undefined to preserve the current room."
    if (patch.space_id === null || patch.space_id === '') {
      throw AppErrors.validationFailed('booking.invalid_space_id', {
        detail: 'space_id must be a non-empty uuid; pass undefined to preserve the current room.',
      });
    }

    // Plan A.4 / Commit 7 (I3) / round-4 codex flag
    // reservation.service.ts:1027-1036. editOne already runs an
    // assertTenantOwned pre-flight on patch.space_id (commit ec055f1,
    // line 741 above). editSlot didn't, even though both routes hit the
    // same edit_booking_slot RPC and the RPC validates internally
    // (migration 00294). Add the symmetric pre-flight here:
    //   1. Surfaces a friendlier reference.not_in_tenant 400 BEFORE the
    //      RPC fires — better operator UX than waiting for the P0001
    //      'space.invalid_or_cross_tenant' from inside the RPC.
    //   2. Protects any future code path that might bypass the RPC.
    //   3. Mirrors editOne so a regression in either route is uniform.
    //   B.4 step 2D-D: still useful even after cutover — the RPC's
    //   validate_entity_in_tenant.space_not_in_tenant raise is caught by
    //   mapRpcErrorToAppError (404), but the TS pre-flight surfaces a
    //   curated error before any DB round-trip and avoids polluting
    //   command_operations with a known-bad attempt.
    if (patch.space_id !== undefined) {
      await assertTenantOwned(
        this.supabase,
        'spaces',
        patch.space_id,
        tenantId,
        {
          activeOnly: true,
          reservableOnly: true,
          entityName: 'space',
        },
      );
    }

    // ── B.4 step 2D-D: cutover to assembleEditPlan + edit_booking RPC ──
    //
    // Replaces the legacy `edit_booking_slot` (00291) RPC call. The new
    // path:
    //   1. AssembleEditPlanService.assembleEditPlan({ kind: 'slot', ... })
    //      builds the EditPlan jsonb the §3.0 RPC consumes (00364:200-308).
    //   2. The B.4.A.5 controller-vs-notification gate refuses any plan
    //      whose approval block would emit `booking.approval_required`
    //      (rows 2/7/8 of §3.6.5). Required because the
    //      BookingApprovalRequiredHandler is a v1 stub today (commit
    //      d285bc32) — committing the chain inserts without delivering
    //      notifications would silently strand approvers. Decision logged
    //      at docs/follow-ups/b4-followups.md "Sequencing — controller
    //      cutover MUST land in or after notification dispatch (B.4.A.5)".
    //      Lift this gate when B.4.A.5 ships dispatch.
    //   3. buildEditBookingIdempotencyKey(bookingId, clientRequestId) —
    //      shared helper at packages/shared/src/idempotency.ts:350. Same
    //      booking + same X-Client-Request-Id ⇒ same key ⇒ retries collapse
    //      on `command_operations` (00364:330-410).
    //   4. supabase.rpc('edit_booking', ...) returns the post-edit booking
    //      jsonb plus follow_ups[] (00364:1106-1129). Errors map via
    //      mapRpcErrorToAppError; GiST exclusion (23P01) is preserved as
    //      the only TS-side special-case (the RPC doesn't translate it).
    //   5. The audit_events 'booking.edited' row + domain_events row are
    //      written INSIDE the RPC (00364:976-999, :1001-1016). The
    //      legacy TS-side 'booking.slot_updated' insert is RETIRED; the
    //      RPC's diff is broader (location_id, start_at, end_at, cost,
    //      policy snapshot, applied rules, host, status) and includes
    //      approval_action / approval_chain_id metadata the slot-only
    //      audit row could never carry.
    //   6. Visitor cascade emit stays HERE (post-RPC, on geometry change).
    //      The RPC doesn't know about the visitors module; cascade is a
    //      TS responsibility per the existing pattern.
    if (!this.assembleEditPlan) {
      // Defense-in-depth — DI wiring in the parent module provides the
      // dep, but a malformed test harness could miss it. Surface as 500
      // so the failure is loud, not silent.
      throw AppErrors.server('command_operations.unexpected_state', {
        detail: 'editSlot: AssembleEditPlanService is not wired into ReservationService.',
      });
    }

    const plan = await this.assembleEditPlan.assembleEditPlan({
      bookingId,
      tenantId,
      slotId,
      patch: {
        kind: 'slot',
        space_id: patch.space_id,
        start_at: patch.start_at,
        end_at: patch.end_at,
      },
    });

    // B.4.A.5 sub-step H (2026-05-13) lifted the controller-vs-notification
    // gate here. Same lift as editOne above — the notification pipeline
    // (RPC inbox INSERT + outbox handler + inbox UI + admin overrides) is
    // shipped, so approval-flipping edits flow through to the RPC. The
    // error code `booking.edit_requires_notification_dispatch` stays
    // registered for defense-in-depth.

    // B.4 Step 2F.3 — op discriminator (see editOne above; same rationale).
    const idempotencyKey = buildEditBookingIdempotencyKey(bookingId, clientRequestId, 'slot');

    const { error: rpcErr } = await this.supabase.admin.rpc('edit_booking', {
      p_booking_id: bookingId,
      p_plan: plan as unknown as Record<string, unknown>,
      p_tenant_id: tenantId,
      // F-CRIT-1: RPC resolves via `where u.auth_uid = p_actor_user_id`
      // (00364:357-371). Must be the JWT subject, not users.id.
      p_actor_user_id: actor.auth_uid,
      p_idempotency_key: idempotencyKey,
    });
    if (rpcErr) {
      // GiST exclusion (booking_slots_no_overlap, 00277:211-217) → 409.
      // The new RPC propagates the raw 23P01 the same way 00291 did —
      // the constraint fires inside the UPDATE before any RPC-level
      // RAISE has a chance to translate it. Preserve the special-case.
      if (this.conflict.isExclusionViolation(rpcErr)) {
        throw AppErrors.conflict('booking.slot_conflict', {
          detail: 'Slot conflicts with another booking.',
        });
      }
      // All other registered RPC error codes (edit_booking.*,
      // validate_entity_in_tenant.*, automation_plan.*,
      // command_operations.payload_mismatch, booking.cancelled_cannot_edit,
      // etc.) are routed via mapRpcErrorToAppError. Unrecognised raises
      // fall back to `booking.slot_update_failed` — under
      // mapRpcErrorToAppError that's a 500 server-class (the helper
      // routes ALL fallbacks through AppErrors.server). Honest framing:
      // an unrecognised raise from a registered RPC is a server bug, not
      // a user payload bug. The legacy 400 framing dates to a TS-side
      // raise that's now retired.
      throw mapRpcErrorToAppError(rpcErr, { fallbackCode: 'booking.slot_update_failed' });
    }

    // Project the post-RPC slot via the same path findOne uses. Reading
    // back the booking embed (rather than trusting the RPC's return jsonb
    // verbatim) keeps the projection logic in ONE place
    // (slotWithBookingToReservation) and means any future column
    // additions land in both paths automatically.
    const updated = await this.findByIdOrThrowAtSlot(slotId, tenantId);

    // /full-review v3 closure I3 — emit visitor cascade on geometry change.
    //
    // Pre-fix: editOne emitted bundle.line.moved / bundle.line.room_changed
    // for visitors linked to the booking, but editSlot — the slot-targeted
    // equivalent — silently skipped it. Operators editing a non-primary
    // slot via this endpoint moved visitors without firing the cascade
    // (no host alert / email / cancel decision).
    //
    // /full-review v3 closure I1 — compare TARGET slot's pre/post, not
    // primary's pre. `targetSlotPre` (loaded above via
    // findByIdOrThrowAtSlot) is the slot-
    // pinned projection of the slot we just edited; `updated` is the
    // post-RPC slot-pinned projection. Both project through
    // findByIdOrThrowAtSlot so .start_at / .space_id on each are the
    // TARGET slot's values — never the primary's. Pre-fix this read
    // `reservation` (booking-level / primary-slot projection), which
    // for non-primary edits made the diff fire wrong/missing events.
    //
    // Decision: editSlot and editOne are sibling producer routes post
    // B.4 step 2E — both call assembleEditPlan + the edit_booking RPC
    // directly, no cross-method delegation. The cascade emission lives
    // in BOTH methods (mirror block in editOne above), each firing
    // exactly once per geometry edit on its own write. Codex NIT-1c
    // (2026-05-12): pre-2E this comment said "editOne now delegates to
    // it" — that framing is stale; both routes are siblings now.
    //
    // The fields that drive the cascade come from the SLOT (per-resource):
    //   - start_at: when the edited slot's start changes, that slot's
    //     visitors need a move event. (For primary edits this also
    //     coincides with bookings.start_at changing — same decision.)
    //   - space_id: when the edited slot's space changes, that slot's
    //     visitors need a room-change event.
    // The slot-pinned projection's `start_at` is `booking_slots.start_at`
    // and `space_id` is `booking_slots.space_id` (see
    // reservation-projection.ts:94 + the SLOT_WITH_BOOKING_SELECT shape).
    const movedTime = updated.start_at !== targetSlotPre.start_at;
    const changedRoom = updated.space_id !== targetSlotPre.space_id;
    if ((movedTime || changedRoom) && reservation.id && this.bundleEventBus) {
      await this.emitVisitorCascadeForBundle({
        tenantId,
        bundleId: reservation.id,
        oldStartAt: movedTime ? targetSlotPre.start_at : null,
        newStartAt: movedTime ? updated.start_at : null,
        oldSpaceId: changedRoom ? targetSlotPre.space_id : null,
        newSpaceId: changedRoom ? updated.space_id : null,
      });
    }

    return updated;
  }

  /**
   * B.4 Step 2F.3 — recurring booking series-scope edit.
   *
   * Cuts over `POST /reservations/:id/edit-scope` from the legacy bare-
   * UPDATE path (`BookingFlowService.editScope` at booking-flow.service
   * .ts:1043, NOW DELETED) to the unified `assembleScopeEditPlan` +
   * `edit_booking_scope` RPC (00371). The RPC is atomic across N
   * occurrences inside one transaction — bug 6 in the spec
   * (`docs/follow-ups/b4-booking-edit-pipeline.md:98`) was that the
   * legacy path had ZERO rule eval / conflict guard / capacity check /
   * approval re-eval / cost recompute. One tenant could shift a 52-week
   * series into a smaller room and break every occurrence's capacity
   * invariant. This cutover closes that.
   *
   * `scope='this_and_following'` semantics differ for commit vs. dry-run:
   *   - commit: call `RecurrenceService.splitSeries(pivot)` first (writes
   *     a new recurrence_series row + UPDATEs forward bookings'
   *     recurrence_series_id). Then `effectiveSeriesId = newSeriesId` and
   *     the scope-rows read sees only forward occurrences by construction.
   *   - dry-run: splitSeries is non-idempotent (a retry mints a new
   *     series). For a preview we keep the current series_id and pass
   *     `forwardOnlyFromStartAt = pivot.start_at` to the assembler so the
   *     scope-rows query filters to the forward subset. Zero side effects.
   *
   * `scope='series'` is symmetric: preview/commit both use the pivot's
   * current `recurrence_series_id`; no split needed.
   *
   * Idempotency: key is built from (bookingId, clientRequestId, 'scope'),
   * NOT from (newSeriesId, clientRequestId). Rationale: splitSeries is
   * non-idempotent on retry (a network failure between splitSeries and
   * the RPC mints a fresh series each time), and the pivot bookingId is
   * stable across retries. Keying on the pivot lets the RPC's
   * `command_operations` cached_result short-circuit a retry to the same
   * response, even if a second splitSeries would otherwise mint a second
   * series. The dry-run + commit paths can share an idempotency key
   * (00371 v2 contract — dry-run does NOT touch command_operations).
   *
   * IDEMPOTENCY MITIGATION (C1 fix, Step 2F.3 self-review remediation,
   * codex-revised 2026-05-12): the retry hazard from splitSeries non-
   * idempotency is mitigated by a `command_operations` cached_result
   * pre-check that sets a `skipSplitSeries` flag — it does NOT short-
   * circuit return. The full assembler + RPC flow still runs; the RPC
   * owns the cached_result return (00371:266-267) AND the payload_hash
   * vs. payload_mismatch check (00371:268-274). The TS pre-check's only
   * job is to prevent `splitSeries` from re-firing on a retry — that
   * function commits side effects OUTSIDE the RPC transaction (new
   * recurrence_series row + UPDATEs forward bookings' series_id) and
   * is non-idempotent.
   *
   * The pre-check is GATED on commit mode (`if (!dryRun)`). Dry-run is
   * a stateless preview per the 00371 v2 contract (00371:247-258) and
   * MUST NOT read or write command_operations — a previous codex
   * remediation (CRITICAL C1) caught a bug where dry-run replayed a
   * prior commit's cached envelope; this revision fixes it. A second
   * codex finding (CRITICAL C2) caught that the old short-circuit
   * bypassed the RPC's payload_hash check, allowing a same-crid /
   * different-body retry to silently return the FIRST attempt's
   * response. Both are resolved by delegating cache-return + mismatch
   * detection to the RPC; the TS layer only suppresses splitSeries.
   *
   * Visitor cascade emission: walks the RPC's `per_occurrence[]` return
   * shape (`00371:1114-1125` — each row carries `space_id_before/after` +
   * `start_at_before/after`) and fans out to `emitVisitorCascadeForBundle`
   * per occurrence whose primary slot moved time OR changed room. Dry-run
   * skips the emit entirely (nothing committed → nothing to cascade).
   *
   * Errors mirror editOne (`reservation.service.ts:1011-1037`):
   *   - `booking.slot_conflict` (409) on GiST exclusion.
   *   - `edit_booking_scope.update_failed` (500) as the RPC fallback —
   *     mapRpcErrorToAppError routes recognised raises to their canonical
   *     codes (see `common/errors/map-rpc-error.ts`).
   *   - `command_operations.payload_mismatch` (409) when a retry with
   *     the same crid carries a different assembled-plans payload —
   *     mapped via `map-rpc-error.ts:180`.
   *   - `wrong_endpoint` (422) when caller sends `scope='this'` here
   *     instead of `PATCH /reservations/:id`.
   *   - `edit_booking_scope.not_recurring` (422) if the pivot booking
   *     has no recurrence_series_id.
   */
  async editScope(
    bookingId: string,
    body: import('./dto/dtos').EditScopeDto,
    actor: ActorContext,
    clientRequestId: string,
  ): Promise<{
    scope: 'this_and_following' | 'series';
    new_series_id?: string;
    dry_run: boolean;
    // RPC return shape — v2 contract at 00371:1131-1148.
    committed?: number;
    would_succeed?: boolean;
    series_id?: string;
    per_occurrence?: Array<{
      booking_id: string;
      // Commit branch (00371:1114-1125).
      slots_updated?: number;
      assets_updated?: number;
      orders_updated?: number;
      wo_updated?: number;
      follow_ups?: string[];
      // Dry-run branch (00371:808-822).
      would_succeed?: boolean;
      approval_action?: string;
      follow_ups_preview?: string[];
      slots_to_update?: number;
      assets_to_update?: number;
      orders_to_update?: number;
      wo_to_update?: number;
      // Shared (both branches).
      space_id_before: string;
      space_id_after: string;
      start_at_before: string;
      start_at_after: string;
    }>;
    aggregated_follow_ups?: string[];
  }> {
    const tenantId = TenantContext.current().id;

    // Defense-in-depth UUID validation (mirrors editOne at
    // reservation.service.ts:677-681; same rationale: catch non-controller
    // callers that build a malformed clientRequestId).
    if (!UUID_RE.test(clientRequestId)) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail: `editScope received malformed clientRequestId (length=${clientRequestId.length}).`,
      });
    }

    // Body shape guard: dry_run must be strictly boolean if present.
    // Pre-fix a string 'true' would coerce to truthy on the `??` later,
    // committing a write when the caller asked for a preview — the
    // exact failure mode the assembler's gate A defends against, lifted
    // up to the service boundary for a cleaner error.
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
      throw AppErrors.validationFailed('edit_booking_scope.invalid_plans', {
        detail: 'dry_run must be a boolean if provided.',
      });
    }
    const dryRun = body.dry_run ?? false;

    // Reject scope='this' (mirrors legacy editScope at booking-flow.service
    // .ts:1062-1064). The single-occurrence edit path is `PATCH /reservations
    // /:id` → editOne.
    if ((body.scope as unknown as string) === 'this') {
      throw AppErrors.validationFailed('wrong_endpoint', {
        detail: "Use the regular edit endpoint (PATCH /reservations/:id) for scope='this'.",
      });
    }

    // Self-review remediation C2-plan-rev (2026-05-12) — reject smuggled
    // start_at / end_at fields. The TS interface `EditScopeDto` deliberately
    // omits these (series time-shift requires recurrence_rule mutation,
    // not slot UPDATE). The patch construction below explicitly picks only
    // space_id / attendee_count / attendee_person_ids / host_person_id, so
    // a non-TS caller smuggling `{ scope: 'series', start_at: '...' }` would
    // have those fields silently dropped — operator's intent (time-shift)
    // lost, no error. Surface the existing `edit_booking_scope.time_shift_
    // not_supported` (422) code at the service boundary so the caller gets
    // an actionable inline error and the assembler's own gate-A defence
    // remains reachable via the typed path.
    if (
      (body as { start_at?: unknown }).start_at !== undefined ||
      (body as { end_at?: unknown }).end_at !== undefined
    ) {
      throw new AppError('edit_booking_scope.time_shift_not_supported', 422, {
        detail: 'Series time-shift requires recurrence_rule edit; not supported on scope edits.',
      });
    }

    // Self-review remediation C2-code-rev (2026-05-12) — allowlist scope
    // values. Pre-fix only `'this'` was rejected explicitly; `'garbage'`,
    // `null`, `undefined`, or any other non-allowlist value fell through
    // to the `else` branch and silently executed as `'series'`. Surface
    // the existing `edit_booking_scope.invalid_plans` (400) code so the
    // caller gets a clear validation error instead of silent re-routing.
    if (body.scope !== 'series' && body.scope !== 'this_and_following') {
      throw AppErrors.validationFailed('edit_booking_scope.invalid_plans', {
        detail: `scope must be 'series' or 'this_and_following' (received ${JSON.stringify(body.scope)}).`,
      });
    }

    // RecurrenceService is required for split-series; surface the DI
    // miswiring as a clean 500 rather than letting the optional access
    // throw later. Mirrors editOne's assembleEditPlan DI guard at
    // reservation.service.ts:893-902.
    if (!this.recurrence) {
      throw AppErrors.server('booking.recurrence_not_injected', {
        detail: 'editScope: RecurrenceService is not wired into ReservationService.',
      });
    }
    if (!this.assembleEditPlan) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail: 'editScope: AssembleEditPlanService is not wired into ReservationService.',
      });
    }

    // Type the RPC return shape per 00371 v2:
    //   - commit (00371:1143-1148):  { committed, series_id, per_occurrence, aggregated_follow_ups }
    //   - dry_run (00371:1131-1140): { dry_run, would_succeed, series_id, per_occurrence, aggregated_follow_ups }
    //   - retry  (00371:266-267):    the RPC reads cached_result and returns
    //                                the FIRST attempt's envelope verbatim
    //                                (so TS sees the same shape).
    type RpcEditBookingScopeResult = {
      committed?: number;
      dry_run?: boolean;
      would_succeed?: boolean;
      series_id: string;
      per_occurrence: Array<{
        booking_id: string;
        space_id_before: string;
        space_id_after: string;
        start_at_before: string;
        start_at_after: string;
        slots_updated?: number;
        assets_updated?: number;
        orders_updated?: number;
        wo_updated?: number;
        follow_ups?: string[];
        would_succeed?: boolean;
        approval_action?: string;
        follow_ups_preview?: string[];
        slots_to_update?: number;
        assets_to_update?: number;
        orders_to_update?: number;
        wo_to_update?: number;
      }>;
      aggregated_follow_ups: string[];
    };

    // Idempotency key — built EARLY (before the optional pre-check + before
    // splitSeries) so the codex C1+C2 fix below can reuse it for the
    // commit-mode pre-check AND we pass the same value to the RPC. Keyed
    // on (pivot bookingId, crid, 'scope') because the pivot id is stable
    // across retries; dry_run is NOT in the key (00371 v2 contract).
    const idempotencyKey = buildEditBookingIdempotencyKey(
      bookingId,
      clientRequestId,
      'scope',
    );

    // Codex C1+C2 remediation (2026-05-12) — pre-check command_operations
    // to detect a successful prior attempt, but ONLY to suppress the
    // non-idempotent splitSeries call. We do NOT short-circuit return.
    //
    // The original (now reverted) implementation read the cached row,
    // returned its `cached_result` verbatim, and skipped the rest of the
    // flow. That had two bugs codex flagged as CRITICAL:
    //
    //   C1 (dry-run replays a commit cache): the pre-check fired on
    //       every call. A dry-run preview made after a successful commit
    //       with the same crid would hit the cached row and return the
    //       commit envelope — violating the 00371 v2 contract that
    //       dry-run is stateless (00371:247-258).
    //
    //   C2 (payload_mismatch bypass): the pre-check returned the cached
    //       envelope WITHOUT comparing the request's assembled-plans
    //       payload_hash to the cached row's payload_hash. A retry that
    //       reused the same crid but carried a DIFFERENT body silently
    //       returned the FIRST attempt's response — the operator believed
    //       their second edit landed, but it never did. The RPC owns the
    //       payload_hash check (00371:268-274 raises
    //       command_operations.payload_mismatch); short-circuiting in TS
    //       bypassed it.
    //
    // The fix: the pre-check is gated on commit mode AND only sets a
    // flag. The full assembler + RPC pipeline runs. On retry the RPC
    // itself returns cached_result (00371:266-267) verbatim, or raises
    // payload_mismatch if the assembled plans differ. The TS layer is
    // responsible only for the side effect the RPC cannot undo:
    // RecurrenceService.splitSeries commits a new recurrence_series row
    // + UPDATEs forward bookings OUTSIDE the RPC transaction. A second
    // splitSeries on retry would mint an orphan series whose id never
    // appears in the cached_result the RPC replays.
    //
    // Schema reference: 00316_command_operations_table.sql — columns are
    // (tenant_id, idempotency_key, payload_hash, outcome, cached_result).
    // outcome is enum('in_progress', 'success'). RLS uses
    // current_tenant_id(); we use supabase.admin to bypass and tenant-
    // scope explicitly.
    let skipSplitSeries = false;
    if (!dryRun) {
      const { data: cachedRow, error: cachedErr } = await this.supabase.admin
        .from('command_operations')
        .select('outcome')
        .eq('tenant_id', tenantId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (cachedErr) {
        // A DB error reading command_operations is itself server-class.
        // Bail before splitSeries fires — we'd otherwise risk a second
        // splitSeries if the cached row exists but the read transiently
        // failed (orphan-series hazard).
        throw AppErrors.server('command_operations.unexpected_state', {
          detail: `editScope retry-detection read failed for tenant=${tenantId}.`,
        });
      }
      if (
        cachedRow !== null &&
        (cachedRow as { outcome: string }).outcome === 'success'
      ) {
        skipSplitSeries = true;
      }
    }

    // Load pivot booking. `findByIdOrThrow` enforces tenant scope +
    // returns the legacy Reservation projection (primary-slot embed).
    const pivot = await this.findByIdOrThrow(bookingId, tenantId);

    // Visibility check — same shape as the legacy controller used
    // (reservation.controller.ts:420-424 pre-cutover).
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    this.visibility.assertVisible(pivot, ctx);
    if (!this.visibility.canEdit(pivot, ctx)) {
      throw AppErrors.forbidden('reservation_not_editable', 'You cannot edit this booking.');
    }

    // Pivot must be part of a recurring series. Same predicate + same
    // 422 shape as the assembler at assemble-edit-plan.service.ts:478;
    // we check here first so split / no-split decisions below are well-
    // defined. Raw AppError(422) — `AppErrors.validationFailed` defaults
    // to 400 which doesn't match the assembler's contract and the spec's
    // 422 routing class.
    if (!pivot.recurrence_series_id) {
      throw new AppError('edit_booking_scope.not_recurring', 422, {
        detail: 'Pivot booking is not part of a recurring series.',
      });
    }

    // Resolve effectiveSeriesId + (dry-run-only) forwardOnlyFromStartAt.
    let effectiveSeriesId: string;
    let newSeriesId: string | undefined;
    let forwardOnlyFromStartAt: string | undefined;
    if (body.scope === 'this_and_following') {
      if (dryRun) {
        // Dry-run preview: do NOT splitSeries (it commits side effects).
        // Filter scope-rows to the forward subset of the CURRENT series.
        effectiveSeriesId = pivot.recurrence_series_id;
        forwardOnlyFromStartAt = pivot.start_at;
      } else if (skipSplitSeries) {
        // Retry path (codex C1+C2 fix): the FIRST attempt's splitSeries
        // already ran and moved the pivot to the new series. The pivot
        // we just loaded therefore sits on the post-split series id —
        // pivot.recurrence_series_id IS the new series id. Using it as
        // both `effectiveSeriesId` AND `newSeriesId` lets the assembler
        // re-derive the same plans the first attempt assembled, and the
        // RPC then returns cached_result (matching payload_hash) or
        // raises payload_mismatch (differing payload). No
        // forwardOnlyFromStartAt: the post-split series only contains
        // forward occurrences by construction (splitSeries put them
        // there), so no extra filter is needed.
        effectiveSeriesId = pivot.recurrence_series_id;
        newSeriesId = pivot.recurrence_series_id;
      } else {
        // Commit, first attempt: split the series at the pivot. Forward
        // occurrences move to a fresh recurrence_series_id; the assembler
        // then sees only forward rows by construction (no filter needed).
        newSeriesId = await this.recurrence.splitSeries(bookingId);
        effectiveSeriesId = newSeriesId;
      }
    } else {
      // scope='series' — preview + commit both walk the current series.
      // skipSplitSeries is irrelevant here (no split was ever called).
      effectiveSeriesId = pivot.recurrence_series_id;
    }

    // Assemble N per-occurrence plans. The assembler's runtime gates
    // (time-shift, series-mismatch, empty-scope, too-many, B.4.A.5
    // approval-notification) fire here BEFORE the RPC call.
    const { rpc_plans } = await this.assembleEditPlan.assembleScopeEditPlan({
      bookingId,
      tenantId,
      effectiveSeriesId,
      patch: {
        kind: 'scope',
        space_id: body.space_id,
        attendee_count: body.attendee_count,
        attendee_person_ids: body.attendee_person_ids,
        host_person_id: body.host_person_id,
      },
      forwardOnlyFromStartAt,
    });

    // Idempotency key was built earlier (before the commit-mode pre-check
    // + splitSeries) so the pre-check could detect a retry and set
    // skipSplitSeries without re-firing the non-idempotent splitSeries
    // side effect. We reuse the same key here so the RPC's own
    // command_operations advisory-lock + cached_result path is keyed
    // consistently across attempts. The RPC owns cached return (00371:
    // 266-267) and payload_mismatch detection (00371:268-274) — TS does
    // NOT short-circuit on the pre-check.
    //
    // Cascade re-emission on retry: this loop is fire-and-forget through
    // BundleEventBus (in-process Subject). On retry the RPC replays the
    // FIRST attempt's per_occurrence verbatim, so the same diffs are
    // observed and the cascade re-fires. This is the same accepted
    // hazard as editOne/editSlot retries — fixing it requires a domain
    // outbox keyed on (idempotency_key, occurrence_id) which is tracked
    // separately. Mentioned here for visibility, not blocking C1/C2.

    const { data: rpcData, error: rpcErr } = await this.supabase.admin.rpc(
      'edit_booking_scope',
      {
        p_plans: rpc_plans as unknown as Record<string, unknown>[],
        p_tenant_id: tenantId,
        // F-CRIT-1: RPC resolves via `where u.auth_uid = p_actor_user_id`
        // (00371:227-238, mirrors 00364:357-371). Must be the JWT subject,
        // not users.id, or every scope edit fails actor_not_found.
        p_actor_user_id: actor.auth_uid,
        p_idempotency_key: idempotencyKey,
        p_dry_run: dryRun,
      },
    );
    if (rpcErr) {
      // GiST exclusion → 409 (mirrors editOne at reservation.service.ts:
      // 1025-1029). One occurrence colliding with an existing booking on
      // the target space rolls the whole transaction back; the RPC
      // surfaces it as a raise that mapRpcErrorToAppError translates.
      if (this.conflict.isExclusionViolation(rpcErr)) {
        throw AppErrors.conflict('booking.slot_conflict', {
          detail: 'Slot conflicts with another booking in the series.',
        });
      }
      // Self-review remediation I1 (2026-05-12) — server-class fallback.
      // Pre-fix fallback was `edit_booking_scope.invalid_plans` (a 400
      // validation code), which misclassified unknown server-class RPC
      // failures (DB timeout, missing column, OOM, etc.) as 4xx
      // validation. mapRpcErrorToAppError still routes recognised raises
      // to their canonical codes; this fallback only fires when the
      // raise is unregistered. Mirrors editOne's `booking.edit_failed`
      // (line 1184-1191) — see STATUS_BY_CODE entry at map-rpc-error.ts.
      throw mapRpcErrorToAppError(rpcErr, {
        fallbackCode: 'edit_booking_scope.update_failed',
      });
    }

    // RpcEditBookingScopeResult type declared above. On retry the RPC
    // returns cached_result (00371:266-267) verbatim, which matches this
    // shape; the same destructure works for fresh-commit + replay paths.
    const result = rpcData as unknown as RpcEditBookingScopeResult;

    // Visitor cascade fan-out (commit only — dry-run has no committed
    // moves to cascade). The RPC returns per-occurrence before/after on
    // every row; we diff time + room and emit per occurrence whose
    // primary slot moved. Mirrors editOne's cascade block at
    // reservation.service.ts:1054-1066 but loops over N occurrences.
    //
    // Tier B followup #6 (2026-05-12) — batched via
    // emitVisitorCascadesForBundles: one .in('booking_id', [...]) query
    // instead of N sequential .eq('booking_id', _) reads. Caps the
    // post-RPC round-trip cost at 1 regardless of series size.
    if (!dryRun && this.bundleEventBus && result.per_occurrence) {
      const cascadeItems = result.per_occurrence
        .filter((occ) => {
          const movedTime =
            occ.start_at_after !== undefined &&
            occ.start_at_after !== occ.start_at_before;
          const changedRoom =
            occ.space_id_after !== undefined &&
            occ.space_id_after !== occ.space_id_before;
          return movedTime || changedRoom;
        })
        .map((occ) => {
          const movedTime =
            occ.start_at_after !== undefined &&
            occ.start_at_after !== occ.start_at_before;
          const changedRoom =
            occ.space_id_after !== undefined &&
            occ.space_id_after !== occ.space_id_before;
          return {
            tenantId,
            bundleId: occ.booking_id,
            oldStartAt: movedTime ? occ.start_at_before : null,
            newStartAt: movedTime ? occ.start_at_after : null,
            oldSpaceId: changedRoom ? occ.space_id_before : null,
            newSpaceId: changedRoom ? occ.space_id_after : null,
          };
        });
      if (cascadeItems.length > 0) {
        await this.emitVisitorCascadesForBundles(cascadeItems);
      }
    }

    return {
      scope: body.scope,
      new_series_id: newSeriesId,
      dry_run: dryRun,
      committed: result.committed,
      would_succeed: result.would_succeed,
      series_id: result.series_id,
      per_occurrence: result.per_occurrence,
      aggregated_follow_ups: result.aggregated_follow_ups,
    };
  }

  /**
   * Slot-pinned variant of `findByIdOrThrow`. The booking-id read picks
   * the PRIMARY slot for the legacy projection; here we pick the SPECIFIC
   * slot the caller mutated so the response reflects that slot's
   * geometry. Same projection helper, different `eq` filter.
   */
  private async findByIdOrThrowAtSlot(slotId: string, tenantId: string): Promise<Reservation> {
    const { data, error } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .eq('id', slotId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      // /full-review v3 closure Nit 7 — dot-namespacing parity with
      // booking_slot.not_found / booking.slot_conflict / booking.partial_failure.
      // The previous underscore form was inconsistent with neighboring codes.
      throw AppErrors.notFoundWithCode('booking_slot.not_found', 'Slot not found.');
    }
    return slotWithBookingToReservation(data as unknown as SlotWithBookingEmbed);
  }

  /**
   * Slice 4 helper — fan out bundle-cascade events to visitor adapter for a
   * booking whose primary slot just changed.
   *
   * Walks `visitors.booking_id` (00278:41 — column renamed from
   * `booking_bundle_id`).
   *
   * B.4 Step 2F.3 — relaxed from `private` to `public` because `editScope`
   * fans out the cascade for N occurrences using the per-occurrence
   * before/after fields from the `edit_booking_scope` RPC return shape
   * (`00371:1113-1125`). Single new caller; no shared-service refactor.
   *
   * @internal — public ONLY so the editScope path inside this same service
   * can fan out per-occurrence cascades. Do NOT import or call this from
   * another service. Cross-service fan-out belongs in a shared
   * `BundleEventEmitter` (planned but not built); when that exists,
   * relax this back to `private`. Tier C followup #8 closure
   * (b4-followups.md).
   *
   * Retained for editOne / editSlot — they only have one bundle to emit
   * per call, so the batching benefit of the plural sibling
   * `emitVisitorCascadesForBundles` doesn't apply. The plural is for
   * editScope's N-occurrence fan-out (Tier B followup #6 closure).
   */
  async emitVisitorCascadeForBundle(args: {
    tenantId: string;
    bundleId: string;
    oldStartAt: string | null;
    newStartAt: string | null;
    oldSpaceId: string | null;
    newSpaceId: string | null;
  }): Promise<void> {
    if (!this.bundleEventBus) return;
    try {
      const { data, error } = await this.supabase.admin
        .from('visitors')
        .select('id')
        .eq('tenant_id', args.tenantId)
        .eq('booking_id', args.bundleId);
      if (error) {
        this.log.warn(
          `visitor cascade lookup failed for booking ${args.bundleId}: ${error.message}`,
        );
        return;
      }
      const visitorIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
      this.emitVisitorCascadeEvents(args, visitorIds, new Date().toISOString());
    } catch (err) {
      this.log.warn(
        `visitor cascade emit failed for booking ${args.bundleId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Batched sibling of `emitVisitorCascadeForBundle` — one .in('booking_id',
   * [...]) query for N bundles instead of N sequential single-bundle reads.
   * For a 200-occurrence series scope edit, replaces up to 200 round-trips
   * with one. Wire-shape identical (same per-visitor emit payloads); visitor
   * consumers see no difference.
   *
   * Used by `editScope` (reservation.service.ts:~1909-1933) where the RPC
   * returns `per_occurrence[]` (00371:1113-1125) and the TS layer fans out
   * cascades for every row whose primary slot moved time OR changed room.
   *
   * Tenant-isolation: items must share a single `tenant_id`. The plural
   * doesn't read TenantContext — each item carries its own (caller's
   * responsibility, consistent with the singular method's contract and the
   * Phase 8 tenant-thread-through pattern at commit e1b47cae). Mixed-tenant
   * batches throw — there's no defensible reason for one editScope call to
   * span tenants, and silently splitting would muddy the invariant.
   *
   * Error handling mirrors the singular: a failed .in() lookup logs a
   * warning and returns (no throw); a thrown emit on a single bundle is
   * caught per-bundle so one bad subscriber doesn't tank the rest.
   *
   * @internal — same rationale as `emitVisitorCascadeForBundle`. Caller
   * lives in the same service.
   */
  async emitVisitorCascadesForBundles(
    items: Array<{
      tenantId: string;
      bundleId: string;
      oldStartAt: string | null;
      newStartAt: string | null;
      oldSpaceId: string | null;
      newSpaceId: string | null;
    }>,
  ): Promise<void> {
    if (!this.bundleEventBus) return;
    if (items.length === 0) return;

    // Single-tenant assertion. Both editOne/editSlot/editScope establish
    // tenant from TenantContext before constructing items; mixed-tenant
    // batches would indicate a programmer error worth surfacing loudly.
    // Self-review remediation (code-reviewer 2026-05-12 #1): raise an
    // AppError, not a raw Error — this module is migrated (per
    // pnpm errors:check-app-errors). The code reaches the filter's
    // STATUS_BY_CODE map (500) and traceId-tags the response if the
    // assertion ever escapes the service boundary.
    const tenantIds = new Set(items.map((i) => i.tenantId));
    if (tenantIds.size !== 1) {
      throw AppErrors.server('booking.cascade_cross_tenant_batch', {
        detail: `items span ${tenantIds.size} tenants; per-call batches must be per-tenant`,
      });
    }
    const tenantId = items[0].tenantId;
    // Self-review remediation (code-reviewer 2026-05-12 #2): deduplicate
    // by bundleId to prevent double-emit if a future caller passes the
    // same bundleId twice. editScope today derives items from
    // result.per_occurrence (unique booking_ids per RPC contract), so
    // this is defense-in-depth — but the method's public contract
    // shouldn't depend on caller-side uniqueness.
    const seenBundleIds = new Set<string>();
    const dedupedItems = items.filter((item) => {
      if (seenBundleIds.has(item.bundleId)) return false;
      seenBundleIds.add(item.bundleId);
      return true;
    });
    const bundleIds = dedupedItems.map((i) => i.bundleId);

    let data: Array<{ id: string; booking_id: string }> | null = null;
    try {
      const res = await this.supabase.admin
        .from('visitors')
        .select('id, booking_id')
        .eq('tenant_id', tenantId)
        .in('booking_id', bundleIds);
      if (res.error) {
        this.log.warn(
          `visitor cascade batch lookup failed for ${bundleIds.length} bundles: ${res.error.message}`,
        );
        return;
      }
      data = (res.data ?? []) as Array<{ id: string; booking_id: string }>;
    } catch (err) {
      // Defense — supabase-js generally returns errors via `{ error }`, but
      // network-layer throws are possible. Mirror the singular's outer catch.
      this.log.warn(
        `visitor cascade batch lookup threw for ${bundleIds.length} bundles: ${(err as Error).message}`,
      );
      return;
    }

    // Group visitor ids by booking_id so we can iterate items once and emit
    // per-bundle without re-scanning the flat result.
    const visitorIdsByBundle = new Map<string, string[]>();
    for (const v of data) {
      const list = visitorIdsByBundle.get(v.booking_id) ?? [];
      list.push(v.id);
      visitorIdsByBundle.set(v.booking_id, list);
    }

    const now = new Date().toISOString();
    for (const item of dedupedItems) {
      const visitorIds = visitorIdsByBundle.get(item.bundleId) ?? [];
      if (visitorIds.length === 0) continue;
      try {
        this.emitVisitorCascadeEvents(item, visitorIds, now);
      } catch (err) {
        // Per-bundle isolation: a thrown subscriber on one bundle's emit
        // mustn't poison the rest. Same posture as the singular's outer
        // try/catch — log and continue.
        this.log.warn(
          `visitor cascade emit failed for booking ${item.bundleId}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Shared per-bundle emit body. Given a bundle's cascade args + the
   * visitor ids attached to it, fires the (movedTime → bundle.line.moved)
   * + (changedRoom → bundle.line.room_changed) emits per visitor. Called by
   * both `emitVisitorCascadeForBundle` and `emitVisitorCascadesForBundles`
   * so the wire shape stays byte-identical between the singular and plural
   * paths. The args object's null/non-null contract for each axis (the
   * singular method passes nulls for the unchanged axis; plural inherits
   * the same convention from editScope's diff construction at
   * reservation.service.ts:~1923-1929) is the gate that suppresses emits
   * for the unchanged dimension.
   */
  private emitVisitorCascadeEvents(
    args: {
      tenantId: string;
      bundleId: string;
      oldStartAt: string | null;
      newStartAt: string | null;
      oldSpaceId: string | null;
      newSpaceId: string | null;
    },
    visitorIds: string[],
    occurredAt: string,
  ): void {
    if (!this.bundleEventBus) return;
    for (const vid of visitorIds) {
      if (args.newStartAt && args.newStartAt !== args.oldStartAt) {
        this.bundleEventBus.emit({
          kind: 'bundle.line.moved',
          tenant_id: args.tenantId,
          bundle_id: args.bundleId,
          line_id: vid,
          line_kind: 'visitor',
          old_expected_at: args.oldStartAt,
          new_expected_at: args.newStartAt,
          occurred_at: occurredAt,
        });
      }
      if (args.newSpaceId && args.newSpaceId !== args.oldSpaceId) {
        this.bundleEventBus.emit({
          kind: 'bundle.line.room_changed',
          tenant_id: args.tenantId,
          bundle_id: args.bundleId,
          line_id: vid,
          line_kind: 'visitor',
          old_room_id: args.oldSpaceId,
          new_room_id: args.newSpaceId,
          occurred_at: occurredAt,
        });
      }
    }
  }
}
