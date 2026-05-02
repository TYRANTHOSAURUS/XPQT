import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TicketService } from '../ticket/ticket.service';
import { BookingNotificationsService } from '../reservations/booking-notifications.service';
import { BundleService } from '../booking-bundles/bundle.service';
import { VisitorService } from '../visitors/visitor.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from '../reservations/reservation-projection';

export interface ApprovalActor {
  userId: string;
  personId: string;
}

export interface CreateApprovalDto {
  target_entity_type: string;
  target_entity_id: string;
  approver_person_id?: string;
  approver_team_id?: string;
  approval_chain_id?: string;
  step_number?: number;
  parallel_group?: string;
}

export interface RespondDto {
  status: 'approved' | 'rejected';
  comments?: string;
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly ticketService: TicketService,
    @Inject(forwardRef(() => BookingNotificationsService))
    private readonly bookingNotifications: BookingNotificationsService,
    @Inject(forwardRef(() => BundleService))
    private readonly bundleService: BundleService,
    // VisitorService — slice 3 wiring for `target_entity_type='visitor_invite'`.
    // forwardRef both at the module-import side and here at the constructor
    // side because VisitorsModule already imports ApprovalModule (the
    // InvitationService writes the approvals row at invite time).
    @Inject(forwardRef(() => VisitorService))
    private readonly visitorService: VisitorService,
  ) {}

  /**
   * Resolve a Supabase auth uid to the caller's user/person identity within
   * the current tenant. Returns `null` when the auth user has no row in the
   * tenant — callers should treat that as forbidden.
   */
  async resolveActorPerson(authUid: string): Promise<ApprovalActor | null> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    if (error || !data || !data.person_id) return null;
    return { userId: data.id as string, personId: data.person_id as string };
  }

  /**
   * Get pending approvals for the caller's own queue. Surfaces:
   *  • approvals where `approver_person_id` is the caller (or someone who
   *    delegated to them — `delegations` is keyed by `delegate_user_id`),
   *  • approvals where `approver_team_id` is a team the caller belongs to.
   * Team-approvals do not carry delegation; any active team member can pick
   * one up, so the `team_members` membership lookup is the only gate.
   */
  async getPendingForActor(actor: ApprovalActor) {
    const tenant = TenantContext.current();

    const nowIso = new Date().toISOString();
    const { data: delegations } = await this.supabase.admin
      .from('delegations')
      .select('delegator_user_id')
      .eq('delegate_user_id', actor.userId)
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .lte('starts_at', nowIso)
      .gte('ends_at', nowIso);

    const delegatorUserIds = (delegations ?? [])
      .map((d) => d.delegator_user_id as string)
      .filter(Boolean);

    let approverPersonIds: string[] = [actor.personId];
    if (delegatorUserIds.length > 0) {
      const { data: delegatorUsers } = await this.supabase.admin
        .from('users')
        .select('person_id')
        .eq('tenant_id', tenant.id)
        .in('id', delegatorUserIds);
      const delegatorPersonIds = (delegatorUsers ?? [])
        .map((u) => u.person_id as string | null)
        .filter((v): v is string => Boolean(v));
      if (delegatorPersonIds.length > 0) {
        approverPersonIds = [...new Set([...approverPersonIds, ...delegatorPersonIds])];
      }
    }

    const { data: memberships } = await this.supabase.admin
      .from('team_members')
      .select('team_id')
      .eq('tenant_id', tenant.id)
      .eq('user_id', actor.userId);
    const approverTeamIds = (memberships ?? [])
      .map((m) => m.team_id as string)
      .filter(Boolean);

    const orClauses: string[] = [
      `approver_person_id.in.(${approverPersonIds.join(',')})`,
    ];
    if (approverTeamIds.length > 0) {
      orClauses.push(`approver_team_id.in.(${approverTeamIds.join(',')})`);
    }

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending')
      .or(orClauses.join(','))
      .order('requested_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  /**
   * Count + urgency snapshot of the caller's pending approvals — used by
   * the desk-shell rail badge. Two scoped queries:
   *
   *   1. `count: 'exact', head: true` for the total — never materializes
   *      rows, immune to Supabase's default 1000-row payload cap that
   *      would silently truncate `getPendingForActor(...).length`.
   *   2. A bounded `.lte('requested_at', cutoff).limit(1)` to detect
   *      whether any pending approval is older than 24h — one row is
   *      enough to set the urgency flag.
   *
   * Both queries reuse the same OR-clause shape as getPendingForActor so
   * delegations and team-memberships are honored identically.
   *
   * Spec: docs/superpowers/specs/2026-05-02-main-menu-redesign-design.md §Counts
   */
  async getPendingCountForActor(
    actor: ApprovalActor,
  ): Promise<{ count: number; hasUrgency: boolean }> {
    const tenant = TenantContext.current();
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Resolve delegations + team memberships exactly as getPendingForActor.
    const { data: delegations } = await this.supabase.admin
      .from('delegations')
      .select('delegator_user_id')
      .eq('delegate_user_id', actor.userId)
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .lte('starts_at', nowIso)
      .gte('ends_at', nowIso);

    const delegatorUserIds = (delegations ?? [])
      .map((d) => d.delegator_user_id as string)
      .filter(Boolean);

    let approverPersonIds: string[] = [actor.personId];
    if (delegatorUserIds.length > 0) {
      const { data: delegatorUsers } = await this.supabase.admin
        .from('users')
        .select('person_id')
        .eq('tenant_id', tenant.id)
        .in('id', delegatorUserIds);
      const delegatorPersonIds = (delegatorUsers ?? [])
        .map((u) => u.person_id as string | null)
        .filter((v): v is string => Boolean(v));
      if (delegatorPersonIds.length > 0) {
        approverPersonIds = [...new Set([...approverPersonIds, ...delegatorPersonIds])];
      }
    }

    const { data: memberships } = await this.supabase.admin
      .from('team_members')
      .select('team_id')
      .eq('tenant_id', tenant.id)
      .eq('user_id', actor.userId);
    const approverTeamIds = (memberships ?? [])
      .map((m) => m.team_id as string)
      .filter(Boolean);

    const orClauses: string[] = [
      `approver_person_id.in.(${approverPersonIds.join(',')})`,
    ];
    if (approverTeamIds.length > 0) {
      orClauses.push(`approver_team_id.in.(${approverTeamIds.join(',')})`);
    }

    const orExpr = orClauses.join(',');

    // Total count — head:true means no row payload, just the count.
    const { count, error: countError } = await this.supabase.admin
      .from('approvals')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending')
      .or(orExpr);
    if (countError) throw countError;

    // Urgency probe — fetch up to 1 row older than cutoff. Existence is enough.
    const { data: stale, error: staleError } = await this.supabase.admin
      .from('approvals')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending')
      .or(orExpr)
      .lte('requested_at', cutoffIso)
      .limit(1);
    if (staleError) throw staleError;

    return {
      count: count ?? 0,
      hasUrgency: (stale?.length ?? 0) > 0,
    };
  }

  /**
   * Get all approvals for a specific target entity (e.g., all approvals for a ticket).
   */
  async getForEntity(entityType: string, entityId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('target_entity_type', entityType)
      .eq('target_entity_id', entityId)
      .order('step_number', { ascending: true });

    if (error) throw error;
    return data;
  }

  /**
   * Create a single-step approval request.
   */
  async createSingleStep(dto: CreateApprovalDto) {
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .insert({
        tenant_id: tenant.id,
        target_entity_type: dto.target_entity_type,
        target_entity_id: dto.target_entity_id,
        approver_person_id: dto.approver_person_id,
        approver_team_id: dto.approver_team_id,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    await this.logDomainEvent(dto.target_entity_id, 'approval_requested', {
      approval_id: data.id,
      approver_person_id: dto.approver_person_id,
    });

    return data;
  }

  /**
   * Create a sequential multi-step approval chain.
   * Steps are processed in order — step 2 only activates after step 1 is approved.
   */
  async createSequentialChain(
    targetEntityType: string,
    targetEntityId: string,
    steps: Array<{ approver_person_id?: string; approver_team_id?: string }>,
  ) {
    const tenant = TenantContext.current();
    const chainId = crypto.randomUUID();

    const approvals = steps.map((step, index) => ({
      tenant_id: tenant.id,
      target_entity_type: targetEntityType,
      target_entity_id: targetEntityId,
      approval_chain_id: chainId,
      step_number: index + 1,
      approver_person_id: step.approver_person_id,
      approver_team_id: step.approver_team_id,
      // The `approvals.status` check column has no `waiting` state — every
      // step is inserted as `pending` and the UI / `respond()` flow enforce
      // sequential order by only surfacing the current step as actionable.
      // Earlier code carried `index === 0 ? 'pending' : 'pending'` as a
      // placeholder for a never-shipped staged state.
      status: 'pending',
    }));

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .insert(approvals)
      .select();

    if (error) throw error;
    return { chain_id: chainId, steps: data };
  }

  /**
   * Create a parallel approval group.
   * All approvers must approve for the group to be complete.
   */
  async createParallelGroup(
    targetEntityType: string,
    targetEntityId: string,
    approvers: Array<{ approver_person_id?: string; approver_team_id?: string }>,
    groupName: string,
  ) {
    const tenant = TenantContext.current();

    const approvals = approvers.map((approver) => ({
      tenant_id: tenant.id,
      target_entity_type: targetEntityType,
      target_entity_id: targetEntityId,
      parallel_group: groupName,
      approver_person_id: approver.approver_person_id,
      approver_team_id: approver.approver_team_id,
      status: 'pending',
    }));

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .insert(approvals)
      .select();

    if (error) throw error;
    return { parallel_group: groupName, approvals: data };
  }

  /**
   * Respond to an approval (approve or reject).
   *
   * `respondingPersonId` and `respondingUserId` are server-derived from the
   * caller's auth uid — never trust them from the request body. We verify the
   * caller is either the named approver, on the approver team, or holds an
   * active delegation from the named approver.
   */
  async respond(
    approvalId: string,
    dto: RespondDto,
    respondingPersonId: string,
    respondingUserId?: string,
  ) {
    const tenant = TenantContext.current();

    const { data: approval, error: findError } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('id', approvalId)
      .eq('tenant_id', tenant.id)
      .single();

    if (findError || !approval) throw new NotFoundException('Approval not found');
    if (approval.status !== 'pending') throw new BadRequestException('Approval already responded to');

    // Authorization: caller must be a permitted approver for this row.
    const allowed = await this.callerCanRespond(approval, respondingPersonId, respondingUserId);
    if (!allowed) {
      throw new ForbiddenException('You are not an approver for this request');
    }

    // CAS — codex 2026-04-30 review found a read-then-unconditional-write
    // race: two concurrent respond() calls can both pass the read-side
    // `status === 'pending'` check, then write `approved` and `rejected`
    // on top of each other. The second write would clobber the first AND
    // the bundle/reservation handler for the second decision would run
    // even though the first already transitioned downstream state. Net
    // effect: a rejected row could coexist with approved+open fulfillment.
    //
    // Filtering on `status='pending'` makes the update atomic. If the
    // filter doesn't match (the row was decided concurrently between our
    // read and write), `.maybeSingle()` returns null and we bail with
    // the same conflict shape as the read-side check — no downstream
    // dispatch fires.
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .update({
        status: dto.status,
        responded_at: new Date().toISOString(),
        comments: dto.comments,
      })
      .eq('id', approvalId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new BadRequestException('Approval already responded to');

    await this.logDomainEvent(approval.target_entity_id, `approval_${dto.status}`, {
      approval_id: approvalId,
      responded_by: respondingPersonId,
    });

    // For sequential chains: if approved, check if next step should activate
    if (dto.status === 'approved' && approval.approval_chain_id) {
      await this.advanceChain(approval.approval_chain_id, approval.step_number);
    }

    // Notify the target entity when its approval is resolved.
    // For single-step approvals on tickets, this unblocks routing/SLA/workflow.
    if (approval.target_entity_type === 'ticket' && !approval.approval_chain_id && !approval.parallel_group) {
      try {
        await this.ticketService.onApprovalDecision(approval.target_entity_id, dto.status);
      } catch (err) {
        console.error('[approval] ticket notification failed', err);
      }
    }

    // For bookings (and standalone orders, which also use
    // target_entity_type='booking' post-canonicalisation): transition the
    // booking + linked orders, fire deferred work orders, notify the
    // requester. The pre-rewrite split (reservation vs. booking_bundle)
    // collapses into one `'booking'` branch since the booking IS the
    // bundle (00277:27). Parallel/chain semantics live inside the handler.
    //
    // 00278:163-165 backfills any legacy `'reservation'` / `'booking_bundle'`
    // rows to `'booking'`, so this single branch covers both old and new
    // data uniformly. The dispatcher used to invoke separate
    // `handleReservationApprovalDecided` + `handleBookingBundleApprovalDecided`
    // codepaths; the merged handler invokes BOTH downstream effects so we
    // (a) flip the booking_slots/bookings status to confirmed/cancelled
    // (the old reservation handler's job) and (b) flip the orders + fire
    // deferred internal-setup (the old bundle handler's job).
    if (approval.target_entity_type === 'booking') {
      try {
        await this.handleBookingApprovalDecided(approval, dto);
      } catch (err) {
        console.error('[approval] booking notification failed', err);
      }
    }

    // For visitor invites (slice 3 — visitor management v1 §11.3):
    // dispatch to VisitorService.onApprovalDecided which:
    //   - on 'approved': transitions visitor pending_approval → expected
    //     and emits visitor.invitation.expected so the slice 5 email worker
    //     sends the invitation.
    //   - on 'rejected': transitions visitor pending_approval → denied
    //     and notifies the host(s) via HostNotificationService.
    // v1 routes visitor approvals as single-step rows only (no parallel
    // groups, no chains) — InvitationService.create writes one row per
    // invite. If a future tenant configures multi-step or parallel
    // visitor approvals, this branch will need the same all-resolved
    // gate the booking_bundle branch uses.
    if (approval.target_entity_type === 'visitor_invite') {
      try {
        // I13 (full review): require respondingUserId. The legacy fallback
        // `respondingUserId ?? respondingPersonId` smuggled a person_id
        // value into a user_id field — VisitorService.onApprovalDecided
        // stores the value in `audit_events.details.actor_user_id`, so
        // the fallback wrote a person uuid where the schema expects a
        // user uuid. Better to fail fast: the controller always passes
        // `actor.userId`; a missing value here is a real bug.
        if (!respondingUserId) {
          throw new BadRequestException(
            'respondingUserId is required for visitor_invite approval dispatch',
          );
        }
        await this.visitorService.onApprovalDecided(
          approval.target_entity_id,
          dto.status,
          respondingUserId,
          approval.tenant_id,
        );
      } catch (err) {
        // Mirror the other dispatch branches — a downstream failure
        // shouldn't roll back the approval grant. Logged for ops.
        console.error('[approval] visitor_invite notification failed', err);
      }
    }

    return data;
  }

  /**
   * Merged booking approval handler. Post-canonicalisation (2026-05-02):
   * the booking IS the bundle (00277:27), so a single approval target —
   * `target_entity_type='booking'` — covers what used to be split between
   * the `'reservation'` and `'booking_bundle'` branches. We:
   *
   *   1. Resolve the final decision using the strictest topology rule
   *      across single-step / parallel / sequential / mixed approvals
   *      (every approval row on the target must be `approved` or
   *      `expired` — see `areAllTargetApprovalsApproved` for why
   *      `expired` counts).
   *   2. Flip the booking_slots' status from pending_approval →
   *      confirmed | cancelled (per-slot status, 00277:142-144). For
   *      v1 single-slot bookings this is one row; for multi-slot,
   *      every pending_approval slot transitions together.
   *   3. Mirror to bookings.status (booking-level, 00277:49-51) so list
   *      endpoints reflect the change.
   *   4. Re-read the booking via the slot+booking projection helper
   *      (the notification consumer still takes the legacy `Reservation`
   *      shape) and dispatch the requester email via
   *      BookingNotificationsService.onApprovalDecided.
   *   5. Cascade through BundleService.onApprovalDecided to flip linked
   *      orders + fire deferred internal-setup work orders.
   *
   * Why the merger is safe: orders attach to bookings via
   * orders.booking_id (00278:109). Any order linked to this approval's
   * booking is the same set previously found via the legacy
   * `target_entity_type='booking_bundle'` lookup — under canonicalisation
   * those are the same id.
   *
   * Resolution rules:
   *   - Any rejection ends the approval immediately ('rejected'). Sibling
   *     pending peers are expired by `BundleService.onApprovalDecided`
   *     to keep approvers' queues clean.
   *   - Otherwise: every approval row on the same `target_entity_id`
   *     must be in `approved` or `expired` status. If any is still
   *     `pending` (or defensively `rejected`), return — the next peer's
   *     grant will re-enter this handler.
   */
  private async handleBookingApprovalDecided(
    approval: { id: string; target_entity_id: string; parallel_group: string | null;
                approval_chain_id: string | null; comments?: string | null },
    dto: RespondDto,
  ): Promise<void> {
    const tenant = TenantContext.current();

    let finalDecision: 'approved' | 'rejected';
    if (dto.status === 'rejected') {
      finalDecision = 'rejected';
    } else {
      const allResolved = await this.areAllTargetApprovalsApproved(
        approval.target_entity_id,
      );
      if (!allResolved) return;
      finalDecision = 'approved';
    }

    const newStatus = finalDecision === 'approved' ? 'confirmed' : 'cancelled';

    // Transition booking_slots first (the per-slot source of truth).
    // Optimistic: only transition pending_approval rows.
    const { data: transitionedSlots, error: slotErr } = await this.supabase.admin
      .from('booking_slots')
      .update({
        status: newStatus,
        ...(newStatus === 'cancelled'
          ? { cancellation_grace_until: null }
          : {}),
      })
      .eq('booking_id', approval.target_entity_id)
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending_approval')
      .select('id');
    if (slotErr) {
      console.error('[approval] booking_slots transition failed', slotErr);
    }

    // Mirror to bookings.status. The "did anything actually change?"
    // signal comes from the slot result above — if no slot transitioned,
    // the booking has already been resolved by another path.
    const { data: bookingRow } = await this.supabase.admin
      .from('bookings')
      .update({
        status: newStatus,
      })
      .eq('id', approval.target_entity_id)
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending_approval')
      .select('id')
      .maybeSingle();

    // If neither layer transitioned, another path beat us to it. Don't
    // re-fire the downstream notification or bundle cascade — those
    // already ran (or will run) on the winning path.
    if (!bookingRow && (transitionedSlots ?? []).length === 0) {
      return;
    }

    // Notification: the consumer takes the legacy Reservation shape, so
    // re-read the booking via the slot+booking projection. Best-effort —
    // the approval has already been recorded; a notification failure
    // shouldn't roll the decision back.
    try {
      const { data: refreshed } = await this.supabase.admin
        .from('booking_slots')
        .select(SLOT_WITH_BOOKING_SELECT)
        .eq('tenant_id', tenant.id)
        .eq('booking_id', approval.target_entity_id)
        .order('display_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (refreshed) {
        await this.bookingNotifications.onApprovalDecided(
          slotWithBookingToReservation(refreshed as unknown as SlotWithBookingEmbed),
          finalDecision,
          approval.comments ?? undefined,
        );
      }
    } catch (err) {
      console.error('[approval] booking notification fan-out failed', err);
    }

    // Bundle cascade: flip linked orders + fire deferred internal-setup
    // work orders. Even when there are no orders attached this is a no-op
    // (the bundle service short-circuits when zero orders match).
    try {
      await this.bundleService.onApprovalDecided(
        approval.target_entity_id,
        finalDecision,
      );
    } catch (err) {
      console.error('[approval] booking bundle cascade failed', err);
    }
  }

  /**
   * True when every approval row on the given target is RESOLVED
   * affirmatively — explicitly: every row is `approved` or `expired`,
   * and no row is `pending` or `rejected` (or any other future status).
   *
   * Why `expired` counts as resolved: `BundleCascadeService.
   * rescopeApprovalsAfterLineCancel` sets approvals to `expired` when
   * their scope_breakdown is emptied by a line cancel. Treating
   * `expired` as blocking would deadlock multi-approver bundles
   * whenever any line cancels — the surviving approver's grant could
   * never resolve the bundle.
   *
   * Why we explicitly enumerate (instead of "anything not-pending"):
   * future approval-row statuses (e.g. `delegated`, `revoked`) should
   * not silently count as resolved. If a new status is introduced, this
   * helper should be revisited explicitly.
   *
   * False when there are zero rows — defensive: a target with no rows
   * shouldn't reach this path. Used by booking_bundle resolution.
   */
  private async areAllTargetApprovalsApproved(
    targetEntityId: string,
  ): Promise<boolean> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('approvals')
      .select('status')
      .eq('tenant_id', tenant.id)
      .eq('target_entity_id', targetEntityId);
    if (!data || data.length === 0) return false;
    const RESOLVED = new Set(['approved', 'expired']);
    return data.every((a) => RESOLVED.has(a.status as string));
  }

  /**
   * Check if all approvals in a parallel group are complete.
   */
  async isParallelGroupComplete(parallelGroup: string, targetEntityId: string): Promise<boolean> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('approvals')
      .select('status')
      .eq('tenant_id', tenant.id)
      .eq('target_entity_id', targetEntityId)
      .eq('parallel_group', parallelGroup);

    if (!data || data.length === 0) return false;
    return data.every((a) => a.status === 'approved');
  }

  /**
   * Check if a sequential chain is fully approved.
   */
  async isChainComplete(chainId: string): Promise<boolean> {
    const { data } = await this.supabase.admin
      .from('approvals')
      .select('status')
      .eq('approval_chain_id', chainId);

    if (!data || data.length === 0) return false;
    return data.every((a) => a.status === 'approved');
  }

  private async advanceChain(chainId: string, _completedStep: number) {
    // Check if any steps in the chain were rejected
    const { data: chainSteps } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('approval_chain_id', chainId)
      .order('step_number');

    if (!chainSteps) return;

    const hasRejection = chainSteps.some((s) => s.status === 'rejected');
    if (hasRejection) return; // Chain is broken, no more steps

    // The next step is already "pending" — in a real implementation you might
    // want to hold steps as "waiting" and only set to "pending" when it's their turn.
    // For now the sequential enforcement happens at the respond() level:
    // the UI should only show the current step as actionable.
  }

  private async logDomainEvent(entityId: string, eventType: string, payload: Record<string, unknown>) {
    const tenant = TenantContext.current();
    await this.supabase.admin.from('domain_events').insert({
      tenant_id: tenant.id,
      event_type: eventType,
      entity_type: 'approval',
      entity_id: entityId,
      payload,
    });
  }

  /**
   * Authorization gate for `respond`. Caller is permitted when:
   *  • their personId matches `approver_person_id`, OR
   *  • they hold an active delegation from the named approver, OR
   *  • they are a member of `approver_team_id` (any team member can act).
   */
  private async callerCanRespond(
    approval: {
      approver_person_id: string | null;
      approver_team_id: string | null;
    },
    callerPersonId: string,
    callerUserId?: string,
  ): Promise<boolean> {
    const tenant = TenantContext.current();

    if (approval.approver_person_id && approval.approver_person_id === callerPersonId) {
      return true;
    }

    if (approval.approver_team_id && callerUserId) {
      const { data: member } = await this.supabase.admin
        .from('team_members')
        .select('user_id')
        .eq('tenant_id', tenant.id)
        .eq('team_id', approval.approver_team_id)
        .eq('user_id', callerUserId)
        .maybeSingle();
      if (member) return true;
    }

    if (approval.approver_person_id && callerUserId) {
      const { data: approverUser } = await this.supabase.admin
        .from('users')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('person_id', approval.approver_person_id)
        .maybeSingle();
      if (approverUser) {
        const nowIso = new Date().toISOString();
        const { data: delegation } = await this.supabase.admin
          .from('delegations')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('delegator_user_id', approverUser.id)
          .eq('delegate_user_id', callerUserId)
          .eq('active', true)
          .lte('starts_at', nowIso)
          .gte('ends_at', nowIso)
          .maybeSingle();
        if (delegation) return true;
      }
    }

    return false;
  }
}
