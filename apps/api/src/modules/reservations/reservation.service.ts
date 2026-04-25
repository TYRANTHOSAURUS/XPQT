import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ConflictGuardService } from './conflict-guard.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { RecurrenceService } from './recurrence.service';
import { BookingNotificationsService } from './booking-notifications.service';
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
  constructor(
    private readonly supabase: SupabaseService,
    private readonly conflict: ConflictGuardService,
    private readonly visibility: ReservationVisibilityService,
    @Optional() private readonly recurrence?: RecurrenceService,
    @Optional() private readonly notifications?: BookingNotificationsService,
  ) {}

  // === Reads ===

  async findOne(id: string, authUid: string): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('id', id)
      .maybeSingle();

    if (error || !data) throw new NotFoundException('reservation_not_found');
    const r = data as unknown as Reservation;
    this.visibility.assertVisible(r, ctx);
    return r;
  }

  async listMine(authUid: string, opts: {
    scope?: 'upcoming' | 'past' | 'cancelled' | 'all';
    limit?: number;
    cursor?: string;
  }): Promise<{ items: Reservation[]; next_cursor?: string }> {
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(authUid, tenantId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

    let q = this.supabase.admin
      .from('reservations')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('start_at', { ascending: false })
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

    const { data, error } = await q;
    if (error) throw new BadRequestException(`list_failed:${error.message}`);

    const rows = (data ?? []) as unknown as Reservation[];
    return { items: rows.slice(0, limit) };
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
    const r = await this.findOne(id, actor.user_id);

    const ctx = await this.visibility.loadContext(actor.user_id, tenantId);
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

    return updated;
  }

  /**
   * Restore a cancelled reservation if still within cancellation_grace_until.
   * Re-runs conflict guard (someone else may have booked the slot).
   */
  async restore(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const r = await this.findOne(id, actor.user_id);
    const ctx = await this.visibility.loadContext(actor.user_id, tenantId);
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

    // TODO(phase-J): emit reservation.restored event + notify
    return data as unknown as Reservation;
  }

  /**
   * Skip a single occurrence (mark recurrence_skipped + cancelled).
   */
  async skipOccurrence(id: string, actor: ActorContext): Promise<Reservation> {
    const tenantId = TenantContext.current().id;
    const r = await this.findOne(id, actor.user_id);
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
    const r = await this.findOne(id, actor.user_id);
    const ctx = await this.visibility.loadContext(actor.user_id, tenantId);
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
    return updated;
  }
}
