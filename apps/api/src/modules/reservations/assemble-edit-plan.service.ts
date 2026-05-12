/**
 * B.4 step 2D-C + 2E — `AssembleEditPlanService`.
 *
 * Builds the `EditPlan` jsonb the `edit_booking` RPC consumes
 * (supabase/migrations/00364_edit_booking_rpc_v4.sql:200-308 contract;
 * spec docs/follow-ups/b4-booking-edit-pipeline.md §3.3).
 *
 * Callers wired:
 *   - Step 2D-D: ReservationService.editSlot (kind='slot') — drag/resize
 *     on the desk scheduler.
 *   - Step 2E: ReservationService.editOne (kind='one') — booking-level
 *     edit (PATCH /reservations/:id) for single-occurrence bookings,
 *     including booking-level fields like `host_person_id`.
 *
 * Pipeline mirrors §3.3:
 *   1. Load current booking + slots (FOR UPDATE happens inside the RPC,
 *      not here — this read just snapshots the pre-patch state for
 *      diffing + rule resolution).
 *   2. Apply patch → target state.
 *   3. loadSpace(target_space_id) — tenant-scoped via
 *      BookingFlowService.loadSpace (booking-flow.service.ts:1222 —
 *      newly exposed in this step's C1 commit).
 *   4. (Removed N-CODE-5) The OLD-state resolver call was dead — the
 *      `old_outcome` is derived from chain presence (step 8), not a
 *      fresh resolver pass on the current geometry. Saved one DB
 *      round-trip per edit.
 *   5. RuleResolverService.resolve for NEW state → new_outcome,
 *      new chain config + matched rule ids + policy snapshot.
 *   5b. PLAN-C1 fail-fast: refuse 422 `edit_booking.rule_missing_approvers`
 *       when the resolver returns require_approval but the rule has no
 *       approvers. Without this the RPC would raise `invalid_plan_shape`
 *       (00364:577-583, :627-632) with misleading copy.
 *   6. ConflictGuardService.snapshotBuffersForBooking for the target
 *      slot (excluding the slot being edited so back-to-back-with-self
 *      doesn't false-collapse).
 *   7. computeCostFromHours from the target room's cost_per_hour.
 *   8. loadCurrentApprovalChain → compare to new outcome's chain via
 *      chainConfigsEqual → chain_config_changed boolean. The "live"
 *      chain definition (CODE-C2) excludes expired/rejected rows.
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
import { AppError, AppErrors } from '../../common/errors';
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
 * Input shape for `assembleEditPlan`. I-PLAN-3 — narrowed to a
 * discriminated union on `patch.kind` so contradictory field
 * combinations fail at TS compile time. Step 2D-C ships only `'slot'`;
 * Step 2E (`'one'` — single-row recurrence override) and Step 2F
 * (`'scope'` — multi-slot recurrence fanout) are reserved.
 *
 * Adding a new kind:
 *   1. Extend the union below with the new patch shape.
 *   2. Add a switch arm in `assembleEditPlan` that dispatches to the
 *      appropriate target-state builder.
 *   3. Until shipped, the orchestrator's switch raises `not_yet_implemented`
 *      so accidental callers get a clean 400 instead of a half-built plan.
 */
export interface AssembleEditPlanArgs {
  bookingId: string;
  tenantId: string;
  /** Identity of the slot being edited. For multi-slot bookings the
   * caller picks one; Step 2F will fan out to all slots in scope. */
  slotId: string;
  patch: AssembleEditPlanPatch;
}

/** Discriminated union of supported edit shapes. */
export type AssembleEditPlanPatch =
  | AssembleEditPlanSlotPatch
  | AssembleEditPlanOnePatch
  | AssembleEditPlanScopePatch;

/** Step 2D-C — geometry-only edit of a single slot. */
export interface AssembleEditPlanSlotPatch {
  kind: 'slot';
  /** Target room. When omitted, the slot's current space is reused. */
  space_id?: string;
  start_at?: string;
  end_at?: string;
  attendee_count?: number | null;
  attendee_person_ids?: string[];
}

/**
 * Step 2E — booking-level (`PATCH /reservations/:id`) edit.
 *
 * Caller resolves the booking's PRIMARY slot id (lowest `display_order`,
 * ties by `created_at`) and passes it in `args.slotId`. The plan-builder
 * applies geometry/meta to that slot the same way `'slot'` does; the
 * additional `host_person_id` field lands on the booking-patch (00364:
 * 647-652 validates tenant membership; :763-767 applies the new value).
 *
 * `recurrence_overridden` is NOT a caller-supplied field — the builder
 * sets it automatically on the booking_patch when the booking has
 * `recurrence_series_id IS NOT NULL` AND any patched field (geometry or
 * booking-level) would actually change state. Mirrors the legacy editOne
 * behavior at reservation.service.ts:817-819.
 */
