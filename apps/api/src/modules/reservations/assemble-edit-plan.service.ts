/**
 * B.4 step 2D-C — `AssembleEditPlanService`.
 *
 * Builds the `EditPlan` jsonb the `edit_booking` RPC consumes
 * (supabase/migrations/00364_edit_booking_rpc_v4.sql:200-308 contract;
 * spec docs/follow-ups/b4-booking-edit-pipeline.md §3.3).
 *
 * Step 2D-D (TS editSlot cutover) will be the first caller.
 *
 * Pipeline mirrors §3.3:
 *   1. Load current booking + slots (FOR UPDATE happens inside the RPC,
 *      not here — this read just snapshots the pre-patch state for
 *      diffing + rule resolution).
 *   2. Apply patch → target state.
 *   3. loadSpace(target_space_id) — tenant-scoped via
 *      BookingFlowService.loadSpace (booking-flow.service.ts:1222 —
 *      newly exposed in this step's C1 commit).
 *   4. RuleResolverService.resolve for OLD state → old_outcome,
 *      old chain config.
 *   5. RuleResolverService.resolve for NEW state → new_outcome,
 *      new chain config + matched rule ids + policy snapshot.
 *   6. ConflictGuardService.snapshotBuffersForBooking for the target
 *      slot (excluding the slot being edited so back-to-back-with-self
 *      doesn't false-collapse).
 *   7. computeCostFromHours from the target room's cost_per_hour.
 *   8. loadCurrentApprovalChain → compare to new outcome's chain via
 *      chainConfigsEqual → chain_config_changed boolean.
 *   9. Assemble EditPlan jsonb (00364:248-308 contract).
 *
 * Step 2D-C deliberately DEFERS:
 *   - asset_reservation_patches  → Step 2E/2F (linked-row edits).
 *   - order_patches              → Step 2E/2F.
 *   - work_order_sla_patches     → Step 2E/2F.
 *   - recurrence fanout          → Step 2F (editScope).
 *
 * For a geometry-only editSlot patch, those arrays are empty / absent —
 * which 00364 admits via `coalesce(..., '[]'::jsonb)` at :319-321.
 *
 * Citation discipline: every method, column, file path, line number
 * referenced in this file was Read in this session. Re-read before
 * editing.
 */

import { Injectable } from '@nestjs/common';
import { AppErrors } from '../../common/errors';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { ConflictGuardService } from './conflict-guard.service';
import { BookingFlowService } from './booking-flow.service';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import {
  chainConfigsEqual,
  computeCostFromHours,
  loadCurrentApprovalChain,
} from './edit-plan-helpers';
import type {
  EditPlan,
  EditPlanApproval,
  EditPlanApprovalChainConfig,
  EditPlanSlotPatch,
} from './edit-plan.types';
import type { ApprovalConfig } from '../room-booking-rules/dto';

/**
 * Input shape for `assembleEditPlan`. Step 2D-C narrows the patch to
 * geometry-only fields needed by editSlot; Step 2E/2F will widen it
 * (host_person_id, recurrence_overridden, etc.) without breaking
 * existing callers because every new field is optional.
 */
export interface AssembleEditPlanArgs {
  bookingId: string;
  tenantId: string;
  /** Identity of the slot being edited. For multi-slot bookings the
   * caller picks one; Step 2F will fan out to all slots in scope. */
  slotId: string;
  /** Patch fields. Any field omitted preserves the current slot/booking
   * value. */
  patch: {
    /** Target room. When omitted, the slot's current space is reused. */
    space_id?: string;
    start_at?: string;
    end_at?: string;
    attendee_count?: number | null;
    attendee_person_ids?: string[];
    // Booking-level fields (deferred; Step 2E will surface them).
    // host_person_id?: string | null;
    // recurrence_overridden?: boolean;
  };
}

/**
 * Internal target-state digest used during plan assembly. Mirrors the
 * shape the RPC will see in the booking-patch + the resolved slot row.
 */
interface TargetState {
  spaceId: string;
  startAt: string;
  endAt: string;
  attendeeCount: number | null;
  attendeePersonIds: string[];
  requesterPersonId: string;
}

