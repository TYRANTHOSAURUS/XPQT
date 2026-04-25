import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import { ConflictGuardService } from './conflict-guard.service';
import type {
  ActorContext, CreateReservationInput, PolicySnapshot, Reservation,
} from './dto/types';

/**
 * BookingFlowService — the canonical create-a-reservation pipeline.
 *
 * This is the only path that should write to `reservations`. The portal,
 * desk scheduler, calendar-sync intercept, and recurrence materialiser all
 * funnel through here.
 *
 * Pipeline (matches docs/room-booking.md):
 *   1. Load + verify the space (active, reservable)
 *   2. Snapshot buffers/check-in/cost from the space
 *   3. Apply same-requester back-to-back buffer collapse
 *   4. Resolve booking rules via RuleResolverService
 *   5. Handle deny / require_approval / override
 *   6. Compute status + policy_snapshot
 *   7. INSERT — exclusion constraint catches concurrent races (23P01)
 *   8. Fan out side effects (approval row creation; event emission;
 *      notifications + calendar sync are TODOs wired in Phase J / H)
 */
@Injectable()
export class BookingFlowService {
  private readonly log = new Logger(BookingFlowService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conflict: ConflictGuardService,
    private readonly ruleResolver: RuleResolverService,
  ) {}

  /**
   * Run the full pipeline and return a reservation row, or throw with a
   * structured error that the controller maps to an HTTP response.
   *
   * Errors:
   *   - 403 'rule_deny' — a deny rule fired and the actor cannot override
   *   - 409 'reservation_slot_conflict' — the conflict guard rejected; alternatives
   *     are populated in the error body via picker integration (TODO when picker lands)
   *   - 400 'invalid_input' — basic validation failures
   */
  async create(input: CreateReservationInput, actor: ActorContext): Promise<Reservation> {
    this.assertValid(input);
    const tenantId = TenantContext.current().id;

    // 1+2. Load space + snapshot
    const space = await this.loadSpace(input.space_id);

    // 3. Buffer collapse for same-requester back-to-back
    const buffers = await this.conflict.snapshotBuffersForBooking({
      space_id: input.space_id,
      requester_person_id: input.requester_person_id,
      start_at: input.start_at,
      end_at: input.end_at,
      room_setup_buffer_minutes: space.setup_buffer_minutes ?? 0,
      room_teardown_buffer_minutes: space.teardown_buffer_minutes ?? 0,
    });

    // 4. Resolve rules
    const ruleOutcome = await this.ruleResolver.resolve({
      requester_person_id: input.requester_person_id,
      space_id: input.space_id,
      start_at: input.start_at,
      end_at: input.end_at,
      attendee_count: input.attendee_count ?? null,
      criteria: {},
    });

    // 5. Deny handling — service desk override gated by permission + reason
    if (ruleOutcome.final === 'deny') {
      const canOverride = actor.has_override_rules && ruleOutcome.overridable;
      if (!canOverride) {
        throw new ForbiddenException({
          code: 'rule_deny',
          message: ruleOutcome.denialMessages[0] || 'Booking denied by booking rules.',
          denial_messages: ruleOutcome.denialMessages,
          matched_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
        });
      }
      if (!actor.override_reason) {
        throw new BadRequestException({
          code: 'override_reason_required',
          message: 'Service-desk override requires a reason.',
        });
      }
      this.log.warn(`Override applied by user=${actor.user_id} reason="${actor.override_reason}" rules=${
        ruleOutcome.matchedRules.map((r) => r.id).join(',')}`);
    }

    // 6. Status + policy_snapshot
    const status =
      ruleOutcome.final === 'require_approval' ? 'pending_approval' :
      'confirmed';

    const policySnapshot: PolicySnapshot = {
      matched_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
      effects_seen: ruleOutcome.effects,
      buffers_collapsed_for_back_to_back:
        buffers.setup_buffer_minutes !== (space.setup_buffer_minutes ?? 0) ||
        buffers.teardown_buffer_minutes !== (space.teardown_buffer_minutes ?? 0),
      source_room_check_in_required: space.check_in_required ?? false,
      source_room_setup_buffer_minutes: space.setup_buffer_minutes ?? 0,
      source_room_teardown_buffer_minutes: space.teardown_buffer_minutes ?? 0,
      rule_evaluations: ruleOutcome.matchedRules.map((r) => ({
        rule_id: r.id,
        matched: true,
        effect: r.effect,
        denial_message: r.denial_message ?? undefined,
      })),
    };

    // Cost snapshot
    const costAmount = this.computeCost(space, input);

    // 7. INSERT
    const insertRow = {
      tenant_id: tenantId,
      reservation_type: input.reservation_type ?? 'room',
      space_id: input.space_id,
      requester_person_id: input.requester_person_id,
      host_person_id: input.host_person_id ?? null,
      start_at: input.start_at,
      end_at: input.end_at,
      attendee_count: input.attendee_count ?? null,
      attendee_person_ids: input.attendee_person_ids ?? [],
      status,
      recurrence_rule: input.recurrence_rule ?? null,
      recurrence_series_id: input.recurrence_series_id ?? null,
      recurrence_master_id: input.recurrence_master_id ?? null,
      recurrence_index: input.recurrence_index ?? null,
      setup_buffer_minutes: buffers.setup_buffer_minutes,
      teardown_buffer_minutes: buffers.teardown_buffer_minutes,
      check_in_required: space.check_in_required ?? false,
      check_in_grace_minutes: space.check_in_grace_minutes ?? 15,
      policy_snapshot: policySnapshot,
      applied_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
      source: input.source ?? 'portal',
      booked_by_user_id: actor.user_id,
      cost_amount_snapshot: costAmount,
      multi_room_group_id: input.multi_room_group_id ?? null,
      booking_bundle_id: input.booking_bundle_id ?? null,
    };

    const { data, error } = await this.supabase.admin
      .from('reservations')
      .insert(insertRow)
      .select('*')
      .single();

    if (error) {
      if (this.conflict.isExclusionViolation(error)) {
        // Look up the conflicting rows + (TODO) ask picker for alternatives.
        const conflicts = await this.conflict.preCheck({
          space_id: input.space_id,
          effective_start_at: this.subtractMinutes(input.start_at, buffers.setup_buffer_minutes),
          effective_end_at: this.addMinutes(input.end_at, buffers.teardown_buffer_minutes),
        });
        throw new ConflictException({
          code: 'reservation_slot_conflict',
          message: 'Just booked — pick another slot.',
          conflicts: conflicts.map((c) => ({ id: c.id, start_at: c.start_at, end_at: c.end_at })),
        });
      }
      this.log.error(`reservation insert failed: ${error.message}`);
      throw new BadRequestException({ code: 'insert_failed', message: error.message });
    }

    // 8. Fan out side effects (best-effort)
    // - Approval row creation (when require_approval)
    if (status === 'pending_approval' && ruleOutcome.approvalConfig) {
      await this.createApprovalRows(data.id, ruleOutcome.approvalConfig, tenantId);
    }
    // TODO(phase-J): emit reservation.created + notify
    // TODO(phase-H): enqueue outlook calendar push (uses calendar-sync adapter)

    return data as unknown as Reservation;
  }

