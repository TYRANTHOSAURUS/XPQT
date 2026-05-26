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
  canonicalApproverSort,
  chainConfigsEqual,
  computeCostFromHours,
  loadCurrentApprovalChain,
} from './edit-plan-helpers';
import type {
  EditPlan,
  EditPlanApproval,
  EditPlanApprovalChainConfig,
  EditPlanAssetReservationPatch,
  EditPlanOrderPatch,
  EditPlanSlotPatch,
  EditPlanWorkOrderSlaPatch,
  ScopeEditPlan,
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
  /** Stable "now" claimed for this command idempotency key. */
  resolutionBasisAt?: string;
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

/**
 * Step 2F.2 — multi-occurrence recurrence scope edit.
 *
 * Used by `assembleScopeEditPlan` (separate entry point, different return
 * shape from `assembleEditPlan` because scope edits produce N plans, not 1).
 *
 * The caller has already resolved `effectiveSeriesId`:
 *   - scope = 'series' → use the pivot booking's current recurrence_series_id
 *   - scope = 'this_and_following' → call RecurrenceService.splitSeries(pivot)
 *     to mint a new series_id at the pivot and forward → use that new id.
 * Series splitting happens at the controller layer (Step 2F.3), NOT inside
 * the plan-builder. Rationale: plan-builder must be pure for dry-run
 * support; splitSeries commits side effects (writes a new series row +
 * UPDATEs the forward occurrences' recurrence_series_id).
 *
 * NOT supported on scope edits: `start_at` / `end_at` (series time-shift
 * requires recurrence_rule mutation, not slot UPDATE). Step 2F.2 rejects
 * them with `edit_booking_scope.time_shift_not_supported` at the runtime
 * gate inside assembleScopeEditPlan (the type doesn't admit them, but a
 * non-TS caller smuggling via JSON is the threat the runtime guard
 * defends against — defense-in-depth; the controller-layer rejection in
 * Step 2F.3 is the primary site).
 */
export interface AssembleEditPlanScopePatch {
  kind: 'scope';
  /** Slot-level: target room (applied to PRIMARY slot of each occurrence). */
  space_id?: string;
  /** Slot-level: attendee headcount per occurrence's primary slot. */
  attendee_count?: number | null;
  /** Slot-level: attendee person ids per occurrence's primary slot. */
  attendee_person_ids?: string[];
  /** Booking-level: host_person_id. Applied to every booking in scope.
   * `null` = clear; `string` = set; `undefined` = preserve. */
  host_person_id?: string | null;
}

/**
 * Step 2F.2 — return shape from `assembleScopeEditPlan`.
 *
 * `rpc_plans` maps directly to the `edit_booking_scope` RPC's
 * `p_plans` jsonb argument (00371:65): `[{booking_id, plan}, ...]`.
 *
 * `series_id` equals the caller's `effectiveSeriesId` and matches the
 * RPC's same-series gate (00371:334-347). The plan-builder verifies the
 * pivot booking's recurrence_series_id equals this value — defense-in-
 * depth before the RPC's loop.
 */
export interface AssembleScopeEditPlanResult {
  series_id: string;
  /** Booking-audit Slice 8 (audit 03 P2-4) — `plan` is the scope-narrowed
   * `ScopeEditPlan` (booking patch cannot carry `recurrence_overridden`).
   * tsc now proves a scope plan never carries the key; the
   * `edit_booking_scope` RPC guard (00395:218-222) stays as
   * defense-in-depth. The per-occurrence (`kind:'one'`/`'slot'`) path +
   * the shared `buildSingleSlotPlan` still return the full `EditPlan` —
   * the narrow is a projection applied only at the scope boundary below. */
  rpc_plans: Array<{ booking_id: string; plan: ScopeEditPlan }>;
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
        // Scope edits produce N per-occurrence plans, not 1 — they have
        // a different return shape (`AssembleScopeEditPlanResult`) and
        // a different entry point (`assembleScopeEditPlan`). The generic
        // `assembleEditPlan` returns a single `EditPlan`; routing kind=
        // 'scope' here would either lie about the shape or force a
        // union return type that callers (editSlot, editOne) don't
        // want. Surface as 400 so a caller using the wrong entry point
        // gets a clean error instead of a malformed plan. Step 2F.3's
        // controller calls `assembleScopeEditPlan` directly.
        throw new AppError(
          'edit_booking.invalid_plan_shape',
          400,
          {
            detail: `assembleEditPlan kind=scope: use assembleScopeEditPlan() instead (different return shape — N per-occurrence plans).`,
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
   * Phase 8 (Tier B follow-up #2) — `assertTenantContextMatch` retired.
   *
   * The Step 2F.2 hard-assert was a mitigation for ALS-reading helpers
   * (`BookingFlowService.loadSpace`, `RuleResolverService.resolve`,
   * `ConflictGuardService.snapshotBuffersForBooking`) that pulled tenant
   * from `TenantContext.current()`. Those helpers now take `tenantId`
   * as an explicit arg — the typed signature makes a missing/wrong
   * tenant a compile error, not a runtime cross-tenant leak. The
   * runtime 500 (`edit_booking.tenant_context_mismatch`) is gone; the
   * code, message, and STATUS_BY_CODE entry have been removed from the
   * shared error registry.
   */

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
      linked_row_mode: 'single_slot',
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
      linked_row_mode: 'uniform_booking',
    });
  }

  /**
   * Step 2F.2 — multi-occurrence recurrence scope edit assembly.
   *
   * Builds N per-occurrence EditPlans for the `edit_booking_scope` RPC
   * (00371). The caller has already resolved `effectiveSeriesId`:
   *   - scope='series' → pivot booking's current recurrence_series_id
   *   - scope='this_and_following' → new_series_id from
   *     RecurrenceService.splitSeries (the controller is responsible
   *     for the split; the plan-builder stays pure so dry-run support
   *     doesn't accidentally commit a series fork).
   *
   * The returned `rpc_plans` array maps directly to the RPC's `p_plans`
   * jsonb argument: `[{booking_id, plan}, ...]`. Each `plan` flows
   * through `buildSingleSlotPlan` with the primary slot resolved per
   * booking (lowest `display_order`, ties by `created_at` — same
   * convention as editOne). `auto_set_recurrence_overridden: false`
   * because the RPC at 00371:219 REJECTS scope plans that include
   * `recurrence_overridden` in the booking patch — scope edits are
   * series-wide; per-occurrence override would corrupt the projection
   * semantics.
   *
   * Pre-flight B.4.A.5 gate at TS layer: LIFTED by sub-step H (2026-05-13).
   * The per-occurrence loop used to refuse `booking.edit_requires_
   * notification_dispatch` 422 on the first occurrence whose plan would
   * flip approval (rows 2/7/8 of §3.6.5). Now that notification dispatch
   * is shipped (atomic inbox INSERT inside 00394 + outbox handler +
   * inbox UI + admin template overrides), approval-flipping occurrences
   * commit their chain rows + emit `booking.approval_required` events
   * the same way editOne / editSlot do. The error code stays registered
   * for defense-in-depth — any future regression that re-introduces the
   * gate must reuse it.
   *
   * Perf budget: N × (6-8 DB round-trips). For typical 12-52 weekly
   * series, ~70-400 round-trips at ~5ms each on remote Supabase. The
   * 200-occurrence cap (mirrors 00371:194) keeps the worst case bounded.
   * Step 2F.4 smoke probes will quantify actual latency; resolver-outcome
   * hoist (compute new chain once, broadcast to all occurrences) is a
   * deferred optimisation tracked in docs/follow-ups/b4-followups.md if
   * smoke shows unacceptable p95.
   */
  async assembleScopeEditPlan(args: {
    bookingId: string; // pivot booking (tenant context + series verification)
    tenantId: string;
    effectiveSeriesId: string;
    /** Stable "now" claimed for the scope command idempotency key. */
    resolutionBasisAt?: string;
    patch: AssembleEditPlanScopePatch;
    /**
     * B.4 Step 2F.3 — forward-only scope-rows filter.
     *
     * When set, the in-scope booking query adds `.gte('start_at', ...)`
     * so only occurrences starting at-or-after the pivot are planned.
     * Used by `scope='this_and_following'` on the DRY-RUN path: we cannot
     * call `RecurrenceService.splitSeries(pivot)` for a preview (it
     * commits side effects — writes a new recurrence_series row + UPDATEs
     * forward bookings' recurrence_series_id), so the dry-run previews
     * the FORWARD SUBSET of the CURRENT series instead.
     *
     * Undefined = current default (every live occurrence in the series).
     * That covers:
     *   - `scope='series'` (preview + commit both)
     *   - `scope='this_and_following'` on COMMIT (splitSeries already ran,
     *     the new series id is the effectiveSeriesId, and every row under
     *     it is forward-only by construction).
     */
    forwardOnlyFromStartAt?: string;
  }): Promise<AssembleScopeEditPlanResult> {
    // Phase 8 (Tier B follow-up #2): the Step 2F.2 hard-assert is retired —
    // helpers (loadSpace / ruleResolver.resolve / snapshotBuffersForBooking)
    // now take `tenantId` as an explicit arg, so a wrong-tenant call is a
    // compile error, not a runtime mismatch.

    // ── A. Runtime gate on start_at/end_at ────────────────────────────
    // Belt-and-suspenders: the typed union doesn't admit these keys
    // (AssembleEditPlanScopePatch is space_id + attendee_* +
    // host_person_id only), but a non-TS caller smuggling via JSON
    // could still set them. Refuse before any DB I/O so the operator
    // sees an actionable copy. The controller (Step 2F.3) is the
    // primary rejection site; this guard catches everything else.
    const smuggled = args.patch as unknown as {
      start_at?: unknown;
      end_at?: unknown;
    };
    if (smuggled.start_at !== undefined || smuggled.end_at !== undefined) {
      throw new AppError(
        'edit_booking_scope.time_shift_not_supported',
        422,
        {
          detail:
            'Series time-shift requires recurrence_rule edit; not supported on scope edits. Pick a single occurrence to change the start or end time.',
        },
      );
    }

    // ── B. Load pivot booking (tenant-scoped) ─────────────────────────
    const pivotRes = await this.supabase.admin
      .from('bookings')
      .select('id, tenant_id, recurrence_series_id')
      .eq('id', args.bookingId)
      .eq('tenant_id', args.tenantId)
      .maybeSingle();
    const pivot = (pivotRes.data ?? null) as
      | { id: string; tenant_id: string; recurrence_series_id: string | null }
      | null;
    if (!pivot) {
      // Mirror single-edit shape — don't leak cross-tenant existence.
      throw AppErrors.notFoundWithCode(
        'edit_booking.not_found',
        `booking ${args.bookingId} not found`,
      );
    }
    if (pivot.recurrence_series_id === null) {
      throw new AppError('edit_booking_scope.not_recurring', 422, {
        detail: `Booking ${args.bookingId} is not part of a recurring series.`,
      });
    }

    // ── C. Defense-in-depth: pivot's series must match the caller's
    //   resolved effectiveSeriesId. If the controller split-then-passed
    //   the new series id but the pivot's row didn't move, that's an
    //   internal consistency bug. The RPC will independently raise
    //   `mixed_series` if any in-scope row's series_id differs from
    //   the others — this TS guard fails earlier with a clearer code.
    if (pivot.recurrence_series_id !== args.effectiveSeriesId) {
      throw new AppError('edit_booking_scope.series_mismatch', 500, {
        detail: `pivot booking ${args.bookingId} recurrence_series_id=${pivot.recurrence_series_id} does not equal caller-supplied effectiveSeriesId=${args.effectiveSeriesId}`,
      });
    }

    // ── D. Select in-scope bookings (deterministic id-sorted) ────────
    // status<>'cancelled' mirrors the RPC's cancelled-state guard
    // (00371:458-462) — a cancelled occurrence in the series would
    // raise booking.cancelled_cannot_edit at the per-occurrence loop;
    // filtering here keeps the dry-run path clean.
    //
    // Codex remediation 2026-05-12: read-to-commit race. Between this TS
    // read and the RPC's row lock, a concurrent operator could cancel an
    // in-scope occurrence. The RPC's per-occurrence cancelled-state guard
    // at 00371_edit_booking_scope_rpc_v2.sql:457 is the authoritative
    // catch — the whole transaction rolls back with
    // `booking.cancelled_cannot_edit` surfacing the offending booking_id.
    // The TS filter here is best-effort: it keeps the dry-run path clean
    // and avoids sending plans we already know would fail at commit. The
    // race itself is intentionally covered downstream, not here.
    // B.4 Step 2F.3 — `forwardOnlyFromStartAt` filters the dry-run
    // preview of `scope='this_and_following'` to the FORWARD subset of
    // the CURRENT series, without committing a split. The committed
    // path (no filter, post-split) only sees the new series id and is
    // forward-only by construction.
    let scopeQuery = this.supabase.admin
      .from('bookings')
      .select('id')
      .eq('tenant_id', args.tenantId)
      .eq('recurrence_series_id', args.effectiveSeriesId)
      .neq('status', 'cancelled');
    if (args.forwardOnlyFromStartAt !== undefined) {
      scopeQuery = scopeQuery.gte('start_at', args.forwardOnlyFromStartAt);
    }
    const scopeRes = await scopeQuery.order('id', { ascending: true });
    if (scopeRes.error) {
      throw AppErrors.server('edit_booking.not_found', {
        detail: `scope-row read failed: ${scopeRes.error.message}`,
        cause: scopeRes.error,
      });
    }
    const scopeRows = (scopeRes.data ?? []) as Array<{ id: string }>;
    if (scopeRows.length === 0) {
      throw new AppError('edit_booking_scope.empty_scope', 422, {
        detail: `series ${args.effectiveSeriesId} resolved to 0 live bookings (all cancelled or wiped between split and read).`,
      });
    }
    if (scopeRows.length > 200) {
      // TS-layer defense before the RPC's identical cap at 00371:194.
      // Surfacing here saves a server round-trip + gives a cleaner stack
      // trace for the operator-actionable message.
      throw new AppError('edit_booking_scope.too_many_occurrences', 422, {
        detail: `series ${args.effectiveSeriesId} has ${scopeRows.length} live occurrences; the per-edit cap is 200.`,
      });
    }

    // ── E. Per-occurrence plan-build ─────────────────────────────────
    // Each occurrence flows through `buildSingleSlotPlan` with its own
    // primary slot. RuleResolver + ConflictGuard + loadSpace ARE called
    // per-occurrence (not hoisted) because each occurrence may have a
    // different time window (per-occurrence cost recompute) and may
    // match a different rule subset (start_at + end_at are inputs to
    // the resolver). The hoist optimisation is a deferred follow-up
    // pending Step 2F.4 smoke probes.
    const rpc_plans: Array<{ booking_id: string; plan: ScopeEditPlan }> = [];
    for (const row of scopeRows) {
      const bookingId = row.id;

      // Resolve the primary slot id (lowest display_order, ties by
      // created_at). Mirrors the convention editOne uses (the
      // primary-slot resolution helper at the controller layer).
      const primaryRes = await this.supabase.admin
        .from('booking_slots')
        .select('id')
        .eq('tenant_id', args.tenantId)
        .eq('booking_id', bookingId)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      const primary = (primaryRes.data ?? null) as { id: string } | null;
      if (!primary) {
        // Every booking must have ≥1 slot (00043 invariant). If we
        // find a booking with zero slots, the data is corrupt — 500.
        throw new AppError(
          'edit_booking_scope.primary_slot_not_found',
          500,
          { detail: `booking ${bookingId} has no primary slot in tenant ${args.tenantId}` },
        );
      }

      const plan = await this.buildSingleSlotPlan(
        {
          bookingId,
          tenantId: args.tenantId,
          resolutionBasisAt: args.resolutionBasisAt,
          slotId: primary.id,
          // The dispatcher discriminator isn't read by the core; this
          // narrowing is structurally compatible. The core treats
          // every call as single-slot.
          patch: { kind: 'slot' } as AssembleEditPlanSlotPatch,
        },
        {
          space_id: args.patch.space_id,
          // Time-shift smuggle already rejected at gate A; pass
          // undefined so buildSingleSlotPlan preserves the slot's
          // current start_at/end_at (the RPC's start_at/end_at keys
          // on the booking patch will mirror the slot's current
          // window — no projection drift).
          start_at: undefined,
          end_at: undefined,
          attendee_count: args.patch.attendee_count,
          attendee_person_ids: args.patch.attendee_person_ids,
          host_person_id: args.patch.host_person_id,
          // 00371:219 REJECTS scope plans that set recurrence_overridden.
          // Must be false here — series edits never flip the override
          // flag (the flag is a per-occurrence concept).
          auto_set_recurrence_overridden: false,
          linked_row_mode: 'single_slot',
        },
      );
      // ── F. (historical position) B.4.A.5 controller-vs-notification gate ──
      // Sub-step H (2026-05-13) lifted the pre-flight predicate here. The
      // 00394 RPC now writes inbox_notifications rows + emits
      // `booking.approval_required` atomically per occurrence, so the
      // scope edit no longer needs to refuse the first approval-flipping
      // occurrence. Sibling lifts: editOne / editSlot in reservation
      // .service.ts. Error code `booking.edit_requires_notification_
      // dispatch` stays registered for defense-in-depth.

      // Booking-audit Slice 8 (audit 03 P2-4) — project the full
      // `EditPlan` to the scope-narrowed `ScopeEditPlan`. The shared
      // `buildSingleSlotPlan` returns the full shape (unchanged — its
      // general return must keep compiling for the kind:'one'/'slot'
      // paths); `auto_set_recurrence_overridden:false` above means the
      // key is never set on scope, so this destructure is a no-op on the
      // wire (same supabase-js rpc serialization — no `as EditPlan` /
      // `JSON.parse` re-cast that would defeat the type). The explicit
      // `Omit` projection is what lets tsc PROVE a scope plan can never
      // carry `recurrence_overridden`; the 00395:218-222 RPC guard stays
      // as runtime defense-in-depth.
      const { recurrence_overridden: _scopeNeverSetsThis, ...scopeBooking } =
        plan.booking;
      void _scopeNeverSetsThis;
      const scopePlan: ScopeEditPlan = { ...plan, booking: scopeBooking };
      rpc_plans.push({ booking_id: bookingId, plan: scopePlan });
    }

    return { series_id: args.effectiveSeriesId, rpc_plans };
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
      /**
       * `uniform_booking` means the caller is moving the booking-level
       * window, so booking-keyed linked rows can shift even when the booking
       * has multiple slots. `single_slot` keeps the old skip for a one-slot
       * drag inside a multi-slot booking because child rows do not carry
       * slot attribution.
       */
      linked_row_mode: 'single_slot' | 'uniform_booking';
    },
  ): Promise<EditPlan> {
    // N-CODE-4: snapshot the resolution timestamp ONCE, BEFORE any rule
    // reads + BEFORE the booking read. Deliberate: the RPC's stale-
    // resolution gate (00364:432-454) compares MAX(room_booking_rules
    // .updated_at) > _resolution_at; capturing the timestamp BEFORE we
    // read the booking row keeps the window honest — any rule change
    // between this line and the RPC call is detectable. Capturing it AFTER
    // would hide rule churn that happened during the read.
    const resolutionAt = args.resolutionBasisAt ?? new Date().toISOString();

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
    const targetSpace = await this.bookingFlow.loadSpace(target.spaceId, args.tenantId);

    // ── 4. (Removed N-CODE-5) The OLD-state resolver call was dead.
    //   `old_outcome` is derived from chain presence (line below), not
    //   from a fresh resolver pass. Keeping the call cost a DB round-trip
    //   per edit for an unused result.

    // ── 5. Resolve rules for NEW state (target slot geometry) ────────
    const newOutcome = await this.ruleResolver.resolve(
      {
        requester_person_id: booking.requester_person_id,
        space_id: target.spaceId,
        start_at: target.startAt,
        end_at: target.endAt,
        attendee_count: target.attendeeCount,
        criteria: {},
        resolution_basis_at: resolutionAt,
      },
      args.tenantId,
    );

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
      tenant_id: args.tenantId,
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
    // booking-audit codex idempotency review: matched_rule_ids /
    // effects_seen / rule_evaluations are AUDIT-SNAPSHOT copies — the
    // rule resolver fan-out order is non-deterministic across runs
    // (priority/specificity ties), so the same logical edit retried
    // under the same idempotency key would serialise to a different
    // plan and spuriously raise command_operations.payload_mismatch.
    // Canonicalise the snapshot copies here so the plan is byte-stable
    // across retries. This aligns the snapshot to the OPERATIVE
    // applied_rule_ids set (already sorted at :appliedRuleIds below with
    // the SAME default-lexicographic comparator) — it does NOT change
    // any decision/precedence ordering.
    const matchedRuleIdsSorted = newOutcome.matchedRules
      .map((r) => r.id)
      .slice()
      .sort();
    const policySnapshot = {
      matched_rule_ids: matchedRuleIdsSorted,
      effects_seen: newOutcome.effects.slice().sort(),
      buffers_collapsed_for_back_to_back:
        buffers.setup_buffer_minutes !== (targetSpace.setup_buffer_minutes ?? 0) ||
        buffers.teardown_buffer_minutes !== (targetSpace.teardown_buffer_minutes ?? 0),
      source_room_check_in_required: targetSpace.check_in_required ?? false,
      source_room_setup_buffer_minutes: targetSpace.setup_buffer_minutes ?? 0,
      source_room_teardown_buffer_minutes: targetSpace.teardown_buffer_minutes ?? 0,
      rule_evaluations: newOutcome.matchedRules
        .map((r) => ({
          rule_id: r.id,
          matched: true,
          effect: r.effect,
          denial_message: r.denial_message ?? undefined,
        }))
        .slice()
        .sort((a, b) => (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0)),
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

    // recurrence_overridden auto-set for kind='one' on a series booking.
    // Self-review C-1 (2026-05-12): the predicate is ASYMMETRIC, matching
    // the pre-cutover legacy editOne semantics at
    // git show f5f01511^:reservation.service.ts:793-819:
    //
    //   - GEOMETRY (space_id, start_at, end_at): VALUE-compare against
    //     the current primary-slot state. Re-saving the same start_at
    //     a frontend already shows is NOT an edit and must not flip
    //     the override flag (resave is the dominant 'no change' op).
    //   - META (attendee_count, attendee_person_ids, host_person_id):
    //     KEY-compare (any defined key counts as an edit). Legacy
    //     editOne treated `attendee_count: 5 → 5` as a real edit (it
    //     went into slotMetaPatch unconditionally on defined-ness, and
    //     the override flag fired off `slotMetaPatch.length > 0`).
    //
    // The earlier (Step 2E v1) key-only predicate broke geometry parity:
    // a frontend resave like `{ start_at: r.start_at }` would (a) skip
    // the editOne entry-point no-op short-circuit (which was also
    // key-only at the time), (b) reach this branch, (c) auto-flip
    // recurrence_overridden, and (d) detach the booking from the
    // series for future scope-wide edits. Asymmetric value/key parity
    // matches legacy exactly. See docs/follow-ups/b4-followups.md and
    // the editOne entry-point no-op block at reservation.service.ts:846.
    if (patch.auto_set_recurrence_overridden && booking.recurrence_series_id !== null) {
      const hasGeometryChange =
        (patch.space_id !== undefined && patch.space_id !== slot.space_id) ||
        (patch.start_at !== undefined && patch.start_at !== slot.start_at) ||
        (patch.end_at !== undefined && patch.end_at !== slot.end_at);
      const hasMetaKey =
        patch.attendee_count !== undefined ||
        patch.attendee_person_ids !== undefined ||
        patch.host_person_id !== undefined;
      if (hasGeometryChange || hasMetaKey) {
        bookingPatch.recurrence_overridden = true;
      }
    }

    // ── 12. Linked-row patches (P0-2 fix — booking-audit remediation) ─
    // editOne / editSlot move the booking's time/room. Before this, the
    // three patch arrays were hard-coded [] so linked orders /
    // asset_reservations / setup work_orders stayed at the OLD time
    // (caterer daglijst diverged). The `edit_booking` v5 RPC (00394)
    // already applies these arrays atomically (§10.c :736-745 / §10.d
    // :748-770 / §10.f :856-870 + the sla.timer_repointed_required emit
    // gate :1011-1031). This computes them; no SQL change is needed.
    const linked = await this.buildLinkedRowPatches(
      args.bookingId,
      args.tenantId,
      slot.start_at,
      slot.end_at,
      target.startAt,
      target.endAt,
      slot.space_id,
      target.spaceId,
      patch.linked_row_mode,
    );

    const plan: EditPlan = {
      booking: bookingPatch,
      slot_patches: [slotPatch],
      asset_reservation_patches: linked.asset_reservation_patches,
      order_patches: linked.order_patches,
      work_order_sla_patches: linked.work_order_sla_patches,
      _resolution_at: resolutionAt,
      approval,
    };

    // audit-03 Slice 3 (P0-2 multi-slot residual, Path B): propagate the
    // multi-slot skip up to the service edit path. Pre-fix this flag was
    // DISCARDED here (only the 3 patch arrays were destructured from
    // `linked`), so the documented multi-slot linked-row skip was SILENT
    // below `buildLinkedRowPatches`'s guard. Set ONLY when true so
    // single-slot plans stay byte-identical (and the field is `_`-prefixed
    // + stripped before the RPC, so it never reaches the wire or the
    // idempotency hash regardless — see edit-plan.types.ts).
    if (linked.skippedMultiSlot) {
      plan._skipped_multi_slot_linked_rows = true;
    }

    return plan;
  }

  /**
   * P0-2 (booking-audit remediation) — compute the linked-row patch
   * arrays the `edit_booking` v5 RPC consumes so editOne / editSlot
   * time/room moves cascade to the booking's orders, asset_reservations
   * and setup work_orders. Returns empty arrays (no-op) when the
   * booking has no live linked rows.
   *
   * Window classification (LOCKED by the booking-audit codex plan
   * review — implement exactly):
   *
   *   - boundary-aligned: child window == the OLD slot window
   *     (start == oldStart AND end == oldEnd) → new = (newStart,
   *     newEnd). It tracked the booking window, so it follows the
   *     booking window.
   *   - custom-window: anything else → shift BOTH endpoints by
   *     startDelta only (preserve the child's own duration; never
   *     apply endDelta — a 30-min setup window must stay 30 min, just
   *     start 2h later).
   *
   * Per-table read filters exclude terminal statuses (a cancelled
   * order / released asset_reservation / closed work_order must not be
   * re-pointed):
   *   - orders.status        terminal = 'cancelled' | 'fulfilled'
   *                          (00013_orders_catalog.sql:55)
   *   - asset_reservations.status terminal = 'cancelled' | 'released'
   *                          (00142_asset_reservations.sql:14-15)
   *   - work_orders.status_category terminal = 'resolved' | 'closed'
   *                          (00213_step1c1_work_orders_new_table.sql:53)
   *
   * Multi-slot safety: orders / asset_reservations / work_orders key
   * ONLY off booking_id (00278_retarget_sibling_tables.sql:108-144) —
   * none carries a slot or space attribution column. So for a >1-slot
   * booking we cannot attribute a booking-level child to one slot. A
   * single-slot edit on a multi-slot booking is allowed only when there
   * are no live linked rows; otherwise we reject with an explicit conflict
   * and require a whole-booking edit. A booking-level editOne uses
   * `uniform_booking`, so the booking-keyed linked rows shift with the
   * booking even when there are multiple slots.
   */
  private async buildLinkedRowPatches(
    bookingId: string,
    tenantId: string,
    oldStart: string,
    oldEnd: string,
    newStart: string,
    newEnd: string,
    oldSpaceId: string,
    newSpaceId: string,
    mode: 'single_slot' | 'uniform_booking' = 'uniform_booking',
  ): Promise<{
    asset_reservation_patches: EditPlanAssetReservationPatch[];
    order_patches: EditPlanOrderPatch[];
    work_order_sla_patches: EditPlanWorkOrderSlaPatch[];
    skippedMultiSlot: boolean;
  }> {
    // Multi-slot safety gate. Children key only off booking_id with no
    // slot/space attribution column — if the booking has >1 slot we
    // cannot safely attribute a booking-level child to one slot move.
    const slotCountRes = await this.supabase.admin
      .from('booking_slots')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId);
    // I-3 (booking-audit codex REJECT — blocking Important): fail CLOSED
    // on a Supabase read error. A transient slot-count read failure must
    // NOT fall back to `count ?? 0` (single-slot) — that would let the
    // `edit_booking` RPC commit the booking time move while linked
    // orders / asset_reservations / work_orders stay at the OLD time
    // (the exact P0-2 divergence this slice exists to prevent). Same
    // pattern + same code/factory as the in-file scope-row read at
    // :495-499 (`AppErrors.server('edit_booking.not_found', { detail,
    // cause })`). NOTE: only a truthy `.error` is fail-closed — a
    // SUCCESSFUL read with count > 1 is the deliberate documented
    // multi-slot skip below, NOT an error.
    if (slotCountRes.error) {
      throw AppErrors.server('edit_booking.not_found', {
        detail: `slot-count read failed: ${slotCountRes.error.message}`,
        cause: slotCountRes.error,
      });
    }
    const slotCount = slotCountRes.count ?? 0;
    const oldStartMs = Date.parse(oldStart);
    const oldEndMs = Date.parse(oldEnd);
    const newStartMs = Date.parse(newStart);
    const newEndMs = Date.parse(newEnd);
    // NUMERIC/tz round-trip safety: parse to epoch ms, do integer math,
    // re-serialize ISO-8601 with timezone (toISOString → 'Z'). The RPC
    // casts every patch timestamp via `::timestamptz` (00394:738-739,
    // :757, :858) so an explicit UTC offset round-trips losslessly.
    const startDeltaMs = newStartMs - oldStartMs;

    // Classify a child window and compute its new (start, end).
    //   - boundary-aligned (child == OLD booking window): follow the
    //     booking window → (newStart, newEnd).
    //   - custom-window: shift BOTH endpoints by startDelta only —
    //     preserve the child's own duration; never apply endDelta.
    // Rationale: booking-audit codex plan review — a window that
    // tracked the booking should keep tracking it; a bespoke window
    // (e.g. a 30-min setup or an early-bird AV check) should slide with
    // the move but keep its shape, not be restretched to the new
    // booking span.
    const shiftWindow = (
      childStart: string,
      childEnd: string,
    ): { start_at: string; end_at: string } => {
      const csMs = Date.parse(childStart);
      const ceMs = Date.parse(childEnd);
      const isBoundaryAligned = csMs === oldStartMs && ceMs === oldEndMs;
      if (isBoundaryAligned) {
        return {
          start_at: new Date(newStartMs).toISOString(),
          end_at: new Date(newEndMs).toISOString(),
        };
      }
      return {
        start_at: new Date(csMs + startDeltaMs).toISOString(),
        end_at: new Date(ceMs + startDeltaMs).toISOString(),
      };
    };

    // ── asset_reservations ──────────────────────────────────────────
    // Exclude terminal status ('cancelled' | 'released'). Live =
    // 'confirmed' (00142:14-15). Shift per the classify rule.
    const arRes = await this.supabase.admin
      .from('asset_reservations')
      .select('id, start_at, end_at, status')
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .not('status', 'in', '("cancelled","released")');
    // I-3 (booking-audit codex REJECT): fail CLOSED — a failed child
    // read silently fell back to `[]` (no patches), letting the RPC
    // commit while these asset_reservations stayed at the OLD time.
    if (arRes.error) {
      throw AppErrors.server('edit_booking.not_found', {
        detail: `asset_reservations read failed: ${arRes.error.message}`,
        cause: arRes.error,
      });
    }
    const arRows = (arRes.data ?? []) as Array<{
      id: string;
      start_at: string;
      end_at: string;
      status: string;
    }>;

    // ── orders ──────────────────────────────────────────────────────
    // Exclude terminal status ('cancelled' | 'fulfilled') (00013:55).
    // Emit requested_for_* per the classify rule, but only include a
    // key when the source column is non-null — the RPC preserves an
    // absent key (00394:755-764). delivery_location_id is re-pointed to
    // the new space ONLY when the slot's space changed AND that order's
    // current delivery_location_id == the old space (don't clobber an
    // order deliberately delivered elsewhere).
    const spaceChanged = oldSpaceId !== newSpaceId;
    const orderRes = await this.supabase.admin
      .from('orders')
      .select(
        'id, requested_for_start_at, requested_for_end_at, delivery_location_id, status',
      )
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .not('status', 'in', '("cancelled","fulfilled")');
    // I-3 (booking-audit codex REJECT): fail CLOSED — a failed orders
    // read silently fell back to `[]`, letting the RPC commit while
    // these orders stayed at the OLD time (caterer daglijst diverges).
    if (orderRes.error) {
      throw AppErrors.server('edit_booking.not_found', {
        detail: `orders read failed: ${orderRes.error.message}`,
        cause: orderRes.error,
      });
    }
    const orderRows = (orderRes.data ?? []) as Array<{
      id: string;
      requested_for_start_at: string | null;
      requested_for_end_at: string | null;
      delivery_location_id: string | null;
      status: string;
    }>;

    // ── work_orders ─────────────────────────────────────────────────
    // Exclude terminal status_category ('resolved' | 'closed')
    // (00213:53). work_orders carry only `planned_start_at` (a point,
    // not a window) → new planned_start_at = planned_start_at +
    // startDelta (a point follows the move's start delta; there is no
    // end to classify, so the boundary/custom split doesn't apply).
    // Set needs_repoint=true + sla_policy_id (from the WO's sla_id
    // column) so the RPC fires sla.timer_repointed_required
    // (00394:1011-1031). Do NOT emit a raw sla_due_at — the SLA timer
    // repoint handler recomputes the due time from the policy; emitting
    // a hand-shifted sla_due_at here would double-apply.
    const woRes = await this.supabase.admin
      .from('work_orders')
      .select('id, planned_start_at, sla_id, status_category')
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .not('status_category', 'in', '("resolved","closed")');
    // I-3 (booking-audit codex REJECT): fail CLOSED — a failed
    // work_orders read silently fell back to `[]`, letting the RPC
    // commit while setup work_orders / SLA timers stayed at the OLD
    // time (no sla.timer_repointed_required emit fired).
    if (woRes.error) {
      throw AppErrors.server('edit_booking.not_found', {
        detail: `work_orders read failed: ${woRes.error.message}`,
        cause: woRes.error,
      });
    }
    const woRows = (woRes.data ?? []) as Array<{
      id: string;
      planned_start_at: string | null;
      sla_id: string | null;
      status_category: string;
    }>;

    if (slotCount > 1 && mode === 'single_slot') {
      const liveLinkedRowCount = arRows.length + orderRows.length + woRows.length;
      if (liveLinkedRowCount > 0) {
        throw AppErrors.conflict('edit_booking.linked_rows_require_booking_scope', {
          detail:
            `single-slot edit refused for multi-slot booking ${bookingId}: ` +
            `${liveLinkedRowCount} live booking-keyed linked row(s) require a booking-scope edit`,
        });
      }
    }

    const asset_reservation_patches: EditPlanAssetReservationPatch[] = arRows
      .map((r) => {
        const w = shiftWindow(r.start_at, r.end_at);
        return { id: r.id, start_at: w.start_at, end_at: w.end_at };
      })
      // booking-audit codex idempotency review: supabase-js does not
      // guarantee row order without an explicit .order(); sort by `id`
      // so the same logical edit retried under the same idempotency key
      // serialises byte-identically (no spurious payload_mismatch).
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const order_patches: EditPlanOrderPatch[] = orderRows.map((r) => {
      const patch: EditPlanOrderPatch = { id: r.id };
      // Shift the order window. Three cases:
      //   - BOTH endpoints non-null → run the boundary-aligned vs
      //     custom-window classifier (shiftWindow) over the real window.
      //   - EXACTLY ONE endpoint non-null (partial window) → I-2
      //     (booking-audit remediation): treat as custom-window
      //     unconditionally. The earlier code substituted oldStart/oldEnd
      //     for the missing endpoint then ran the boundary classifier
      //     (`csMs===oldStartMs && ceMs===oldEndMs`), which misclassified
      //     a really-boundary-aligned partial order as custom-window (and
      //     could spuriously classify the synthetic pair as boundary-
      //     aligned). A partial window has no second real endpoint to
      //     anchor a boundary test, so the only sound semantics is:
      //     shift ONLY the present endpoint by startDelta and emit ONLY
      //     the key(s) that were non-null (absent key = preserve in the
      //     RPC, 00394:755-764).
      //   - BOTH null → emit no time keys (delivery_location_id may still
      //     re-point below).
      const hasStart = r.requested_for_start_at !== null;
      const hasEnd = r.requested_for_end_at !== null;
      if (hasStart && hasEnd) {
        const w = shiftWindow(
          r.requested_for_start_at as string,
          r.requested_for_end_at as string,
        );
        patch.requested_for_start_at = w.start_at;
        patch.requested_for_end_at = w.end_at;
      } else if (hasStart || hasEnd) {
        // Partial window → custom-window: shift only the present
        // endpoint(s) by startDelta. Never apply endDelta (preserve any
        // notion of the order's own offset) and never substitute the
        // booking window for the absent endpoint.
        if (hasStart) {
          patch.requested_for_start_at = new Date(
            Date.parse(r.requested_for_start_at as string) + startDeltaMs,
          ).toISOString();
        }
        if (hasEnd) {
          patch.requested_for_end_at = new Date(
            Date.parse(r.requested_for_end_at as string) + startDeltaMs,
          ).toISOString();
        }
      }
      if (spaceChanged && r.delivery_location_id === oldSpaceId) {
        patch.delivery_location_id = newSpaceId;
      }
      return patch;
    })
      // booking-audit codex idempotency review: byte-stable plan across
      // retries — sort by `id` (supabase-js has no implicit row order).
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const work_order_sla_patches: EditPlanWorkOrderSlaPatch[] = woRows
      // planned_start_at is the only field the RPC requires for a WO
      // patch (00394:858 — no `?` guard). A WO with a null
      // planned_start_at has no point to repoint; skip it rather than
      // send a null the RPC would reject on the ::timestamptz cast.
      .filter((r) => r.planned_start_at !== null)
      .map((r) => ({
        id: r.id,
        planned_start_at: new Date(
          Date.parse(r.planned_start_at as string) + startDeltaMs,
        ).toISOString(),
        needs_repoint: true,
        sla_policy_id: r.sla_id,
      }))
      // booking-audit codex idempotency review: byte-stable plan across
      // retries — sort by `id` (supabase-js has no implicit row order).
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // N-1 (booking-audit remediation): the previously-computed
    // `endDeltaMs` + its `void endDeltaMs;` "future symmetry/scope"
    // placeholder were genuinely dead — only `startDeltaMs` drives
    // custom-window + WO shifts, and boundary-aligned rows use
    // (newStart, newEnd) directly. Removed rather than kept.

    return {
      asset_reservation_patches,
      order_patches,
      work_order_sla_patches,
      skippedMultiSlot: false,
    };
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
    // audit-03 Slice 2 (D-5, STEP 3): canonical-sort the approver array
    // before serialisation. The rule-resolver approver fan-out has NO
    // guaranteed order; without this, the SAME logical edit retried
    // under the same idempotency key serialises `required_approvers` in
    // a different order → a different post-strip md5 → a spurious
    // `command_operations.payload_mismatch` 409 (a SEPARATE latent
    // ≥2-approver order-instability, sibling to the pre-state-field D-5
    // bug). The RPC's chain insert treats `required_approvers` as a SET
    // not a sequence (verified in plan review), so canonicalising the
    // order CANNOT change the approval decision / threshold /
    // parallel-group — it only makes the hashed payload byte-stable.
    // `canonicalApproverSort` is the SAME comparator `chainConfigsEqual`
    // already uses, so plan equality and the hash agree on ordering.
    return {
      required_approvers: canonicalApproverSort(approvers).map((a) => ({
        type: a.type,
        id: a.id,
      })),
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
