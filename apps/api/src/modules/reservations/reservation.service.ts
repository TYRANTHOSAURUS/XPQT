import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ConflictGuardService } from './conflict-guard.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { RecurrenceService } from './recurrence.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { BundleCascadeService } from '../booking-bundles/bundle-cascade.service';
import { BundleEventBus } from '../booking-bundles/bundle-event-bus';
import type { ActorContext, RecurrenceScope, Reservation } from './dto/types';

/**
 * ReservationService — read paths, simple lifecycle, and edit/cancel/restore.
 *
 * Booking-creation pipeline (the orchestrator) lives in BookingFlowService
 * (file booking-flow.service.ts) which integrates with the rule resolver
 * from Phase B. This service handles the simpler, rule-resolver-independent
 * lifecycle methods.
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
    // parents. Best-effort — a missing path doesn't fail the read.
    try {
      const { data: pathData } = await this.supabase.admin
        .rpc('space_path', { p_space_id: r.space_id });
      const path = Array.isArray(pathData) ? (pathData as string[]) : null;
      return { ...r, space_path: path && path.length > 0 ? path : null };
    } catch {
      return r;
    }
  }

  /**
   * Mutation-path counterpart to `findOne(id, authUid)`. Resolves
   * visibility against an `ActorContext` (which holds `user_id`, the
   * app-side users.id, NOT auth_uid). The previous implementation
   * accidentally passed `actor.user_id` as `authUid` to `findOne`,
   * which caused the underlying `users.eq('auth_uid', actor.user_id)`
   * lookup to return null — yielding an empty context with every
   * permission flag false, which then failed `assertVisible` with
   * "reservation_not_visible" for every drag-move / cancel / restore
   * an operator attempted from the desk scheduler.
   */
  async findOneForActor(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    return r;
  }

  /**
   * Sibling reservations in the same multi_room_group. Used by the
   * booking detail surface so an operator can navigate to any room in
   * the atomic group without leaving the detail context. Returns []
   * for solo bookings (no group). Visibility is inherited from the
   * pivot reservation — the group is atomic, so if you can see one you
   * can see the rest.
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
    if (!pivot.multi_room_group_id) return { items: [] };

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('id, space_id, status, space:spaces(name)')
      .eq('tenant_id', tenantId)
      .eq('multi_room_group_id', pivot.multi_room_group_id)
      .order('created_at', { ascending: true });
    if (error) throw new BadRequestException(`group_siblings_failed:${error.message}`);

    type Row = { id: string; space_id: string; status: string; space?: { name: string | null } | null };
    return {
      items: ((data ?? []) as unknown as Row[]).map((r) => ({
        id: r.id,
        space_id: r.space_id,
        space_name: r.space?.name ?? null,
        status: r.status,
      })),
    };
  }

  private async findByIdOrThrow(id: string, tenantId: string): Promise<Reservation> {
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) throw new NotFoundException('reservation_not_found');
    return data as unknown as Reservation;
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

    let q = this.supabase.admin
      .from('reservations')
      // Join the room name in the same round-trip so the portal "my bookings"
      // page doesn't have to fetch the spaces list just to label rows.
      .select('*, space:spaces(id,name,type)')
      .eq('tenant_id', tenantId)
      .order('start_at', { ascending })
      .order('id', { ascending: true }) // tiebreaker for stable cursor paging
      .limit(limit + 1);

    if (ctx.person_id) {
      // For listMine, restrict to own reservations regardless of read_all.
      q = q.eq('requester_person_id', ctx.person_id);
    } else if (ctx.user_id) {
      q = q.eq('booked_by_user_id', ctx.user_id);
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

    // Cursor format: `${start_at}__${id}` from the previous page's last row.
    // We page on `start_at` with `id` as a tiebreaker — without the
    // tiebreaker, rows sharing a start_at can swap positions across pages
    // and cause duplicates or skips. Until we wired this, the API quietly
    // returned the first N rows and never paged, so anyone with more than
    // limit bookings could not see them.
    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf('__');
      if (sep > 0) {
        const cursorStart = opts.cursor.slice(0, sep);
        const cursorId = opts.cursor.slice(sep + 2);
        q = ascending
          ? q.or(`start_at.gt.${cursorStart},and(start_at.eq.${cursorStart},id.gt.${cursorId})`)
          : q.or(`start_at.lt.${cursorStart},and(start_at.eq.${cursorStart},id.gt.${cursorId})`);
      }
    }

    const { data, error } = await q;
    if (error) throw new BadRequestException(`list_failed:${error.message}`);

    type Row = Reservation & { space?: { id: string; name: string; type: string } | null };
    const all = (data ?? []) as unknown as Row[];
    const rows = all.slice(0, limit).map((r) => ({
      ...r,
      space_name: r.space?.name ?? null,
    }));
    const next_cursor =
      all.length > limit && rows.length > 0
        ? `${rows[rows.length - 1].start_at}__${rows[rows.length - 1].id}`
        : undefined;
    return { items: rows, next_cursor };
  }

  /**
   * Operator/admin list — every reservation in the tenant, filterable by
   * scope + status. Used by /desk/bookings (the operator list view).
   * Throws ForbiddenException if the caller has no rooms.read_all/admin.
   *
   * Joins room name + requester name in one round-trip so the desk page
   * doesn't hydrate per-row.
   */
  async listForOperator(authUid: string, opts: {
    scope?: 'upcoming' | 'past' | 'cancelled' | 'all' | 'pending_approval';
    status?: string[];
    limit?: number;
    /** Only return reservations that have services attached (a non-null
     *  `booking_bundle_id`). Backed by the partial index in 00199 so the
     *  query stays fast on tenants where most reservations are room-only. */
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
      .from('reservations')
      .select('*, space:spaces(id,name,type), requester:persons!requester_person_id(id,first_name,last_name)')
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
    if (opts.has_bundle) q = q.not('booking_bundle_id', 'is', null);

    const { data, error } = await q;
    if (error) throw new BadRequestException(`list_for_operator_failed:${error.message}`);

    type Row = Reservation & {
      space?: { id: string; name: string; type: string } | null;
      requester?: { id: string; first_name: string | null; last_name: string | null } | null;
    };
    const items = ((data ?? []) as unknown as Row[]).map((r) => ({
      ...r,
      space_name: r.space?.name ?? null,
      requester_first_name: r.requester?.first_name ?? null,
      requester_last_name: r.requester?.last_name ?? null,
    }));
    return { items };
  }

  /**
   * Desk-scheduler window read. Returns every reservation on `spaceIds`
   * whose effective_*_at range overlaps [start_at, end_at). Operator-or-admin
   * only — caller verifies via `assertOperatorOrAdmin`.
   *
   * Cancelled / released / completed rows are excluded; the grid only renders
   * blocks for active or pending reservations. (Released slots free the cell.)
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
    // Hard cap to keep the query bounded; the desk grid trims its filter
    // before sending — this guards against pathological clients.
    const cappedSpaceIds = spaceIds.slice(0, 200);

    if (!args.start_at || !args.end_at) {
      throw new BadRequestException('scheduler_window_requires_range');
    }

    // Range overlap: row.effective_start_at < window_end AND row.effective_end_at > window_start.
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('space_id', cappedSpaceIds)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', args.end_at)
      .gt('effective_end_at', args.start_at)
      .order('start_at', { ascending: true })
      .limit(2000);

    if (error) throw new BadRequestException(`scheduler_window_failed:${error.message}`);
    return { items: (data ?? []) as unknown as Reservation[] };
  }

  // === Lifecycle ===

  /**
   * Soft cancel. status='cancelled'. Sets cancellation_grace_until so a
   * follow-up restore can revert within the grace window.
   *
   * For recurring scope='this_and_following' or 'series', the caller is
   * BookingFlowService which knows how to emit impact preview and split
   * the series. This method handles a single occurrence.
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
    if (!this.visibility.canEdit(r, ctx)) throw new ForbiddenException('reservation_not_editable');
    if (r.status === 'cancelled') return r;
    if (r.status === 'completed') throw new BadRequestException('reservation_completed');

    // Recurrence-scoped cancel: fan-out cancel for this and following / series.
    if (opts.scope && opts.scope !== 'this') {
      if (!this.recurrence) {
        throw new BadRequestException('recurrence_unavailable');
      }
      if (!r.recurrence_series_id) {
        throw new BadRequestException('not_a_recurring_occurrence');
      }
      const result = await this.recurrence.cancelForward(id, opts.scope, { reason: opts.reason });
      // Notify on the pivot only (single email rather than N).
      if (this.notifications) void this.notifications.onCancelled(r, opts.reason);
      // Audit event
      try {
        await this.supabase.admin.from('audit_events').insert({
          tenant_id: tenantId,
          event_type: 'reservation.cancelled',
          entity_type: 'reservation',
          entity_id: id,
          details: {
            reservation_id: id, scope: opts.scope, cancelled_count: result.cancelled,
            reason: opts.reason ?? null,
          },
        });
      } catch { /* best-effort */ }
      return { scope: opts.scope, cancelled: result.cancelled, pivot: r };
    }

    const grace = opts.grace_minutes ?? 5;
    const cancellationGraceUntil = new Date(Date.now() + grace * 60 * 1000).toISOString();

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .update({ status: 'cancelled', cancellation_grace_until: cancellationGraceUntil })
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new BadRequestException(`cancel_failed:${error.message}`);

    const updated = data as unknown as Reservation;
    if (this.notifications) void this.notifications.onCancelled(updated, opts.reason);
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'reservation.cancelled',
        entity_type: 'reservation',
        entity_id: id,
        details: { reservation_id: id, scope: 'this', reason: opts.reason ?? null },
      });
    } catch { /* best-effort */ }

    // Sub-project 2 cascade: cancel orders linked to this specific
    // reservation (and their downstream lines, tickets, asset reservations,
    // approvals — rescoped or auto-closed). Scoped to the reservation_id so
    // a non-master occurrence cancel doesn't take sibling occurrences down.
    // The helper looks up the bundle via orders.linked_reservation_id, so
    // it works whether or not reservations.booking_bundle_id is set.
    // Best-effort — a failure here doesn't undo the reservation cancel.
    if (this.bundleCascade) {
      await this.bundleCascade.cancelOrdersForReservation({
        reservation_id: updated.id,
        reason: opts.reason ?? 'reservation_cancelled',
      });
    }

    return updated;
  }

  /**
   * Restore a cancelled reservation if still within cancellation_grace_until.
   * Re-runs conflict guard (someone else may have booked the slot).
   */
  async restore(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContextByUserId(actor.user_id, tenantId);
    const r = await this.findByIdOrThrow(id, tenantId);
    this.visibility.assertVisible(r, ctx);
    if (!this.visibility.canEdit(r, ctx)) throw new ForbiddenException('reservation_not_editable');

    if (r.status !== 'cancelled') throw new BadRequestException('reservation_not_cancelled');
    if (!r.cancellation_grace_until || new Date(r.cancellation_grace_until) < new Date()) {
      throw new BadRequestException('cancellation_grace_expired');
    }

    // Re-check conflict: someone may have booked this slot in the meantime.
    const conflicts = await this.conflict.preCheck({
      space_id: r.space_id,
      effective_start_at: r.effective_start_at,
      effective_end_at: r.effective_end_at,
      exclude_ids: [r.id],
    });
    if (conflicts.length > 0) {
      throw new BadRequestException('reservation_slot_taken');
    }

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .update({ status: 'confirmed', cancellation_grace_until: null })
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new BadRequestException(`restore_failed:${error.message}`);

    // Audit — phase K.
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'reservation.restored',
        entity_type: 'reservation',
        entity_id: id,
        details: { restored_by: actor.user_id },
      });
    } catch { /* best-effort */ }
    return data as unknown as Reservation;
  }

  /**
   * Skip a single occurrence (mark recurrence_skipped + cancelled).
   */
  async skipOccurrence(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const r = await this.findOneForActor(id, actor);
    if (!r.recurrence_series_id) {
      throw new BadRequestException('not_a_recurring_occurrence');
    }

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .update({ status: 'cancelled', recurrence_skipped: true })
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new BadRequestException(`skip_failed:${error.message}`);
    return data as unknown as Reservation;
  }

  /**
   * Edit a single occurrence. Sets recurrence_overridden=true if part of a series.
   * Re-runs conflict guard if time/space changed.
   *
   * Full edit-this-and-following / edit-entire-series semantics live in
   * BookingFlowService since they re-run the rule resolver.
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
    if (!this.visibility.canEdit(r, ctx)) throw new ForbiddenException('reservation_not_editable');

    const next: Record<string, unknown> = {};
    if (patch.space_id && patch.space_id !== r.space_id) next.space_id = patch.space_id;
    if (patch.start_at && patch.start_at !== r.start_at) next.start_at = patch.start_at;
    if (patch.end_at && patch.end_at !== r.end_at) next.end_at = patch.end_at;
    if (patch.attendee_count !== undefined) next.attendee_count = patch.attendee_count;
    if (patch.attendee_person_ids !== undefined) next.attendee_person_ids = patch.attendee_person_ids;
    if (patch.host_person_id !== undefined) next.host_person_id = patch.host_person_id;

    if (r.recurrence_series_id) next.recurrence_overridden = true;

    if (Object.keys(next).length === 0) return r;

    // The exclusion-constraint will catch race conditions. The trigger
    // recomputes effective_*_at + time_range from the new values.
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .update(next)
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      if (this.conflict.isExclusionViolation(error)) {
        throw new BadRequestException('reservation_slot_conflict');
      }
      throw new BadRequestException(`edit_failed:${error.message}`);
    }

    const updated = data as unknown as Reservation;
    if (this.notifications) void this.notifications.onCreated(updated);
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'reservation.updated',
        entity_type: 'reservation',
        entity_id: id,
        details: { reservation_id: id, patch: next },
      });
    } catch { /* best-effort */ }

    // Slice 4: emit bundle-cascade events for any visitors linked to the
    // bundle that owns this reservation. The visitor adapter (in
    // VisitorsModule) translates each per-visitor event into the right
    // status/email/host-alert action per spec §10.2.
    //
    // Fired AFTER the DB update succeeds + audit landed. Visitors are
    // resolved via `visitors.booking_bundle_id`, the canonical link added in
    // 00252. We emit one event per visitor with line_id=visitor.id +
    // line_kind='visitor' so the adapter can handle each row individually
    // (status-aware cascade matrix).
    //
    // Visibility: ReservationService.editOne already passed assertVisible +
    // canEdit checks above. Tenant-id is on the BundleEvent payload so the
    // adapter defends explicitly.
    const movedTime = patch.start_at && patch.start_at !== r.start_at;
    const changedRoom = patch.space_id && patch.space_id !== r.space_id;
    if ((movedTime || changedRoom) && r.booking_bundle_id && this.bundleEventBus) {
      await this.emitVisitorCascadeForBundle({
        tenantId,
        bundleId: r.booking_bundle_id,
        oldStartAt: movedTime ? r.start_at : null,
        newStartAt: movedTime ? (updated.start_at ?? patch.start_at!) : null,
        oldSpaceId: changedRoom ? r.space_id : null,
        newSpaceId: changedRoom ? (updated.space_id ?? patch.space_id!) : null,
      });
    }

    return updated;
  }

  /**
   * Slice 4 helper — fan out bundle-cascade events to visitor adapter for a
   * bundle whose primary reservation just changed.
   *
   * Walks `visitors.booking_bundle_id`, emits one event per visitor with
   * line_kind='visitor' so the adapter's status-aware matrix can decide
   * cancel/email/alert per row.
   *
   * Best-effort: a query failure logs + returns; the reservation edit has
   * already succeeded and we don't want a downstream event hiccup to
   * masquerade as an edit failure.
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
        .eq('booking_bundle_id', args.bundleId);
      if (error) {
        this.log.warn(
          `visitor cascade lookup failed for bundle ${args.bundleId}: ${error.message}`,
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
        `visitor cascade emit failed for bundle ${args.bundleId}: ${(err as Error).message}`,
      );
    }
  }
}
