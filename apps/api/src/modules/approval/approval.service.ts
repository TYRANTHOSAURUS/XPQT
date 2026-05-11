import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { AppErrors } from '../../common/errors';
import { mapRpcErrorToAppError } from '../../common/errors/map-rpc-error';
import { randomUUID } from 'node:crypto';
import { buildApprovalGrantIdempotencyKey } from '@prequest/shared';
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

/**
 * Minimal shape of an approvals row read from `select('*')`. Used by the
 * B.0.D.3 cutover so the booking-target dispatcher has typed access to
 * the fields it needs without loosely typing the whole module on
 * `Record<string, unknown>`.
 */
interface ApprovalRow {
  id: string;
  tenant_id: string;
  target_entity_type: string;
  target_entity_id: string;
  parallel_group: string | null;
  approval_chain_id: string | null;
  status: string;
  step_number?: number | null;
  comments?: string | null;
  approver_person_id: string | null;
  approver_team_id: string | null;
}

/**
 * Possible outcomes of `grant_booking_approval` (00310 / spec §10.1).
 * Mirrors the jsonb `kind` field the RPC returns.
 */
type GrantBookingApprovalResult =
  | { kind: 'non_booking_approved'; approval_id: string; target_entity_type: string }
  | { kind: 'already_responded'; approval_id: string; prior_status: string }
  | { kind: 'partial_approved'; approval_id: string; remaining: number }
  | {
      kind: 'resolved';
      approval_id: string;
      booking_id: string;
      final_decision: 'approved' | 'rejected';
      new_status: 'confirmed' | 'cancelled';
      slots_transitioned: number;
      booking_transitioned: boolean;
      setup_emit: { emitted_count: number; skipped_cancelled?: number; skipped_no_args?: number; reason?: string };
    };

/**
 * Possible outcomes of `grant_ticket_approval` (00356 / spec §3.5).
 * Mirrors the jsonb `kind` field the RPC returns. Parallel to
 * GrantBookingApprovalResult but distinct on the post-grant automation
 * flags (sla_started / workflow_started / routing_evaluation_emitted)
 * instead of slot/booking transitions.
 *
 * B.2.A.Step10 reland §3.5.
 */
type GrantTicketApprovalResult =
  | { kind: 'non_ticket_approved'; approval_id: string; target_entity_type: string }
  | {
      kind: 'already_responded';
      approval_id: string;
      ticket_id: string;
      prior_status: string;
    }
  | {
      kind: 'partial_approved';
      approval_id: string;
      ticket_id: string;
      ticket_status: string | null;
      ticket_status_category: string;
      sla_started: false;
      workflow_started: false;
      routing_evaluation_emitted: false;
      remaining: number;
    }
  | {
      kind: 'resolved';
      approval_id: string;
      ticket_id: string;
      final_decision: 'approved' | 'rejected';
      ticket_status: string;
      ticket_status_category: string;
      sla_started: boolean;
      workflow_started: boolean;
      routing_evaluation_emitted: boolean;
    };

/**
 * `respond` return shape — pre-cutover this was the post-CAS approvals
 * row. Post-cutover the booking branch returns the RPC's structured
 * outcome (one of the four `kind` shapes above). The ticket branch
 * (B.2.A.Step10 reland) does the same with GrantTicketApprovalResult.
 * The visitor_invite branch still returns the approvals row.
 */
type RespondReturn =
  | ApprovalRow
  | GrantBookingApprovalResult
  | GrantTicketApprovalResult;