export interface AssembleEditPlanOnePatch {
  kind: 'one';
  /** Slot-level: target room. Defaults to the primary slot's current space. */
  space_id?: string;
  /** Slot-level: target window start. */
  start_at?: string;
  /** Slot-level: target window end. */
  end_at?: string;
  /** Slot-level: attendee headcount. `null` clears the override. */
  attendee_count?: number | null;
  /** Slot-level: attendee person ids (per-slot). */
  attendee_person_ids?: string[];
  /** Booking-level: host person. `null` clears the value. */
  host_person_id?: string | null;
}

/** Step 2F placeholder — multi-slot recurrence fanout. Fields TBD. */
export interface AssembleEditPlanScopePatch {
  kind: 'scope';
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
   *
   * I-PLAN-3 — dispatch on `args.patch.kind`. Today only `'slot'` is
   * implemented; `'one'` / `'scope'` raise `not_yet_implemented` (400)
   * so accidental callers don't slip through to a half-built plan.
   */
  async assembleEditPlan(args: AssembleEditPlanArgs): Promise<EditPlan> {
    switch (args.patch.kind) {
      case 'slot':
        return this.assembleSlotEditPlan(args, args.patch);
      case 'one':
        return this.assembleOneEditPlan(args, args.patch);
      case 'scope':
        // Defense-in-depth: the discriminated union keeps the TS-level
        // gate, but a non-TS caller (or a future cast-around) could
        // still pass an unimplemented kind. Surface as 400 rather than
        // building a malformed plan. Step 2E ships kind='one'; kind=
        // 'scope' is Step 2F (multi-slot recurrence fanout).
        throw new AppError(
          'edit_booking.invalid_plan_shape',
          400,
          {
            detail: `assembleEditPlan kind=${args.patch.kind} is not yet implemented (Step 2F).`,
          },
        );
      default: {
        // exhaustiveness check — TS will error here if a new variant is
        // added to the union without a switch arm.
        const _exhaustive: never = args.patch;
        throw new AppError('edit_booking.invalid_plan_shape', 400, {
          detail: `assembleEditPlan: unknown patch kind ${JSON.stringify(_exhaustive)}.`,
        });
      }
    }
  }

  /**
   * Step 2D-C body — the single-slot, geometry-only edit pipeline.
   * Mirrors the §3.3 sequence in the file header. Now a thin wrapper
   * around `buildSingleSlotPlan` (the shared core also used by
   * `assembleOneEditPlan` — Step 2E).
   */
  private async assembleSlotEditPlan(
    args: AssembleEditPlanArgs,
    patch: AssembleEditPlanSlotPatch,
  ): Promise<EditPlan> {
    return this.buildSingleSlotPlan(args, {
      space_id: patch.space_id,
      start_at: patch.start_at,
      end_at: patch.end_at,
      attendee_count: patch.attendee_count,
      attendee_person_ids: patch.attendee_person_ids,
      host_person_id: undefined,
      // recurrence_overridden is NOT auto-set on slot-kind edits — the
      // 'slot' kind targets a specific slot under drag/resize and the
      // legacy editSlot path never set it. Only 'one'-kind edits flip
      // the booking-level override flag (mirrors editOne legacy
      // behavior at reservation.service.ts:817-819).
      auto_set_recurrence_overridden: false,
    });
  }

  /**
   * Step 2E body — single-occurrence booking-level edit
   * (`PATCH /reservations/:id`). The caller resolves the PRIMARY slot id
   * (lowest `display_order`, ties by `created_at`) and passes it in
   * `args.slotId`. From there the plan-building flow is identical to
   * `assembleSlotEditPlan`, plus:
   *   - `host_person_id` lands on the booking-patch (RPC validates tenant
   *     ownership at 00364:647-652 and applies the new value at :763-767).
   *   - `recurrence_overridden=true` is auto-set on the booking-patch
   *     when the booking has `recurrence_series_id IS NOT NULL` AND any
   *     patched field would actually change state. Mirrors the legacy
   *     editOne behavior at reservation.service.ts:817-819 (pre-cutover).
   */
  private async assembleOneEditPlan(
    args: AssembleEditPlanArgs,
    patch: AssembleEditPlanOnePatch,
  ): Promise<EditPlan> {
    return this.buildSingleSlotPlan(args, {
      space_id: patch.space_id,
      start_at: patch.start_at,
      end_at: patch.end_at,
      attendee_count: patch.attendee_count,
      attendee_person_ids: patch.attendee_person_ids,
      host_person_id: patch.host_person_id,
      auto_set_recurrence_overridden: true,
    });
  }

