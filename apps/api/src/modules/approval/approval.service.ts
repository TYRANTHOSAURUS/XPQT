import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TicketService } from '../ticket/ticket.service';
import { BookingNotificationsService } from '../reservations/booking-notifications.service';
import { BundleService } from '../booking-bundles/bundle.service';
import type { Reservation } from '../reservations/dto/types';

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

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .update({
        status: dto.status,
        responded_at: new Date().toISOString(),
        comments: dto.comments,
      })
      .eq('id', approvalId)
      .select()
      .single();

    if (error) throw error;

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

    // For reservations: transition the reservation status and notify the requester.
    // Parallel groups: only fire when the whole group is decided (any rejection wins;
    // otherwise wait for all to approve).
    // Sequential chains: only fire on the final step's decision.
    if (approval.target_entity_type === 'reservation') {
      try {
        await this.handleReservationApprovalDecided(approval, dto);
      } catch (err) {
        console.error('[approval] reservation notification failed', err);
      }
    }

    // For booking bundles (and standalone orders, which also use
    // target_entity_type='booking_bundle'): transition linked orders'
    // status and re-fire any deferred internal-setup work orders. Same
    // parallel/chain semantics as reservations.
    if (approval.target_entity_type === 'booking_bundle') {
      try {
        await this.handleBookingBundleApprovalDecided(approval, dto);
      } catch (err) {
        console.error('[approval] booking_bundle notification failed', err);
      }
    }

    return data;
  }

  /**
   * Update reservation.status from pending_approval → confirmed | cancelled and
   * dispatch the requester notification. Respects parallel-group all-must-approve
   * semantics and sequential-chain final-step semantics.
   */
  private async handleReservationApprovalDecided(
    approval: { id: string; target_entity_id: string; parallel_group: string | null;
                approval_chain_id: string | null; comments?: string | null },
    dto: RespondDto,
  ): Promise<void> {
    const tenant = TenantContext.current();

    // Determine the final decision for the reservation.
    let finalDecision: 'approved' | 'rejected';
    if (dto.status === 'rejected') {
      // Any rejection ends the approval (parallel or chained).
      finalDecision = 'rejected';
    } else if (approval.parallel_group) {
      const complete = await this.isParallelGroupComplete(
        approval.parallel_group, approval.target_entity_id,
      );
      if (!complete) return;       // still waiting on peers
      finalDecision = 'approved';
    } else if (approval.approval_chain_id) {
      // For sequential chains, advanceChain has already activated the next step
      // OR completed the chain. Only the final step's approval signals "done".
      const allComplete = await this.isChainComplete(approval.approval_chain_id);
      if (!allComplete) return;
      finalDecision = 'approved';
    } else {
      // Single-step approval — decided now.
      finalDecision = 'approved';
    }

    // Transition reservation status.
    const newStatus = finalDecision === 'approved' ? 'confirmed' : 'cancelled';
    const { data: reservation } = await this.supabase.admin
      .from('reservations')
      .update({
        status: newStatus,
        ...(newStatus === 'cancelled'
          ? { cancellation_grace_until: null }
          : {}),
      })
      .eq('id', approval.target_entity_id)
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending_approval')        // optimistic — only transition once
      .select('*')
      .maybeSingle();

    if (!reservation) return;                  // already transitioned by another path

    await this.bookingNotifications.onApprovalDecided(
      reservation as unknown as Reservation,
      finalDecision,
      approval.comments ?? undefined,
    );
  }

  /**
   * Resolve final decision for a booking_bundle approval and call
   * BundleService.onApprovalDecided once the bundle is fully resolved.
   *
   * Why this doesn't branch on `parallel_group` / `approval_chain_id`
   * like the reservation handler does: bundle approvals are typically
   * upserted by `ApprovalRoutingService.assemble` as independent
   * single-step rows (one per unique approver — cost-center owner +
   * threshold approver + dietary officer, etc.). They have no
   * parallel_group and no chain. But it IS possible for the same bundle
   * to ALSO be targeted by `createParallelGroup` / `createSequentialChain`
   * via the generic API, mixing topologies on a single target. To handle
   * any combination correctly — and to never under-block or over-fire —
   * we always require EVERY approval row on the target to be resolved
   * (`approved` or `expired`). That superset covers single-step, parallel,
   * chained, and mixed bundles uniformly.
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
  private async handleBookingBundleApprovalDecided(
    approval: { id: string; target_entity_id: string; parallel_group: string | null;
                approval_chain_id: string | null; comments?: string | null },
    dto: RespondDto,
  ): Promise<void> {
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

    await this.bundleService.onApprovalDecided(
      approval.target_entity_id,
      finalDecision,
    );
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