@Injectable()
export class ApprovalService {
  constructor(
    private readonly supabase: SupabaseService,
    // TicketService is no longer called from approval.service after the
    // B.2.A.Step10 reland cutover (the `grant_ticket_approval` RPC at
    // 00356 subsumes TicketService.onApprovalDecision's effects
    // atomically). The DI wiring stays for module-load compatibility
    // with the existing forwardRef graph (TicketModule imports
    // ApprovalModule and vice versa); we void the field below until a
    // future refactor removes it from this constructor.
    @Inject(forwardRef(() => TicketService)) private readonly ticketService: TicketService,
    @Inject(forwardRef(() => BookingNotificationsService))
    private readonly bookingNotifications: BookingNotificationsService,
    // BundleService is no longer called from approval.service after the
    // B.0.D.3 cutover (the `grant_booking_approval` RPC subsumes
    // BundleService.onApprovalDecided's effects atomically). The DI
    // wiring stays for `attachServicesToBooking` which other modules
    // call directly; we void the field below to satisfy noUnusedLocals
    // until a future refactor removes it from this constructor.
    @Inject(forwardRef(() => BundleService))
    private readonly bundleService: BundleService,
    // VisitorService — slice 3 wiring for `target_entity_type='visitor_invite'`.
    // forwardRef both at the module-import side and here at the constructor
    // side because VisitorsModule already imports ApprovalModule (the
    // InvitationService writes the approvals row at invite time).
    @Inject(forwardRef(() => VisitorService))
    private readonly visitorService: VisitorService,
  ) {
    // Kept on the class for DI compatibility — see comments above.
    void this.bundleService;
    void this.ticketService;
  }

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
   *
   * B.0.D.3 cutover (spec §10.1): for `target_entity_type='booking'` this
   * method is now a planner/dispatcher. State validation + auth gate runs
   * in TS, then the atomic `grant_booking_approval` RPC commits the
   * approval CAS update + slot/booking transitions + setup-WO outbox
   * emit in ONE transaction. The previous five-HTTP-call sequence
   * (approval row UPDATE → booking_slots UPDATE → bookings UPDATE →
   * bundle cascade claim RPC → trigger emit) was the headline lie the
   * v6 spec called out: there was no transaction wrapping those, so a
   * mid-flow crash left the approval row `approved` while slots stayed
   * `pending_approval`. Now: one atomic boundary.
   *
   * Notifications fan-out (BookingNotificationsService.onApprovalDecided)
   * stays in TS post-RPC — that's a vendor email call which can take
   * seconds and shouldn't extend the booking-level advisory lock.
   *
   * Ticket and visitor_invite branches keep their existing TS-orchestrated
   * paths because their downstream effects don't have a multi-row
   * transition to coordinate atomically.
   */
  async respond(
    approvalId: string,
    dto: RespondDto,
    respondingPersonId: string,
    respondingUserId?: string,
    clientRequestId?: string,
  ) {
    const tenant = TenantContext.current();

    const { data: approval, error: findError } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('id', approvalId)
      .eq('tenant_id', tenant.id)
      .single();

    if (findError || !approval) throw AppErrors.notFound('approval', approvalId);
    if (approval.status !== 'pending') throw AppErrors.conflict('approval.already_responded', { detail: 'Approval already responded to' });

    // Authorization: caller must be a permitted approver for this row.
    const allowed = await this.callerCanRespond(approval, respondingPersonId, respondingUserId);
    if (!allowed) {
      throw AppErrors.forbidden('approval.not_an_approver', 'You are not an approver for this request');
    }

    // ── Booking branch — B.0.D.3 cutover to grant_booking_approval RPC ──
    if (approval.target_entity_type === 'booking') {
      return this.grantBookingApproval(
        approval as ApprovalRow,
        dto,
        respondingPersonId,
        respondingUserId,
        clientRequestId,
      );
    }

    // ── Ticket branch — B.2.A.Step10 reland cutover to grant_ticket_approval RPC ──
    //
    // Spec §3.5 / migration 00356. Replaces the pre-reland multi-step write
    // sequence (approvals CAS → domain_events → tickets UPDATE → activity
    // → optional post-grant automation via TicketService.onApprovalDecision
    // → TicketService.runPostCreateAutomation) with a single atomic RPC.
    // The RPC also handles chain / parallel-group resolution + emits the
    // three post-grant automation outbox events (sla / routing / workflow)
    // when the chain fully resolves with approved. Handlers
    // (SlaTimerHandler / RoutingEvaluationHandler / WorkflowStartHandler)
    // were shipped in Step 11 / Step 12 — events drain cleanly post-cutover.
    // See grantTicketApproval() below for the full RPC outcome mapping.
    if (approval.target_entity_type === 'ticket') {
      return this.grantTicketApproval(
        approval as ApprovalRow,
        dto,
        respondingPersonId,
        respondingUserId,
        clientRequestId,
      );
    }

    // ── visitor_invite branch — unchanged ──
    //
    // The approval row CAS update + downstream dispatch stay in TS for
    // visitor_invites because their downstream effects
    // (VisitorService.onApprovalDecided) are individually atomic per-row.
    // Spec §3.5 covers only the ticket branch in this step.

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
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw AppErrors.conflict('approval.already_responded', { detail: 'Approval already responded to' });

    await this.logDomainEvent(approval.target_entity_id, `approval_${dto.status}`, {
      approval_id: approvalId,
      responded_by: respondingPersonId,
    });

    // For sequential chains: if approved, check if next step should activate
    if (dto.status === 'approved' && approval.approval_chain_id) {
      await this.advanceChain(approval.approval_chain_id, approval.step_number);
    }

    // B.2.A.Step10 reland — the ticket branch is routed through
    // grantTicketApproval() above; this fallthrough only handles
    // visitor_invite (and the defensive `else` for any future
    // target_entity_type the cutover doesn't yet cover).
    //
    // Pre-reland this block called `TicketService.onApprovalDecision`
    // which fanned into `runPostCreateAutomation` for routing + SLA +
    // workflow. That work is now committed atomically by the RPC at
    // 00356 + drained by the §3.9.3 handlers post-commit.

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
          throw AppErrors.validationFailed('approval.responding_user_required', {
            detail: 'respondingUserId is required for visitor_invite approval dispatch',
          });
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
   * B.2.A.Step10 reland — ticket-target approval grant. Calls the
   * atomic `grant_ticket_approval` RPC (00356 / spec §3.5) which:
   *   - Locks the approval row (advisory + FOR UPDATE).
   *   - Resolves p_actor_user_id (auth_uid) → users.id ONCE for the
   *     audit-row writes (F-CRIT-1 mirror, DRIFT 2 in the migration).
   *   - Validates target_entity_type='ticket' + status='pending'.
   *   - Applies the CAS update on the approval row.
   *   - Resolves chain / parallel-group decision (partial_approved
   *     short-circuit when peer approvals remain in the non-terminal
   *     set {pending, delegated} — DRIFT 1 in the migration).
   *   - Transitions the ticket: rejected → status='rejected',
   *     status_category='closed', closed_at=now(); approved →
   *     status='new', status_category='new'.
   *   - INSERTs ticket_activities + domain_events.
   *   - On approve + fully resolved, emits three outbox events
   *     (conditional on the ticket carrying the relevant FK):
   *     sla.timer_recompute_required with started_at=now() (spec line
   *     2279 — customer waited for approval, SLA clock starts at grant
   *     time; DRIFT 3), routing.evaluation_required (always),
   *     workflow.start_required (when ticket.workflow_id non-null).
   *
   * All of the above commits in one Postgres transaction. Pre-reland
   * each step was a separate HTTP call; a mid-flow crash could leave
   * the approval row decided but the ticket still in pending_approval
   * with no path forward (§1.3 + §1.19 critical severity).
   *
   * Possible RPC outcomes (jsonb `kind` field):
   *   - 'non_ticket_approved' — defensive (caller routed a non-ticket
   *     approval to this method; the RPC bails out cleanly without
   *     mutating). We surface as 400 with
   *     `grant_ticket_approval.invalid_target_entity_type`.
   *   - 'already_responded' — race: another caller decided between
   *     the read-side check + this RPC's lock. Returns 409 with the
   *     existing `approval.already_responded` code so the FE renders
   *     the pre-cutover message.
   *   - 'partial_approved' — multi-step chain or parallel group; this
   *     approver's decision committed but peers are still in the
   *     non-terminal set. Returned to the caller as-is.
   *   - 'resolved' — final decision committed; ticket transitioned;
   *     post-grant automation outbox events emitted as applicable.
   *
   * **Handler chain (Step 11 + Step 12).** The three outbox events
   * emitted by this RPC drain through:
   *   - sla.timer_recompute_required → SlaTimerHandler (Step 12 C2,
   *     apps/api/src/modules/outbox/handlers/sla-timer-recompute.handler.ts).
   *   - routing.evaluation_required → RoutingEvaluationHandler
   *     (Step 11 C1, routing-evaluation.handler.ts).
   *   - workflow.start_required → WorkflowStartHandler (Step 12 C2,
   *     workflow-start.handler.ts).
   *
   * Post-RPC best-effort: none. Notifications fan-out for ticket
   * approvals lives downstream of the routing/workflow handlers, not
   * here.
   */
  private async grantTicketApproval(
    approval: ApprovalRow,
    dto: RespondDto,
    respondingPersonId: string,
    respondingUserId: string | undefined,
    clientRequestId: string | undefined,
  ): Promise<RespondReturn> {
    const tenant = TenantContext.current();
    // clientRequestId is enforced at the HTTP boundary by
    // RequireClientRequestIdGuard. Internal callers (none today; the
    // only call-site is the controller) would have to supply one.
    // Fall back to a random uuid so the key is well-formed for any
    // future internal caller, but keep the explicit guard at the
    // controller layer so the typical retry-coalescing contract
    // remains client-driven.
    const idempotencyKey = buildApprovalGrantIdempotencyKey(
      approval.id,
      clientRequestId ?? randomUUID(),
    );

    const { data, error } = await this.supabase.admin.rpc('grant_ticket_approval', {
      p_approval_id:     approval.id,
      p_tenant_id:       tenant.id,
      p_actor_user_id:   respondingUserId ?? null,
      p_decision:        dto.status,
      p_comments:        dto.comments ?? null,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      // The new RPC raises structured codes (grant_ticket_approval.*)
      // mapped through mapRpcErrorToAppError → AppError with the right
      // HTTP status. Fallback for catastrophic / unmapped failures
      // routes to approval.grant_failed to preserve the existing 500
      // shape. CODEX-B-1: the helper strips the SQL raise tail for
      // registered codes — no detail leak.
      throw mapRpcErrorToAppError(error, { fallbackCode: 'approval.grant_failed' });
    }

    const result = (data ?? null) as GrantTicketApprovalResult | null;
    if (!result) {
      // Defensive: the RPC always returns a jsonb result; null means a
      // protocol-level failure. Server-class error so the renderer
      // surfaces the trace ID for support triage.
      throw AppErrors.server('approval.grant_failed');
    }

    // Race / no-op outcomes — surface as a conflict so the pre-cutover
    // UX is preserved (the FE renders "Approval already responded to").
    if (result.kind === 'already_responded') {
      throw AppErrors.conflict('approval.already_responded');
    }
    if (result.kind === 'non_ticket_approved') {
      // Defensive — should not happen because respond() routed only
      // ticket-targets here. If it does, an admin re-typed an approval
      // row and the RPC bailed out cleanly without mutating.
      throw AppErrors.validationFailed('grant_ticket_approval.invalid_target_entity_type');
    }

    // Surface the RPC's structured outcome to the caller. The pre-
    // cutover return shape was the post-CAS approvals row — callers
    // didn't actually read most fields. The new shape exposes the
    // RPC's `kind` + decision metadata.
    void respondingPersonId;
    return result;
  }

  /**
   * B.0.D.3 — booking-target approval grant. Calls the atomic
   * `grant_booking_approval` RPC (00310 / spec §10.1) which:
   *   - Locks the approval row (advisory + FOR UPDATE)
   *   - Validates target_entity_type='booking' + status='pending'
   *   - Applies the CAS update on the approval row
   *   - Resolves booking-level decision (parallel/sequential semantics)
   *   - Transitions booking_slots + bookings status from
   *     pending_approval → confirmed | cancelled
   *   - Expires sibling pending approvals on rejection
   *   - Emits setup_work_order.create_required outbox events for
   *     non-cancelled OLIs (calls approve_booking_setup_trigger
   *     internally via PERFORM — same tx)
   *   - Inserts a domain_events row for the approval decision
   * All in one Postgres transaction. If any step fails, the whole tx
   * rolls back; the user sees a 4xx/5xx and the approval row stays
   * pending — no four-way state divergence.
   *
   * Possible RPC outcomes (jsonb `kind` field):
   *   - 'non_booking_approved' — defensive (we already filtered on
   *     target_entity_type='booking' in respond(), but the RPC
   *     re-checks).
   *   - 'already_responded' — race: another caller decided between our
   *     read and the RPC's lock. We map to BadRequestException with
   *     the existing 'Approval already responded to' message so the
   *     UX matches the pre-cutover behavior.
   *   - 'partial_approved' — multi-approver bundle, this approver's
   *     decision committed but more peers' decisions are still pending.
   *     Return as-is to the controller (the frontend renders "thanks,
   *     waiting on others"; was the same pre-cutover via the
   *     handleBookingApprovalDecided early return).
   *   - 'resolved' — final-decision committed; slots + bookings flipped.
   *
   * Post-RPC best-effort:
   *   - BookingNotificationsService.onApprovalDecided fan-out (the
   *     requester email) runs in TS so it doesn't hold the
   *     booking-level advisory lock during a vendor email round-trip.
   *     A failure here does NOT roll the approval back — the user has
   *     already seen success in their queue.
   */
  private async grantBookingApproval(
    approval: ApprovalRow,
    dto: RespondDto,
    respondingPersonId: string,
    respondingUserId: string | undefined,
    clientRequestId: string | undefined,
  ): Promise<RespondReturn> {
    const tenant = TenantContext.current();
    const idempotencyKey = `approval.grant:${approval.id}:${clientRequestId ?? randomUUID()}`;

    const { data, error } = await this.supabase.admin.rpc('grant_booking_approval', {
      p_approval_id: approval.id,
      p_tenant_id: tenant.id,
      p_actor_user_id: respondingUserId ?? null,
      p_decision: dto.status,
      p_comments: dto.comments ?? null,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      throw this.mapGrantBookingApprovalError(error);
    }

    const result = (data ?? null) as GrantBookingApprovalResult | null;
    if (!result) {
      throw AppErrors.server('approval.grant_failed', {
        detail: 'grant_booking_approval RPC returned no result',
      });
    }

    // Race / no-op outcomes — surface as a BadRequestException so the
    // pre-cutover UX is preserved (the FE already renders
    // "Approval already responded to" for this case).
    if (result.kind === 'already_responded') {
      throw AppErrors.conflict('approval.already_responded', { detail: 'Approval already responded to' });
    }
    if (result.kind === 'non_booking_approved') {
      // Defensive — should not happen because respond() routed only
      // booking-targets here. If it does, an admin re-typed an
      // approval row and the RPC bailed out cleanly.
      throw AppErrors.validationFailed('approval.non_booking_approved', {
        detail: 'Cannot grant approval on non-booking target via this path.',
      });
    }

    // ── Post-RPC best-effort: notification fan-out ─────────────────────
    //
    // The RPC has already committed the booking + slots + setup-WO
    // emit. Failure of the notification doesn't roll the grant back.
    if (result.kind === 'resolved') {
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
            result.final_decision,
            dto.comments ?? undefined,
          );
        }
      } catch (err) {
        console.error('[approval] booking notification fan-out failed', err);
      }
    }

    // Surface the RPC's structured outcome to the caller. The pre-
    // cutover return shape was the post-CAS approvals row — callers
    // didn't actually read most fields. The new shape exposes the
    // RPC's `kind` + decision metadata which is more useful.
    void respondingPersonId;
    return result as unknown as RespondReturn;
  }