  /**
   * Shared single-slot-edit core. Both `kind:'slot'` (Step 2D-C) and
   * `kind:'one'` (Step 2E) flow through here. The only differences:
   *   - `kind:'one'` may patch `host_person_id` (booking-level field).
   *   - `kind:'one'` auto-sets `recurrence_overridden=true` when the
   *     booking is part of a series and ANY patched field would change.
   *
   * Citation: pre-extraction this was the body of `assembleSlotEditPlan`.
   * The §3.3 step numbers in the comments match the spec.
   */
  private async buildSingleSlotPlan(
    args: AssembleEditPlanArgs,
    patch: {
      space_id?: string;
      start_at?: string;
      end_at?: string;
      attendee_count?: number | null;
      attendee_person_ids?: string[];
      /** Booking-level. `undefined` = preserve. `null` = clear. */
      host_person_id?: string | null;
      /** When true and the booking is part of a series and any field is
       * patched, sets `booking_patch.recurrence_overridden = true`. */
      auto_set_recurrence_overridden: boolean;
    },
  ): Promise<EditPlan> {
    // N-CODE-4: snapshot the resolution timestamp ONCE, BEFORE any rule
    // reads + BEFORE the booking read. Deliberate: the RPC's stale-
    // resolution gate (00364:432-454) compares MAX(room_booking_rules
    // .updated_at) > _resolution_at; capturing the timestamp BEFORE we
    // read the booking row keeps the window honest — any rule change
    // between this line and the RPC call is detectable. Capturing it AFTER
    // would hide rule churn that happened during the read.
    const resolutionAt = new Date().toISOString();

    // ── 1. Load current booking + the target slot ────────────────────
    const { booking, slot } = await this.loadBookingAndSlot(args.bookingId, args.slotId, args.tenantId);

    // ── 2. Apply patch → target state ────────────────────────────────
    // Codex 2026-05-12 IMPORTANT: distinguish `undefined` (preserve) from
    // explicit `null` (clear). The RPC at 00364:802-805 honors a present
    // key with null value as "clear the column"; nullish-coalescing (`??`)
    // would silently demote explicit-null to "preserve". Use
    // `=== undefined` so explicit null clears.
    const target: TargetState = {
      spaceId: patch.space_id !== undefined ? patch.space_id : slot.space_id,
      startAt: patch.start_at !== undefined ? patch.start_at : slot.start_at,
      endAt: patch.end_at !== undefined ? patch.end_at : slot.end_at,
      attendeeCount: patch.attendee_count !== undefined ? patch.attendee_count : slot.attendee_count,
      attendeePersonIds:
        patch.attendee_person_ids !== undefined ? patch.attendee_person_ids : slot.attendee_person_ids,
      requesterPersonId: booking.requester_person_id,
    };

    // ── 3. Load target space (validates active + reservable) ─────────
    const targetSpace = await this.bookingFlow.loadSpace(target.spaceId);

    // ── 4. (Removed N-CODE-5) The OLD-state resolver call was dead.
    //   `old_outcome` is derived from chain presence (line below), not
    //   from a fresh resolver pass. Keeping the call cost a DB round-trip
    //   per edit for an unused result.

    // ── 5. Resolve rules for NEW state (target slot geometry) ────────
    const newOutcome = await this.ruleResolver.resolve({
      requester_person_id: booking.requester_person_id,
      space_id: target.spaceId,
      start_at: target.startAt,
      end_at: target.endAt,
      attendee_count: target.attendeeCount,
      criteria: {},
    });

    // ── 4b. CRITICAL C1 fail-fast — require_approval with no approvers.
    //   The rule resolver can return final='require_approval' with
    //   approvalConfig=null (rule-resolver.service.ts:514) OR with
    //   approvalConfig.required_approvers=[]. If we shape that into the
    //   plan, the RPC's 7.d gate (00364:577-583, plus the empty-list
    //   guard at :627-632) raises edit_booking.invalid_plan_shape (400)
    //   with a misleading message. Refuse here with a curated 422 so the
    //   operator sees an actionable copy ("ask an admin to configure
    //   approvers, or pick a different room").
    if (newOutcome.final === 'require_approval') {
      const approvers = newOutcome.approvalConfig?.required_approvers ?? [];
      if (newOutcome.approvalConfig === null || approvers.length === 0) {
        throw new AppError('edit_booking.rule_missing_approvers', 422, {
          detail:
            'The rule for this room requires approval but no approvers are configured.',
        });
      }
    }

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
    // booking-flow.service.ts:259). For multi-slot bookings, Step 2F
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

    // N-CODE-7: sort applied_rule_ids lexicographically before persisting.
    // The rule resolver fan-out order is non-deterministic across runs
    // (priority/specificity ties); without this, audit_events.details would
    // show false-positive churn on every edit even when the matched-rule set
    // didn't change. The fingerprint helper already canonicalises this set.
    const appliedRuleIds = newOutcome.matchedRules
      .map((r) => r.id)
      .slice()
      .sort();

    // ── 11b. Booking-level optional fields (Step 2E) ────────────────
    // host_person_id is a present-or-absent key. undefined = preserve
    // (omit the key from the patch — the RPC's case-when at 00364:763-767
    // falls back to v_booking.host_person_id). null OR string = present
    // (the RPC's nullif(...,'')::uuid coerces empty string to null).
    const bookingPatch: EditPlan['booking'] = {
      location_id: target.spaceId,
      start_at: target.startAt,
      end_at: target.endAt,
      cost_amount_snapshot: newCostSnapshot,
      policy_snapshot: policySnapshot,
      applied_rule_ids: appliedRuleIds,
    };
    if (patch.host_person_id !== undefined) {
      bookingPatch.host_person_id = patch.host_person_id;
    }

    // recurrence_overridden auto-set for kind='one' on a series booking
    // when any field is patched. The "any field" predicate matches the
    // legacy editOne check (reservation.service.ts:817-819): geometry
    // OR slot-meta OR booking-meta. We check the input patch fields
    // (not the target diff) because the legacy code treated a no-op
    // patch as a real edit too (e.g. attendee_count: 5 → 5 still set
    // the override flag pre-cutover). Subtle but worth preserving so
    // operator behavior stays consistent across the cutover.
    if (patch.auto_set_recurrence_overridden && booking.recurrence_series_id !== null) {
      const anyFieldPatched =
        patch.space_id !== undefined ||
        patch.start_at !== undefined ||
        patch.end_at !== undefined ||
        patch.attendee_count !== undefined ||
        patch.attendee_person_ids !== undefined ||
        patch.host_person_id !== undefined;
      if (anyFieldPatched) {
        bookingPatch.recurrence_overridden = true;
      }
    }

    const plan: EditPlan = {
      booking: bookingPatch,
      slot_patches: [slotPatch],
      // Step 2D-C scope: linked-row patches are empty. Step 2E preserves
      // the same scope — booking-level edits don't fan out to asset /
      // order / work-order patches; those land in Step 2F.
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
        .select('id, tenant_id, requester_person_id, location_id, start_at, end_at, status, recurrence_series_id')
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
      // Spec §3.3 cross-booking guard (booking-edit-pipeline.md). The plan
      // is per-booking; a slot belonging to a different booking would
      // smuggle through if the API call's slotId ↔ bookingId pair is
      // inconsistent. Same 404 to avoid existence leak (spec decision #6.1).
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
   *
   * CRITICAL C1 — empty-approvers contract (corrected). The earlier
   * docstring claimed returning null here "short-circuits" the RPC's
   * invalid_plan_shape gate. That was WRONG: when new_outcome is
   * 'require_approval', §3.6.5 row 2/7/8 sets v_action='insert' and the
   * RPC's 7.d gate at 00364:577-583 RAISES on null new_chain_config.
   * The actual contract is now: `assembleSlotEditPlan` fails-fast with
   * `edit_booking.rule_missing_approvers` (422) BEFORE this method runs
   * for the empty-approvers case. By the time we reach this method with
   * `final='require_approval'`, approvers.length is guaranteed >= 1.
   * The empty-array branch below is therefore unreachable in practice
   * (defense-in-depth — keep it returning null so an accidental future
   * caller bypassing the fail-fast at least gets the misleading 400 from
   * the RPC instead of leaking through).
   */
  private shapeChainConfigForPlan(
    config: ApprovalConfig | null,
  ): EditPlanApprovalChainConfig | null {
    if (config === null) return null;
    const approvers = config.required_approvers ?? [];
    if (approvers.length === 0) {
      // Defense-in-depth — see C1 contract above. Reachable only if a
      // future code path skips the fail-fast in `assembleSlotEditPlan`.
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
  /** Non-null when this booking is part of a recurrence series. Drives
   * the auto-set of `booking_patch.recurrence_overridden` in kind='one'
   * edits (Step 2E — mirrors legacy editOne behavior at
   * reservation.service.ts:817-819). */
  recurrence_series_id: string | null;
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
