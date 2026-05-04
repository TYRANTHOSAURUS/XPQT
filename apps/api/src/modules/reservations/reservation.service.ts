import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ConflictGuardService } from './conflict-guard.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { RecurrenceService } from './recurrence.service';
import { BookingNotificationsService } from './booking-notifications.service';
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
    if (error) throw new BadRequestException(`group_siblings_failed:${error.message}`);

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
    if (error || !data) throw new NotFoundException('booking_not_found');
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
    if (error) throw new BadRequestException(`list_failed:${error.message}`);

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
    // right question. We do it via a defensive double-query (orders by
    // booking_id IN (...)) rather than a complex OR clause to keep the
    // query readable; the operator list rarely exceeds 200 rows.
    if (opts.has_bundle) {
      const { data: bookingIdsWithOrders, error: ordersErr } = await this.supabase.admin
        .from('orders')
        .select('booking_id')
        .eq('tenant_id', tenantId)
        .not('booking_id', 'is', null);
      if (ordersErr) throw new BadRequestException(`list_for_operator_orders:${ordersErr.message}`);
      const ids = Array.from(new Set(
        ((bookingIdsWithOrders ?? []) as Array<{ booking_id: string | null }>)
          .map((r) => r.booking_id)
          .filter((id): id is string => Boolean(id)),
      ));
      if (ids.length === 0) {
        return { items: [] };
      }
      q = q.in('booking_id', ids);
    }

    const { data, error } = await q;
    if (error) throw new BadRequestException(`list_for_operator_failed:${error.message}`);

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
      throw new BadRequestException('scheduler_window_requires_range');
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

    if (error) throw new BadRequestException(`scheduler_window_failed:${error.message}`);
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
    if (!this.visibility.canEdit(r, ctx)) throw new ForbiddenException('booking_not_editable');
    if (r.status === 'cancelled') return r;
    if (r.status === 'completed') throw new BadRequestException('booking_completed');

    // Recurrence-scoped cancel: fan-out cancel for this and following / series.
    if (opts.scope && opts.scope !== 'this') {
      if (!this.recurrence) {
        throw new BadRequestException('recurrence_unavailable');
      }
      if (!r.recurrence_series_id) {
        throw new BadRequestException('not_a_recurring_occurrence');
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
    if (slotsErr) throw new BadRequestException(`cancel_failed:${slotsErr.message}`);

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
    if (!this.visibility.canEdit(r, ctx)) throw new ForbiddenException('booking_not_editable');

    if (r.status !== 'cancelled') throw new BadRequestException('booking_not_cancelled');
    if (!r.cancellation_grace_until || new Date(r.cancellation_grace_until) < new Date()) {
      throw new BadRequestException('cancellation_grace_expired');
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
      space_id: r.space_id,
      effective_start_at: r.effective_start_at,
      effective_end_at: r.effective_end_at,
      exclude_ids: slotIdToExclude ? [slotIdToExclude] : [],
    });
    if (conflicts.length > 0) {
      throw new BadRequestException('booking_slot_taken');
    }

    // Re-confirm both layers.
    const { error: slotsErr } = await this.supabase.admin
      .from('booking_slots')
      .update({ status: 'confirmed', cancellation_grace_until: null })
      .eq('tenant_id', tenantId)
      .eq('booking_id', id);
    if (slotsErr) throw new BadRequestException(`restore_failed:${slotsErr.message}`);

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
      throw new BadRequestException('not_a_recurring_occurrence');
    }

    const { error: bookingErr } = await this.supabase.admin
      .from('bookings')
      .update({ status: 'cancelled', recurrence_skipped: true })
      .eq('tenant_id', tenantId)
      .eq('id', id);
    if (bookingErr) throw new BadRequestException(`skip_failed:${bookingErr.message}`);

    const { error: slotsErr } = await this.supabase.admin
      .from('booking_slots')
      .update({ status: 'cancelled' })
      .eq('tenant_id', tenantId)
      .eq('booking_id', id);
    if (slotsErr) throw new BadRequestException(`skip_failed:${slotsErr.message}`);

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
  async editOne(id: string, actor: ActorContext, patch: {
    space_id?: string;
    start_at?: string;
    end_at?: string;
    attendee_count?: number;
    attendee_person_ids?: string[];
    host_person_id?: string;
  }): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    if (!this.visibility.canEdit(r, ctx)) throw new ForbiddenException('booking_not_editable');

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
    // Cross-table FK validity (host_person_id, space_id same-tenant
    // active reservable) is delegated:
    //   - space_id → editSlot RPC validates inside the same atomic write
    //     (00294 C1 closure). Pre-validating here would race with
    //     concurrent admin edits anyway; the atomic RPC is the only
    //     correct gate for that.
    //   - host_person_id → relies on the FK + tenant filter on bookings;
    //     a bad value surfaces as a foreign-key violation at write
    //     time, NOT an editable-by-user precondition.
    if (patch.attendee_count !== undefined) {
      if (
        typeof patch.attendee_count !== 'number' ||
        !Number.isInteger(patch.attendee_count) ||
        patch.attendee_count < 0
      ) {
        throw new BadRequestException({
          code: 'booking.invalid_attendee_count',
          message: 'attendee_count must be a non-negative integer.',
        });
      }
    }
    if (patch.attendee_person_ids !== undefined && !Array.isArray(patch.attendee_person_ids)) {
      throw new BadRequestException({
        code: 'booking.invalid_attendee_person_ids',
        message: 'attendee_person_ids must be an array of person ids.',
      });
    }
    if (patch.start_at !== undefined && patch.end_at !== undefined) {
      const s = new Date(patch.start_at).getTime();
      const e = new Date(patch.end_at).getTime();
      if (!Number.isFinite(s) || !Number.isFinite(e)) {
        throw new BadRequestException({
          code: 'booking.invalid_window',
          message: 'start_at and end_at must be ISO timestamps.',
        });
      }
      if (s >= e) {
        throw new BadRequestException({
          code: 'booking.invalid_window',
          message: 'start_at must be strictly before end_at.',
        });
      }
    }

    // /full-review v3 closure C2 — split the patch into geometry vs. meta.
    //
    // Pre-fix: editOne wrote every key directly to the booking's PRIMARY
    // slot AND mirrored start_at/end_at literally onto bookings (lines
    // ~654 below). For multi-slot bookings, that mirror is wrong: the
    // booking-level start_at MUST be MIN(slots.start_at), NOT the
    // patched value, because non-primary slots may sit at earlier or
    // later windows. Same bug-class as the original Bug #2 (silently
    // moving the primary instead of the targeted slot — 00291 was the
    // RPC that fixed THAT half; this delegation closes the second half
    // where the legacy editOne path bypassed the RPC entirely).
    //
    // Fix: any geometry key (space_id / start_at / end_at) is delegated
    // to editSlot() for the booking's PRIMARY slot. editSlot calls the
    // 00291 + 00293 RPC which:
    //   - updates ONE slot atomically,
    //   - serialises with FOR UPDATE on the parent booking row (00293),
    //   - recomputes bookings.start_at = MIN(slots) / end_at = MAX(slots)
    //     in the same transaction (the only correct mirror).
    // Meta keys (attendee_count, attendee_person_ids, host_person_id)
    // stay on the legacy path — they're not in the RPC's contract and
    // don't need atomicity with mirror recompute.
    const geometryPatch: { space_id?: string; start_at?: string; end_at?: string } = {};
    let hasGeometryChange = false;
    if (patch.space_id && patch.space_id !== r.space_id) {
      geometryPatch.space_id = patch.space_id;
      hasGeometryChange = true;
    }
    if (patch.start_at && patch.start_at !== r.start_at) {
      geometryPatch.start_at = patch.start_at;
      hasGeometryChange = true;
    }
    if (patch.end_at && patch.end_at !== r.end_at) {
      geometryPatch.end_at = patch.end_at;
      hasGeometryChange = true;
    }

    // Build the meta patches. attendee_count + attendee_person_ids live
    // on booking_slots (per-slot semantics — different rooms can have
    // different attendee counts in v2). host_person_id lives on bookings
    // (booking-level metadata).
    const slotMetaPatch: Record<string, unknown> = {};
    const bookingMetaPatch: Record<string, unknown> = {};
    if (patch.attendee_count !== undefined) slotMetaPatch.attendee_count = patch.attendee_count;
    if (patch.attendee_person_ids !== undefined) slotMetaPatch.attendee_person_ids = patch.attendee_person_ids;
    if (patch.host_person_id !== undefined) bookingMetaPatch.host_person_id = patch.host_person_id;
    if (r.recurrence_series_id && (hasGeometryChange || Object.keys(bookingMetaPatch).length > 0 || Object.keys(slotMetaPatch).length > 0)) {
      bookingMetaPatch.recurrence_overridden = true;
    }

    if (
      !hasGeometryChange &&
      Object.keys(slotMetaPatch).length === 0 &&
      Object.keys(bookingMetaPatch).length === 0
    ) {
      return r;
    }

    // Geometry first — invokes the locked RPC + atomic mirror recompute.
    // editSlot owns the visitor-cascade emission (I3); the once-only
    // emission is preserved here because we don't fire it again below.
    if (hasGeometryChange) {
      // Resolve the booking's PRIMARY slot id to target. Same primary-
      // slot definition as the RPC (lowest display_order, ties by
      // created_at ascending) — but we can't piggy-back on editSlot for
      // that lookup because editSlot takes the slot id as input. Read
      // here once; editSlot will do its own pre-flight on that id.
      const { data: primarySlotRow, error: slotErr } = await this.supabase.admin
        .from('booking_slots')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('booking_id', id)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (slotErr || !primarySlotRow) {
        throw new BadRequestException(`edit_failed:no_primary_slot`);
      }
      const primarySlotId = (primarySlotRow as { id: string }).id;
      // Delegate. editSlot enforces canEdit (we already checked above —
      // redundant but cheap), surfaces 409 ConflictException on GiST
      // exclusion, NotFoundException on missing slot, and emits the
      // visitor cascade exactly once.
      await this.editSlot(id, primarySlotId, actor, geometryPatch);
    }

    // Slot-meta (attendee_count / attendee_person_ids) on the primary
    // slot. Pre-fix this happened in the same UPDATE as geometry; now
    // it's a separate write because geometry went through the RPC.
    if (Object.keys(slotMetaPatch).length > 0) {
      // Re-resolve primary slot id (the geometry path may not have been
      // taken). Cheap re-read — same query.
      const { data: primarySlotRow, error: slotErr } = await this.supabase.admin
        .from('booking_slots')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('booking_id', id)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (slotErr || !primarySlotRow) {
        throw new BadRequestException(`edit_failed:no_primary_slot`);
      }
      const primarySlotId = (primarySlotRow as { id: string }).id;

      const { error: updErr } = await this.supabase.admin
        .from('booking_slots')
        .update(slotMetaPatch)
        .eq('tenant_id', tenantId)
        .eq('id', primarySlotId);
      if (updErr) {
        throw new BadRequestException(`edit_failed:${updErr.message}`);
      }
    }

    // Booking-meta (host_person_id, recurrence_overridden).
    if (Object.keys(bookingMetaPatch).length > 0) {
      const { error: bErr } = await this.supabase.admin
        .from('bookings')
        .update(bookingMetaPatch)
        .eq('tenant_id', tenantId)
        .eq('id', id);
      if (bErr) throw new BadRequestException(`edit_failed:${bErr.message}`);
    }

    const updated = await this.findByIdOrThrow(id, tenantId);
    if (this.notifications) void this.notifications.onCreated(updated);
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking.updated',
        entity_type: 'booking',
        entity_id: id,
        details: {
          booking_id: id,
          // Track the patch shape per axis so the audit feed can show
          // "geometry edited" vs "host changed" without re-deriving.
          geometry_patch: geometryPatch,
          slot_meta_patch: slotMetaPatch,
          booking_meta_patch: bookingMetaPatch,
        },
      });
    } catch { /* best-effort */ }

    // Visitor cascade emission (Slice 4) was originally fired from this
    // method. /full-review v3 closure I3 moved it to editSlot so the
    // slot-targeted endpoint emits too — and so geometry edits via
    // editOne (which now delegates to editSlot under C2) don't
    // double-fire. The cascade for any geometry change is owned by
    // editSlot. This block is intentionally empty: meta-only edits
    // (host_person_id, attendee_count) don't move visitors and don't
    // need a cascade.

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
   * Existing `editOne` (`PATCH /reservations/:id`) stays as the booking-
   * level edit path for fields that aren't slot geometry (host_person_id,
   * attendee_count). Frontend callers are expected to use:
   *   - `useEditBooking` for booking-level edits
   *   - `useEditBookingSlot` for slot-geometry edits (drag/resize/move)
   */
  async editSlot(
    bookingId: string,
    slotId: string,
    actor: ActorContext,
    patch: { space_id?: string; start_at?: string; end_at?: string },
  ): Promise<Reservation> {
    const tenantId = TenantContext.current().id;

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
      throw new BadRequestException({
        code: 'booking.slot_update_failed',
        message: (slotErr as { message?: string }).message ?? 'Slot pre-flight failed.',
      });
    }
    if (!slotRow) {
      throw new NotFoundException({
        code: 'booking_slot.not_found',
        message: 'Slot not found.',
      });
    }
    const slotBookingId = (slotRow as { booking_id: string }).booking_id;
    if (slotBookingId !== bookingId) {
      throw new BadRequestException({
        code: 'booking_slot.url_mismatch',
        message: 'slotId does not belong to bookingId.',
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
      throw new ForbiddenException({
        code: 'booking.edit_forbidden',
        message: 'You do not have permission to edit this booking.',
      });
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

    // Build the trimmed RPC patch — only the geometry keys are honored
    // server-side; unrelated keys are stripped here so we don't widen the
    // RPC's contract by accident.
    const rpcPatch: Record<string, unknown> = {};
    if (patch.space_id !== undefined) rpcPatch.space_id = patch.space_id;
    if (patch.start_at !== undefined) rpcPatch.start_at = patch.start_at;
    if (patch.end_at !== undefined) rpcPatch.end_at = patch.end_at;

    const { error: rpcErr } = await this.supabase.admin.rpc('edit_booking_slot', {
      p_slot_id: slotId,
      p_patch: rpcPatch,
      p_tenant_id: tenantId,
    });
    if (rpcErr) {
      // GiST exclusion (booking_slots_no_overlap, 00277:211-217) → 409.
      if (this.conflict.isExclusionViolation(rpcErr)) {
        throw new ConflictException({
          code: 'booking.slot_conflict',
          message: 'Slot conflicts with another booking.',
        });
      }
      // Slot-not-found from inside the RPC (defense in depth — should be
      // caught by the pre-flight above, but if a race deletes the slot
      // between pre-flight and RPC, surface it cleanly).
      const errRecord = rpcErr as { message?: string; hint?: string; details?: string };
      const errMsg = errRecord.message ?? '';
      if (errMsg.includes('booking_slot.not_found')) {
        throw new NotFoundException({
          code: 'booking_slot.not_found',
          message: 'Slot not found.',
        });
      }
      // /full-review v3 closure C1 — cross-tenant / inactive / non-reservable
      // space target. The 00294 RPC raises P0001 with hint
      // 'space.invalid_or_cross_tenant' when the patched space_id fails the
      // (id, tenant_id, active, reservable) probe. Without this map, the
      // RPC's structured rejection drops to a generic slot_update_failed
      // 400 and the client can't tell a permissions/data problem from a
      // schema mismatch. Match on hint OR the raw 'space_invalid' message
      // (PostgREST surfaces both depending on driver shape).
      const errHint = errRecord.hint ?? '';
      const errDetails = errRecord.details ?? '';
      if (
        errHint.includes('space.invalid_or_cross_tenant') ||
        errMsg.includes('space_invalid') ||
        errDetails.includes('space.invalid_or_cross_tenant')
      ) {
        throw new BadRequestException({
          code: 'booking.slot_space_invalid',
          message: 'Target space is invalid or in a different tenant.',
        });
      }
      throw new BadRequestException({
        code: 'booking.slot_update_failed',
        message: errMsg || 'Slot update failed.',
      });
    }

    // Project the post-RPC slot via the same path findOne uses. Reading
    // back the booking embed (rather than trusting the RPC's return jsonb
    // verbatim) keeps the projection logic in ONE place
    // (slotWithBookingToReservation) and means any future column
    // additions land in both paths automatically.
    const updated = await this.findByIdOrThrowAtSlot(slotId, tenantId);

    // /full-review v3 fix — was a silent `try { } catch { /* best-effort */ }`.
    // GDPR Wave 0 Sprint 1 mandates an audit trail for booking-state
    // transitions; if RLS regresses or the row insert errors, ops MUST see
    // it. Slot-edit is a NEW event type that the audit pipeline hasn't
    // been verified against — silent drop is the worst failure mode here.
    // Promoted to log.error on insert error + caught-throw still logged;
    // the user response is unchanged (audit drop doesn't fail the edit
    // since the slot mutation has already committed).
    try {
      const { error: auditErr } = await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking.slot_updated',
        entity_type: 'booking_slot',
        entity_id: slotId,
        details: {
          booking_id: bookingId,
          slot_id: slotId,
          patch: rpcPatch,
        },
      });
      if (auditErr) {
        this.log.error(
          `audit_events insert failed for booking.slot_updated (booking=${bookingId} slot=${slotId}): ${auditErr.message}`,
        );
      }
    } catch (auditCatchErr) {
      this.log.error(
        `audit_events insert threw for booking.slot_updated (booking=${bookingId} slot=${slotId}): ${
          (auditCatchErr as Error).message
        }`,
      );
    }

    // /full-review v3 closure I3 — emit visitor cascade on geometry change.
    //
    // Pre-fix: editOne emitted bundle.line.moved / bundle.line.room_changed
    // for visitors linked to the booking, but editSlot — the slot-targeted
    // equivalent — silently skipped it. Operators editing a non-primary
    // slot via this endpoint moved visitors without firing the cascade
    // (no host alert / email / cancel decision).
    //
    // /full-review v3 closure I1 — compare TARGET slot's pre/post, not
    // primary's pre. `targetSlotPre` (loaded ~890 above) is the slot-
    // pinned projection of the slot we just edited; `updated` is the
    // post-RPC slot-pinned projection. Both project through
    // findByIdOrThrowAtSlot so .start_at / .space_id on each are the
    // TARGET slot's values — never the primary's. Pre-fix this read
    // `reservation` (booking-level / primary-slot projection), which
    // for non-primary edits made the diff fire wrong/missing events.
    //
    // Decision: editSlot is the canonical write path for geometry post-C2.
    // editOne now delegates to it, so the cascade emission belongs HERE,
    // exactly once per geometry edit.
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
      throw new NotFoundException({
        code: 'booking_slot.not_found',
        message: 'Slot not found.',
      });
    }
    return slotWithBookingToReservation(data as unknown as SlotWithBookingEmbed);
  }

  /**
   * Slice 4 helper — fan out bundle-cascade events to visitor adapter for a
   * booking whose primary slot just changed.
   *
   * Walks `visitors.booking_id` (00278:41 — column renamed from
   * `booking_bundle_id`).
   */
  private async emitVisitorCascadeForBundle(args: {
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
      const now = new Date().toISOString();

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
            occurred_at: now,
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
            occurred_at: now,
          });
        }
      }
    } catch (err) {
      this.log.warn(
        `visitor cascade emit failed for booking ${args.bundleId}: ${(err as Error).message}`,
      );
    }
  }
}