@Injectable()
export class AssembleEditPlanService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly bookingFlow: BookingFlowService,
    private readonly ruleResolver: RuleResolverService,
    private readonly conflict: ConflictGuardService,
  ) {}

  /**
   * Build the EditPlan for `edit_booking` to consume. Throws AppError
   * on missing booking / missing slot / cross-tenant attempts. The RPC
   * (00364) handles its own gates (idempotency, stale-resolution,
   * tenant-validate every FK, approval reconciliation) — this builder's
   * job is to compute the contract-shape jsonb the RPC trusts.
   */
  async assembleEditPlan(args: AssembleEditPlanArgs): Promise<EditPlan> {
    // Snapshot the resolution timestamp ONCE, BEFORE any rule reads, so
    // the stale-resolution gate (00364:432-454) sees a coherent value.
    const resolutionAt = new Date().toISOString();

    // ── 1. Load current booking + the target slot ────────────────────
    const { booking, slot } = await this.loadBookingAndSlot(args.bookingId, args.slotId, args.tenantId);

    // ── 2. Apply patch → target state ────────────────────────────────
    const target: TargetState = {
      spaceId: args.patch.space_id ?? slot.space_id,
      startAt: args.patch.start_at ?? slot.start_at,
      endAt: args.patch.end_at ?? slot.end_at,
      attendeeCount: args.patch.attendee_count ?? slot.attendee_count,
      attendeePersonIds: args.patch.attendee_person_ids ?? slot.attendee_person_ids,
      requesterPersonId: booking.requester_person_id,
    };

    // ── 3. Load target space (validates active + reservable) ─────────
    const targetSpace = await this.bookingFlow.loadSpace(target.spaceId);

    // ── 4. Resolve rules for OLD state (current slot geometry) ───────
    const oldOutcome = await this.ruleResolver.resolve({
      requester_person_id: booking.requester_person_id,
      space_id: slot.space_id,
      start_at: slot.start_at,
      end_at: slot.end_at,
      attendee_count: slot.attendee_count ?? null,
      criteria: {},
    });

    // ── 5. Resolve rules for NEW state (target slot geometry) ────────
    const newOutcome = await this.ruleResolver.resolve({
      requester_person_id: booking.requester_person_id,
      space_id: target.spaceId,
      start_at: target.startAt,
      end_at: target.endAt,
      attendee_count: target.attendeeCount,
      criteria: {},
    });

    // ── 6. Snapshot buffers for the target slot ──────────────────────
    // exclude_ids includes the slot being edited so the slot's own
    // current geometry doesn't accidentally collapse a buffer with itself
    // when a same-room move overlaps the original window.
    const buffers = await this.conflict.snapshotBuffersForBooking({
      space_id: target.spaceId,
      requester_person_id: booking.requester_person_id,
      start_at: target.startAt,
      end_at: target.endAt,
      room_setup_buffer_minutes: targetSpace.setup_buffer_minutes ?? 0,
      room_teardown_buffer_minutes: targetSpace.teardown_buffer_minutes ?? 0,
      exclude_ids: [args.slotId],
    });

    // ── 7. Compute cost from target room's hourly rate ───────────────
    const newCostSnapshot = computeCostFromHours(
      targetSpace.cost_per_hour,
      target.startAt,
      target.endAt,
    );

    // ── 8. Load current chain + compare to new outcome's chain ───────
    // Per spec §3.6.5 paragraph "Chain identity": chain_config_changed is
    // a TS-COMPUTED boolean (the RPC trusts it). Comparison is
    // canonical-sorted on (type, id) via chainConfigsEqual.
    const currentChain = await loadCurrentApprovalChain(this.supabase, args.bookingId, args.tenantId);
    const newChainConfig = newOutcome.approvalConfig;

    const chainConfigChanged = !chainConfigsEqual(currentChain, newChainConfig);

    // ── 9. Derive old_outcome from current chain, new_outcome from rule resolver ──
    //
    // old_outcome: 'allow' if no chain attached to the booking today
    // (loadCurrentApprovalChain returned null), else 'require_approval'.
    // We never derive 'deny' for the OLD side — a denied booking would
    // not exist (create-time deny is a 422 / 403). If somehow a denied
    // booking row exists in the DB, the RPC's status='cancelled' guard
    // (00364:425-430) is the one that refuses the edit.
    const oldOutcomeForPlan: EditPlanApproval['old_outcome'] =
      currentChain === null ? 'allow' : 'require_approval';

    // new_outcome: pass-through from rule resolver. 'deny' triggers
    // Row 10 → RPC raises edit_booking.deny_on_edit (422) at 00364:567-572.
    const newOutcomeForPlan: EditPlanApproval['new_outcome'] = newOutcome.final;

    const approval: EditPlanApproval = {
      old_outcome: oldOutcomeForPlan,
      new_outcome: newOutcomeForPlan,
      chain_config_changed: chainConfigChanged,
      new_chain_config: this.shapeChainConfigForPlan(newChainConfig),
    };

    // ── 10. Assemble slot_patches ────────────────────────────────────
    const slotPatch: EditPlanSlotPatch = {
      slot_id: args.slotId,
      space_id: target.spaceId,
      start_at: target.startAt,
      end_at: target.endAt,
      setup_buffer_minutes: buffers.setup_buffer_minutes,
      teardown_buffer_minutes: buffers.teardown_buffer_minutes,
      attendee_count: target.attendeeCount,
      attendee_person_ids: target.attendeePersonIds,
    };

    // ── 11. Assemble booking-level patch ─────────────────────────────
    // location_id mirrors target.spaceId (single-slot edits anchor the
    // booking at the slot's space — same convention as create-time at
    // booking-flow.service.ts:259). For multi-slot bookings, Step 2E/2F
    // will compute MIN/MAX across all target slots.
    //
    // start_at / end_at: for single-slot, mirror the slot. Multi-slot
    // → MIN/MAX in Step 2F.
    //
    // policy_snapshot: rebuild from new outcome (mirrors create at
    // booking-flow.service.ts:193-208).
    const policySnapshot = {
      matched_rule_ids: newOutcome.matchedRules.map((r) => r.id),
      effects_seen: newOutcome.effects,
      buffers_collapsed_for_back_to_back:
        buffers.setup_buffer_minutes !== (targetSpace.setup_buffer_minutes ?? 0) ||
        buffers.teardown_buffer_minutes !== (targetSpace.teardown_buffer_minutes ?? 0),
      source_room_check_in_required: targetSpace.check_in_required ?? false,
      source_room_setup_buffer_minutes: targetSpace.setup_buffer_minutes ?? 0,
      source_room_teardown_buffer_minutes: targetSpace.teardown_buffer_minutes ?? 0,
      rule_evaluations: newOutcome.matchedRules.map((r) => ({
        rule_id: r.id,
        matched: true,
        effect: r.effect,
        denial_message: r.denial_message ?? undefined,
      })),
    };

    const plan: EditPlan = {
      booking: {
        location_id: target.spaceId,
        start_at: target.startAt,
        end_at: target.endAt,
        cost_amount_snapshot: newCostSnapshot,
        policy_snapshot: policySnapshot,
        applied_rule_ids: newOutcome.matchedRules.map((r) => r.id),
      },
      slot_patches: [slotPatch],
      // Step 2D-C scope: linked-row patches are empty.
      asset_reservation_patches: [],
      order_patches: [],
      work_order_sla_patches: [],
      _resolution_at: resolutionAt,
      approval,
    };

    return plan;
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Load the booking row + the named slot in two tenant-scoped reads.
   * Throws AppError if the booking doesn't exist or the slot doesn't
   * belong to this booking. Cross-tenant slots surface as not-found per
   * spec decision #6.1 (don't leak existence).
   */
  private async loadBookingAndSlot(
    bookingId: string,
    slotId: string,
    tenantId: string,
  ): Promise<{ booking: BookingRowForPlan; slot: SlotRowForPlan }> {
    const [bookingRes, slotRes] = await Promise.all([
      this.supabase.admin
        .from('bookings')
        .select('id, tenant_id, requester_person_id, location_id, start_at, end_at, status')
        .eq('id', bookingId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      this.supabase.admin
        .from('booking_slots')
        .select(
          'id, booking_id, tenant_id, space_id, start_at, end_at, attendee_count, attendee_person_ids',
        )
        .eq('id', slotId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
    ]);

    const booking = (bookingRes.data ?? null) as BookingRowForPlan | null;
    const slot = (slotRes.data ?? null) as SlotRowForPlan | null;

    if (!booking) {
      // Mirror RPC's 'edit_booking.not_found' code (00364:421); 404.
      throw AppErrors.notFoundWithCode('edit_booking.not_found', `booking ${bookingId} not found`);
    }
    if (!slot) {
      // Same 404 surface — slot not found OR cross-booking smuggling.
      throw AppErrors.notFoundWithCode('edit_booking.not_found', `slot ${slotId} not found`);
    }
    if (slot.booking_id !== bookingId) {
      // Spec §6 cross-booking guard. Same 404 to avoid existence leak.
      throw AppErrors.notFoundWithCode('edit_booking.not_found', `slot ${slotId} does not belong to booking ${bookingId}`);
    }

    return { booking, slot };
  }

  /**
   * Convert a rule-resolver `ApprovalConfig` into the EditPlan's
   * `EditPlanApprovalChainConfig` shape. Returns null when the resolver
   * outcome carries no chain (i.e., new_outcome will be 'allow').
   *
   * Threshold defaults to 'all' (mirrors 00364:584
   * `coalesce(v_new_chain_config->>'threshold', 'all')`) so the RPC's
   * v_parallel_group derivation is deterministic.
   */
  private shapeChainConfigForPlan(
    config: ApprovalConfig | null,
  ): EditPlanApprovalChainConfig | null {
    if (config === null) return null;
    const approvers = config.required_approvers ?? [];
    if (approvers.length === 0) {
      // The RPC raises edit_booking.invalid_plan_shape (00364:627-632)
      // when an INSERT is required but required_approvers is empty.
      // Returning null short-circuits that — the new_outcome will be
      // 'require_approval' but no insert will happen unless the rule
      // resolver returns at least one approver.
      return null;
    }
    return {
      required_approvers: approvers.map((a) => ({ type: a.type, id: a.id })),
      threshold: config.threshold ?? 'all',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal row types — kept in this file because they're an
// implementation detail of `loadBookingAndSlot` and would be over-shared
// if exported. Tests construct fixtures matching these shapes.
// ─────────────────────────────────────────────────────────────────────

interface BookingRowForPlan {
  id: string;
  tenant_id: string;
  requester_person_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: string;
}

interface SlotRowForPlan {
  id: string;
  booking_id: string;
  tenant_id: string;
  space_id: string;
  start_at: string;
  end_at: string;
  attendee_count: number | null;
  attendee_person_ids: string[];
}