  /**
   * Map a `grant_booking_approval` RPC error to a Nest HTTP exception.
   * Spec §10.1 + 00310 migration error sites.
   */
  private mapGrantBookingApprovalError(rpcError: { code?: string; message?: string }): Error {
    const message = rpcError.message ?? '';

    // approval.not_found — would mean the approval row was deleted
    // between our pre-RPC read and the RPC's FOR UPDATE select. Rare
    // but possible. Map to NotFoundException so it surfaces consistently.
    if (message.includes('approval.not_found')) {
      return AppErrors.notFoundWithCode('approval.not_found', 'Approval not found');
    }

    // approval.cas_lost — the RPC's CAS update missed despite the
    // advisory lock + FOR UPDATE. The 00310 migration's hint says
    // "investigate concurrent path" — this is a bug in the lock code,
    // not a normal user race. Surface as 500 + log.
    if (message.includes('approval.cas_lost')) {
      console.error('[approval] grant_booking_approval cas_lost — concurrent grant raced past lock', rpcError);
      return AppErrors.conflict('approval.cas_lost', {
        detail: 'Approval state changed during grant attempt — please retry.',
      });
    }

    // p_decision validation — defensive (we control dto.status; the RPC
    // raises only if a future caller passes garbage).
    if (message.includes('p_decision must be approved or rejected')) {
      return AppErrors.validationFailed('approval.invalid_decision', {
        detail: 'Decision must be approved or rejected.',
      });
    }

    // Catch-all — the RPC's `raise exception` path with no recognised
    // structured prefix. Preserve the message for ops triage but
    // surface as 500 with a stable code.
    console.error('[approval] grant_booking_approval unexpected error:', rpcError);
    return AppErrors.server('approval.grant_failed', {
      detail: message || 'Approval grant failed unexpectedly.',
    });
  }