  /**
   * Same pipeline but no write — used by the picker preview, the desk
   * scheduler cell tagging, and the calendar-sync intercept "would this
   * booking be allowed?" check.
   */
  async dryRun(input: CreateReservationInput, actor: ActorContext): Promise<{
    outcome: 'allow' | 'deny' | 'require_approval' | 'warn';
    final_status_if_created: 'confirmed' | 'pending_approval';
    denial_message: string | null;
    warnings: string[];
    matched_rule_ids: string[];
    overridable: boolean;
  }> {
    this.assertValid(input);

    const ruleOutcome = await this.ruleResolver.resolve({
      requester_person_id: input.requester_person_id,
      space_id: input.space_id,
      start_at: input.start_at,
      end_at: input.end_at,
      attendee_count: input.attendee_count ?? null,
      criteria: {},
    });

    return {
      outcome:
        ruleOutcome.final === 'deny' && !(actor.has_override_rules && ruleOutcome.overridable)
          ? 'deny'
          : ruleOutcome.warnings.length && ruleOutcome.final === 'allow'
            ? 'warn'
            : ruleOutcome.final,
      final_status_if_created: ruleOutcome.final === 'require_approval' ? 'pending_approval' : 'confirmed',
      denial_message: ruleOutcome.denialMessages[0] ?? null,
      warnings: ruleOutcome.warnings,
      matched_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
      overridable: ruleOutcome.overridable,
    };
  }