  // B.0.D.3 — `handleBookingApprovalDecided` + `areAllTargetApprovalsApproved`
  // were retired in this commit. Their multi-step write sequence (approvals
  // CAS → booking_slots → bookings → bundle cascade) was the headline lie
  // the v6 spec called out: there was no transaction wrapping those, so a
  // mid-flow crash left the four-way state diverged. The atomic
  // `grant_booking_approval` RPC (00310 / spec §10.1) replaces all of it
  // in one Postgres transaction:
  //
  //   - All-resolved gate (the helper's job) is the
  //     `select count(*) filter (where status in ('pending','rejected'))`
  //     check at the top of the RPC's `else` branch (00310 lines 167-180).
  //   - `expired` counting as resolved follows from the count's filter
  //     not including 'expired' — same semantics, now in SQL.
  //   - Slot + booking transitions happen in steps 6 (00310 lines 196-213).
  //   - Bundle cascade is subsumed by step 7 (00310 lines 215-244): the
  //     setup_work_order outbox emit (via `approve_booking_setup_trigger`
  //     called inline) replaces what `BundleService.onApprovalDecided`
  //     used to do.
  //
  // The `BundleService.onApprovalDecided` method itself stays (B.0.D.4
  // refactors its body to call the new RPC, not retire the method).

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
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('approvals')
      .select('status')
      .eq('approval_chain_id', chainId)
      .eq('tenant_id', tenant.id);

    if (!data || data.length === 0) return false;
    return data.every((a) => a.status === 'approved');
  }

  private async advanceChain(chainId: string, _completedStep: number) {
    const tenant = TenantContext.current();
    // Check if any steps in the chain were rejected
    const { data: chainSteps } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('approval_chain_id', chainId)
      .eq('tenant_id', tenant.id)
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