  // === helpers ===

  private assertValid(input: CreateReservationInput): void {
    if (!input.space_id || !input.requester_person_id) {
      throw new BadRequestException({ code: 'invalid_input', message: 'space_id and requester_person_id required' });
    }
    const start = new Date(input.start_at).getTime();
    const end = new Date(input.end_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new BadRequestException({ code: 'invalid_input', message: 'invalid dates' });
    }
    if (end <= start) {
      throw new BadRequestException({ code: 'invalid_input', message: 'end_at must be after start_at' });
    }
  }

  private async loadSpace(spaceId: string): Promise<{
    id: string;
    type: string;
    reservable: boolean;
    capacity: number | null;
    setup_buffer_minutes: number | null;
    teardown_buffer_minutes: number | null;
    check_in_required: boolean | null;
    check_in_grace_minutes: number | null;
    cost_per_hour: string | null;
  }> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('id, type, reservable, capacity, setup_buffer_minutes, teardown_buffer_minutes, check_in_required, check_in_grace_minutes, cost_per_hour, active')
      .eq('tenant_id', tenantId)
      .eq('id', spaceId)
      .maybeSingle();
    if (error || !data) throw new NotFoundException({ code: 'space_not_found' });
    if (!(data as { active: boolean }).active) throw new BadRequestException({ code: 'space_inactive' });
    if (!(data as { reservable: boolean }).reservable) {
      throw new BadRequestException({ code: 'space_not_reservable' });
    }
    return data as never;
  }

  private computeCost(space: { cost_per_hour: string | null }, input: CreateReservationInput): string | null {
    if (!space.cost_per_hour) return null;
    const minutes = (new Date(input.end_at).getTime() - new Date(input.start_at).getTime()) / 60000;
    const cost = (Number(space.cost_per_hour) * minutes) / 60;
    return cost.toFixed(2);
  }

  /**
   * Create approvals rows from rule's approval_config.
   * Single-step or parallel/sequential are honoured by `threshold`.
   */
  private async createApprovalRows(
    reservationId: string,
    config: { required_approvers?: Array<{ type: 'team' | 'person'; id: string }>; threshold?: 'all' | 'any' },
    tenantId: string,
  ): Promise<void> {
    const approvers = config.required_approvers ?? [];
    if (approvers.length === 0) return;
    const parallelGroup = config.threshold === 'all' ? `parallel-${reservationId}` : null;

    const rows = approvers.map((a) => ({
      tenant_id: tenantId,
      target_entity_type: 'reservation',
      target_entity_id: reservationId,
      parallel_group: parallelGroup,
      approver_person_id: a.type === 'person' ? a.id : null,
      approver_team_id: a.type === 'team' ? a.id : null,
      status: 'pending',
    }));

    const { error } = await this.supabase.admin.from('approvals').insert(rows);
    if (error) this.log.warn(`approval rows insert failed for reservation=${reservationId}: ${error.message}`);
  }

  private addMinutes(iso: string, minutes: number): string {
    return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
  }
  private subtractMinutes(iso: string, minutes: number): string {
    return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
  }
}
