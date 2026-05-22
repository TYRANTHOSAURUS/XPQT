import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppErrors } from '../../common/errors';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleService } from '../booking-bundles/bundle.service';
import { bookedByUserIdForRpc } from './booked-by-user-id.util';
import { ConflictGuardService } from './conflict-guard.service';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from './reservation-projection';
import { planUuid } from '../booking-bundles/plan-uuid';
import { comparePlanSlots } from '../booking-bundles/plan-sort';
import type {
  AttachPlan,
  AttachPlanBookingSlot,
  BookingInput,
} from '../booking-bundles/attach-plan.types';
import type { ApprovalConfig } from '../room-booking-rules/dto';
import type { ActorContext, Reservation, PolicySnapshot } from './dto/types';
import { claimProducerResolutionBasis } from './producer-resolution-basis';

/**
 * Multi-room atomic create — Slice 3 of booking-audit remediation
 * (audit `docs/follow-ups/audits/03-booking-reservation.md` P1-1, `:142-154`).
 *
 * Pre-Slice-3 (the legacy choreography this replaces): the service called
 * the legacy `create_booking` RPC (00277:236-334) for booking + N slots,
 * then a SEPARATE `bundle.attachServicesToBooking` for services, wrapped in
 * `BookingTransactionBoundary.runWithCompensation` (in-process compensation
 * via `delete_booking_with_guard`). Per the boundary's own JSDoc:
 * "No durability — if the Node process crashes between operation-throw and
 * compensation-call, the booking is orphaned." There was a real window of
 * inconsistency between the RPC return and the attach commit (audit P1-1).
 *
 * Post-Slice-3: ONE atomic call to `create_booking_with_attach_plan` (00309,
 * live body 00315). That single Postgres transaction commits booking + N
 * slots + orders + OLIs + asset_reservations + approvals + setup-WO outbox
 * emissions. The combined RPC already iterates `p_booking_input->'slots'`
 * for N slots (00315:156-183) with NO >1-slot guard — multi-room is just N
 * entries in the same `slots[]` array single-room sends as 1. Atomicity is
 * a DB property; there is no TS-side compensation any more.
 *
 * `booked_by_user_id` goes through the shared `bookedByUserIdForRpc`
 * guard (booked-by-user-id.util.ts) — the SAME guard single-room uses —
 * which coerces a synthetic `system:*` sentinel user_id to NULL before
 * the `nullif(...)::uuid` bind (00315:135). There is NO F-CRIT-1
 * `auth_uid` resolution here (that lives only on the edit/cancel RPC
 * family). Slice-7 D-8: pre-guard this path bound `actor.user_id` raw —
 * a latent twin of the recurrence/Outlook 500 (no synthetic caller
 * reaches multi-room today, so it was unfired, but the guard makes the
 * single-room/multi-room parity real instead of a stale claim).
 *
 * Approval-parity (correctness improvement, NOT silent): single-room wires
 * a Phase-1.5 workflow/approval gate around the combined RPC
 * (booking-flow.service.ts:385-396); the legacy multi-room path set
 * `bookings.status='pending_approval'` but created ZERO approval rows — a
 * permanently-stuck booking with nothing to grant. Slice 3 replicates
 * single-room's room-rule approval wiring (workflow start when the matched
 * rule carries a `workflow_definition_id`, else `createApprovalRows`) so a
 * multi-room-with-a-require_approval-rule now correctly enters
 * `pending_approval` WITH approval rows, identical to single-room.
 *
 * Returns shape is byte-stable: `{ group_id, reservations[] }` where
 * `group_id` is the booking id (the atomic grouping) and each `Reservation`
 * is one slot's projection. Controller + specs depend on this; unchanged.
 */
@Injectable()
export class MultiRoomBookingService {
  private readonly log = new Logger(MultiRoomBookingService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conflict: ConflictGuardService,
    private readonly ruleResolver: RuleResolverService,
    private readonly bundle: BundleService,
    /**
     * Slice 3 approval-parity — mirrors `BookingFlowService`'s
     * Phase 1.5 sub-step 6.E wiring (booking-flow.service.ts:99-100).
     * When a matched room rule carries a populated
     * `workflow_definition_id`, start a `workflow_instance` via
     * `WorkflowService.start({entityKind:'booking'})` INSTEAD of inserting
     * legacy approval rows directly. Optional + forwardRef to keep the
     * existing multi-room specs constructible without wiring the full
     * workflow stack; the approval fan-out at the end of `createGroup`
     * checks for presence before attempting the workflow path (legacy
     * `createApprovalRows` fall-through otherwise).
     */
    @Optional()
    @Inject(forwardRef(() => WorkflowService))
    private readonly workflowService?: WorkflowService,
  ) {}

  async createGroup(
    input: {
      space_ids: string[];
      requester_person_id: string;
      start_at: string;
      end_at: string;
      attendee_count?: number;
      attendee_person_ids?: string[];
      host_person_id?: string | null;
      source?: 'portal' | 'desk' | 'api' | 'calendar_sync';
      services?: Array<{
        catalog_item_id: string;
        menu_id?: string | null;
        quantity: number;
        service_window_start_at?: string | null;
        service_window_end_at?: string | null;
        repeats_with_series?: boolean;
        linked_asset_id?: string | null;
        client_line_id?: string;
      }>;
      bundle?: {
        bundle_type?: 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';
        cost_center_id?: string | null;
        template_id?: string | null;
      };
    },
    actor: ActorContext,
  ): Promise<{ group_id: string; reservations: Reservation[] }> {
    const tenantId = TenantContext.current().id;
    const spaceIds = Array.from(new Set(input.space_ids ?? []));
    if (spaceIds.length < 2) {
      throw AppErrors.validationFailed('multi_room_requires_two', {
        detail: 'Multi-room bookings require at least two spaces.',
      });
    }
    if (spaceIds.length > 10) {
      throw AppErrors.validationFailed('multi_room_too_many', {
        detail: 'Multi-room bookings are limited to 10 spaces.',
      });
    }

    // Idempotency key — mirrors single-room's inline construction
    // (booking-flow.service.ts:519-520) EXACTLY. There is no shared
    // `booking.create` builder in packages/shared/src/idempotency.ts
    // (grep-verified — that module only carries patch/dispatch/edit/
    // cancel families); single-room uses an inline literal of this shape,
    // so multi-room mirrors the literal (a divergent shared helper would
    // be a worse outcome than two byte-identical inline literals).
    //
    // The controller's RequireClientRequestIdGuard (already on the
    // POST /reservations/multi-room route, reservation.controller.ts:151)
    // guarantees `actor.client_request_id` on real HTTP requests; the
    // randomUUID fallback is for synthetic/legacy callers that construct
    // an ActorContext without going through the controller (no retry
    // semantics expected there — same rationale as single-room :515-519).
    const clientRequestId = actor.client_request_id ?? randomUUID();
    const idempotencyKey = `booking.create:${actor.user_id}:${clientRequestId}`;
    const resolutionBasisAt =
      actor.resolution_basis_at ??
      (await claimProducerResolutionBasis({
        supabase: this.supabase,
        tenantId,
        idempotencyKey,
        producer: 'booking.create.multi_room',
        log: this.log,
      }));

    // 1. Per-room rule resolution + space hydration. We resolve rules
    //    per-room because each room can have a distinct rule set (e.g.
    //    catering required for room A, not B). The most restrictive
    //    outcome wins for the booking-level status. (Loop preserved
    //    byte-for-byte from the legacy path.)
    const spaceRows = await this.loadSpaces(tenantId, spaceIds);
    const denialMessages: string[] = [];
    let anyRequireApproval = false;
    const matchedRuleIds = new Set<string>();
    // Slice 3 approval-parity (FIX 2 — priority-correct cross-room
    // aggregation). Single-room consumes ONE prioritized resolver outcome
    // and trusts the resolver's per-resolve winner pair directly
    // (booking-flow.service.ts:385-396 uses `ruleOutcome.approvalConfig` /
    // `ruleOutcome.approvalWorkflowDefinitionId` — NOT a re-derivation).
    // The resolver picks that winner by most-specific-then-highest-priority
    // (rule-resolver.service.ts:541-542 — `r.specificity <
    // approvalSpecificity || (r.specificity === approvalSpecificity &&
    // r.priority > approvalPriority)`).
    //
    // Multi-room does N independent resolves (one per room). Naively
    // keeping the FIRST require_approval outcome in *space order* is
    // arbitrary and can wire a low-priority rule's approvers when a
    // higher-priority require_approval rule matched a different room. We
    // instead pick, ACROSS rooms, the room whose winning require_approval
    // rule ranks highest under the resolver's IDENTICAL comparator, and
    // take THAT room's resolver-authoritative outcome pair — semantically
    // equal to single-room's one aggregated outcome. Each room's rank is
    // its best (most-specific-then-highest-priority) require_approval
    // matched rule (`ruleOutcome.matchedRules`), the same set the resolver
    // itself chose its per-resolve winner from.
    let approvalConfig: ApprovalConfig | null = null;
    let approvalWorkflowDefinitionId: string | null = null;
    // Rank of the currently-selected room's winning require_approval rule
    // (lower specificity wins; tie-break higher priority). null = nothing
    // selected yet.
    let approvalRank: { specificity: number; priority: number } | null = null;
    const slotSpecs: Array<{
      slot_type: 'room' | 'desk' | 'asset' | 'parking';
      space_id: string;
      start_at: string;
      end_at: string;
      attendee_count: number | null;
      attendee_person_ids: string[];
      setup_buffer_minutes: number;
      teardown_buffer_minutes: number;
      check_in_required: boolean;
      check_in_grace_minutes: number;
      display_order: number;
    }> = [];

    let displayOrder = 0;
    for (const spaceId of spaceIds) {
      const space = spaceRows.get(spaceId);
      if (!space) {
        throw AppErrors.notFoundWithCode('space_not_found', `Space ${spaceId}`);
      }
      if (!space.active) {
        throw AppErrors.validationFailed('space_inactive', { detail: `Space ${spaceId}` });
      }
      if (!space.reservable) {
        throw AppErrors.validationFailed('space_not_reservable', { detail: `Space ${spaceId}` });
      }

      const buffers = await this.conflict.snapshotBuffersForBooking({
        tenant_id: tenantId,
        space_id: spaceId,
        requester_person_id: input.requester_person_id,
        start_at: input.start_at,
        end_at: input.end_at,
        room_setup_buffer_minutes: space.setup_buffer_minutes ?? 0,
        room_teardown_buffer_minutes: space.teardown_buffer_minutes ?? 0,
      });

      const ruleOutcome = await this.ruleResolver.resolve(
        {
          requester_person_id: input.requester_person_id,
          space_id: spaceId,
          start_at: input.start_at,
          end_at: input.end_at,
          attendee_count: input.attendee_count ?? null,
          criteria: {},
          resolution_basis_at: resolutionBasisAt,
        },
        tenantId,
      );
      ruleOutcome.matchedRules.forEach((r) => matchedRuleIds.add(r.id));
      if (ruleOutcome.final === 'deny') {
        const overridable = actor.has_override_rules && ruleOutcome.overridable;
        if (!overridable) {
          throw AppErrors.forbidden('rule_deny', ruleOutcome.denialMessages[0] || `Booking denied by booking rules (space ${spaceId}).`);
        }
        if (!actor.override_reason) {
          throw AppErrors.validationFailed('override_reason_required', {
            detail: 'Service-desk override requires a reason.',
          });
        }
        denialMessages.push(...ruleOutcome.denialMessages);
      }
      if (ruleOutcome.final === 'require_approval') {
        anyRequireApproval = true;
        // This room's winning require_approval rule rank — the SAME
        // most-specific-then-highest-priority pick the resolver made
        // internally to produce `ruleOutcome.approvalConfig`
        // (rule-resolver.service.ts:541-552). Mirror that comparator
        // exactly over this room's require_approval matched rules.
        let roomRank: { specificity: number; priority: number } | null = null;
        for (const r of ruleOutcome.matchedRules) {
          if (r.effect !== 'require_approval') continue;
          if (
            roomRank === null ||
            r.specificity < roomRank.specificity ||
            (r.specificity === roomRank.specificity && r.priority > roomRank.priority)
          ) {
            roomRank = { specificity: r.specificity, priority: r.priority };
          }
        }
        // Adopt this room's resolver-AUTHORITATIVE pair
        // (`ruleOutcome.approvalConfig` / `…WorkflowDefinitionId` — the
        // exact values single-room consumes) when this room ranks higher
        // than the running winner. If `matchedRules` is empty but the
        // resolver still produced a require_approval outcome with a config
        // (the contract single-room trusts at booking-flow.service.ts:385),
        // treat it as the lowest-priority rank so a lone such room still
        // wires its approvers — never silently drop a require_approval.
        const effectiveRank =
          roomRank ?? { specificity: Infinity, priority: -Infinity };
        if (
          approvalRank === null ||
          effectiveRank.specificity < approvalRank.specificity ||
          (effectiveRank.specificity === approvalRank.specificity &&
            effectiveRank.priority > approvalRank.priority)
        ) {
          approvalRank = effectiveRank;
          approvalConfig = ruleOutcome.approvalConfig;
          approvalWorkflowDefinitionId =
            ruleOutcome.approvalWorkflowDefinitionId ?? null;
        }
      }

      slotSpecs.push({
        slot_type: 'room',
        space_id: spaceId,
        start_at: input.start_at,
        end_at: input.end_at,
        attendee_count: input.attendee_count ?? null,
        attendee_person_ids: input.attendee_person_ids ?? [],
        setup_buffer_minutes: buffers.setup_buffer_minutes,
        teardown_buffer_minutes: buffers.teardown_buffer_minutes,
        check_in_required: space.check_in_required ?? false,
        check_in_grace_minutes: space.check_in_grace_minutes ?? 15,
        display_order: displayOrder++,
      });
    }

    // (FIX 2 cross-room approval winner is selected inline in the per-room
    // loop above — `approvalConfig`/`approvalWorkflowDefinitionId` already
    // hold the highest-ranked room's resolver-authoritative pair.)

    // 2. Resolve source. Booking-audit Slice 8 (audit 03 P2-2, 2026-05-17)
    //    — the `'auto'` intermediate was removed; this producer now resolves
    //    to a DB-CHECK-valid `bookings.source` value INLINE (mirroring the
    //    booking-flow consumer's prior actor-prefix rule, verbatim
    //    semantics): a `system:*` actor maps to `'recurrence'` when it is
    //    the recurrence materialiser, else `'calendar_sync'`; a real caller
    //    keeps its explicit `input.source` (default `'portal'`). The new
    //    `bookings.source` CHECK (00295) rejects `'auto'`, and it is no
    //    longer in the `ReservationSource` union.
    const bookingSource: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence' =
      actor.user_id.startsWith('system:')
        ? actor.user_id.startsWith('system:recurrence')
          ? 'recurrence'
          : 'calendar_sync'
        : input.source ?? 'portal';

    const status: 'pending_approval' | 'confirmed' = anyRequireApproval ? 'pending_approval' : 'confirmed';
    const policySnapshot: PolicySnapshot = {
      matched_rule_ids: Array.from(matchedRuleIds),
      effects_seen: [],
    };

    // 3. Build the N-slot BookingInput (mirrors single-room's
    //    booking-flow.service.ts:905-954). booking_id + slot ids are
    //    deterministic via planUuid (plan-uuid.ts:11-20 contract), so a
    //    TS retry of the same logical request rebuilds an identical plan
    //    and hits attach_operations.cached_result instead of inserting a
    //    duplicate booking. INVARIANT (parity, not a regression): idempotent
    //    replay assumes the room-rule state is unchanged between the first
    //    attempt and the retry. If a matched rule's effect flips (e.g.
    //    require_approval → deny, or a buffer change) between attempts, the
    //    rebuilt plan no longer hashes to the cached payload and the
    //    combined RPC raises `attach_operations.payload_mismatch` → 409
    //    (booking.idempotency_payload_mismatch). This is IDENTICAL to
    //    single-room's behavior under the same mid-flight rule flip — the
    //    determinism guarantee is over a stable rule state, not over time.
    const bookingId = planUuid(idempotencyKey, 'booking', '0');
    const primarySpaceId = spaceIds[0];

    const slots: AttachPlanBookingSlot[] = slotSpecs
      .map((s) => ({
        id: planUuid(idempotencyKey, 'slot', String(s.display_order)),
        slot_type: s.slot_type,
        space_id: s.space_id,
        start_at: s.start_at,
        end_at: s.end_at,
        attendee_count: s.attendee_count,
        attendee_person_ids: s.attendee_person_ids,
        setup_buffer_minutes: s.setup_buffer_minutes,
        teardown_buffer_minutes: s.teardown_buffer_minutes,
        check_in_required: s.check_in_required,
        check_in_grace_minutes: s.check_in_grace_minutes,
        display_order: s.display_order,
      }))
      .sort(comparePlanSlots);
    const slotIds = slots.map((s) => s.id);

    const bookingInput: BookingInput = {
      booking_id: bookingId,
      slot_ids: slotIds,
      requester_person_id: input.requester_person_id,
      host_person_id: input.host_person_id ?? null,
      // Shared D-8 guard — system:* sentinel → null before the 00315:135
      // nullif()::uuid bind. No F-CRIT-1 here. Same guard single-room uses.
      booked_by_user_id: bookedByUserIdForRpc(actor),
      location_id: primarySpaceId,            // booking-level anchor; slots hold per-room space
      start_at: input.start_at,
      end_at: input.end_at,
      timezone: 'UTC',
      status,
      source: bookingSource,
      title: null,
      description: null,
      cost_center_id: input.bundle?.cost_center_id ?? null,
      cost_amount_snapshot: null,
      policy_snapshot: policySnapshot as unknown as Record<string, unknown>,
      applied_rule_ids: Array.from(matchedRuleIds),
      config_release_id: null,
      recurrence_series_id: null,
      recurrence_index: null,
      template_id: input.bundle?.template_id ?? null,
      slots,
    };

    // 4. Build the AttachPlan via the EXISTING slot-agnostic
    //    `bundle.buildAttachPlan` — the SAME builder single-room uses
    //    (booking-flow.service.ts:965-988). NOT refactored. When no
    //    services, build the empty plan inline (identical to single-room
    //    :990-1008) so the combined RPC's empty-array iterations are
    //    cheap no-ops.
    let attachPlan: AttachPlan;
    if (input.services && input.services.length > 0) {
      attachPlan = await this.bundle.buildAttachPlan({
        booking_id: bookingId,
        tenant_id: tenantId,
        booking: {
          location_id: primarySpaceId,
          requester_person_id: input.requester_person_id,
          host_person_id: input.host_person_id ?? null,
          start_at: input.start_at,
          end_at: input.end_at,
          attendee_count: input.attendee_count ?? null,
          source: bookingSource,
        },
        requester_person_id: input.requester_person_id,
        bundle: input.bundle
          ? {
              bundle_type: input.bundle.bundle_type,
              cost_center_id: input.bundle.cost_center_id ?? null,
              template_id: input.bundle.template_id ?? null,
              source: bookingSource,
            }
          : { source: bookingSource },
        services: input.services,
        idempotency_key: idempotencyKey,
        resolution_basis_at: resolutionBasisAt,
      });
    } else {
      attachPlan = {
        version: 1,
        any_pending_approval: false,
        any_deny: false,
        deny_messages: [],
        orders: [],
        asset_reservations: [],
        order_line_items: [],
        approvals: [],
        bundle_audit_payload: {
          bundle_id: bookingId,
          booking_id: bookingId,
          order_ids: [],
          order_line_item_ids: [],
          asset_reservation_ids: [],
          approval_ids: [],
          any_pending_approval: false,
        },
      };
    }

    this.log.log(
      `[multi-room create-with-attach-plan] booking=${bookingId} rooms=${spaceIds.length} services=${input.services?.length ?? 0} idem=${idempotencyKey}`,
    );

    // 5. ── ONE atomic combined RPC ──────────────────────────────────────
    //    The booking_slots_no_overlap GiST exclusion (00277:212-217) fires
    //    INSIDE this transaction for ANY conflicting room; the whole tx
    //    (booking + every slot + orders + OLIs + ARs + approvals + outbox)
    //    rolls back as a unit and the attach_operations marker goes with
    //    it. No partial group, no orphan service rows.
    const { data: rpcData, error: rpcError } = await this.supabase.admin.rpc(
      'create_booking_with_attach_plan',
      {
        p_booking_input: bookingInput,
        p_attach_plan: attachPlan,
        p_tenant_id: tenantId,
        p_idempotency_key: idempotencyKey,
      },
    );

    if (rpcError) {
      throw this.mapAttachPlanRpcError(rpcError, spaceIds);
    }

    const result = (rpcData ?? null) as
      | {
          booking_id: string;
          slot_ids: string[];
          order_ids: string[];
          order_line_item_ids: string[];
          asset_reservation_ids: string[];
          approval_ids: string[];
          any_pending_approval: boolean;
        }
      | null;
    if (!result?.booking_id) {
      throw AppErrors.server('booking.unexpected_error', {
        detail: 'create_booking_with_attach_plan returned no booking_id (multi-room)',
      });
    }

    // 6. Approval fan-out (Slice 3 approval-parity). Mirrors single-room's
    //    booking-flow.service.ts:385-396 EXACTLY. The combined RPC's
    //    `attachPlan.approvals[]` covers SERVICE-rule approvals only
    //    (ApprovalRoutingService.assemblePlan); ROOM-rule approvals are
    //    still TS-side, same as single-room. Without this, a multi-room
    //    booking matching a require_approval ROOM rule landed
    //    `pending_approval` with zero approval rows — permanently stuck
    //    (the legacy multi-room bug this slice fixes; honest, not silent).
    if (status === 'pending_approval' && approvalConfig) {
      if (this.workflowService && approvalWorkflowDefinitionId) {
        if (!(await this.hasActiveBookingWorkflow(bookingId, tenantId))) {
          await this.workflowService.start({
            definitionId: approvalWorkflowDefinitionId,
            entityKind: 'booking',
            entityId: bookingId,
            tenantId,
          });
        }
      } else {
        await this.createApprovalRows(bookingId, approvalConfig, tenantId);
      }
    }

    // 7. Read the slots back through the booking for the response shape
    //    (unchanged from the legacy path — byte-stable Reservation[]).
    const { data: slotRows, error: readErr } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .order('display_order', { ascending: true });
    if (readErr || !slotRows) {
      // C3+I4: DB-side read failure → server-class, no readErr.message interpolation.
      throw AppErrors.server('multi_room_read_failed');
    }
    const reservations = (slotRows as unknown as SlotWithBookingEmbed[]).map(
      slotWithBookingToReservation,
    );

    // Audit — one event per group create (best-effort, unchanged).
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking.multi_room_created',
        entity_type: 'booking',
        entity_id: bookingId,
        details: {
          space_ids: spaceIds,
          slot_ids: result.slot_ids,
          order_ids: result.order_ids,
          order_line_item_ids: result.order_line_item_ids,
          asset_reservation_ids: result.asset_reservation_ids,
          approval_ids: result.approval_ids,
          requester_person_id: input.requester_person_id,
          start_at: input.start_at,
          end_at: input.end_at,
          idempotency_key: idempotencyKey,
          via: 'create_booking_with_attach_plan',
        },
      });
    } catch { /* best-effort */ }

    this.log.log(`multi_room booking ${bookingId}: ${spaceIds.length} rooms (atomic)`);
    return { group_id: bookingId, reservations };
  }

  // === helpers ===

  /**
   * Map a `create_booking_with_attach_plan` PostgREST error to an AppError.
   *
   * Mirrors single-room's `BookingFlowService.mapAttachPlanRpcError`
   * (booking-flow.service.ts:671-776) — the SAME registered codes the
   * single-room path emits today (already in `packages/shared/src/
   * error-codes.ts` + messages.en/nl; `errors:check-app-errors` stays
   * clean — no raw `Error`). The ONE deliberate divergence is the GiST
   * (23P01) branch: multi-room keeps its long-standing `multi_room_
   * booking_failed` (409) code which surfaces ALL room ids in one message
   * (better UX for an N-room atomic group, and the controller/spec
   * already depend on it). The picker-alternatives lookup single-room
   * does is single-space only — not meaningful for an N-room group, so
   * it is intentionally omitted.
   */
  private mapAttachPlanRpcError(
    rpcError: { code?: string; message?: string },
    spaceIds: string[],
  ): Error {
    const code = rpcError.code ?? '';
    const message = rpcError.message ?? '';

    // GiST exclusion — booking_slots_no_overlap. One or more rooms became
    // unavailable; the whole atomic group failed. No partial bookings.
    if (this.conflict.isExclusionViolation(rpcError as never)) {
      return AppErrors.conflict('multi_room_booking_failed', {
        detail: `One or more rooms are no longer available (rooms=${spaceIds.join(',')}). No partial bookings created.`,
      });
    }

    // Idempotency payload mismatch — same key, different payload.
    if (message.includes('attach_operations.payload_mismatch')) {
      return AppErrors.conflict('booking.idempotency_payload_mismatch', {
        detail:
          'A retry of this booking attempt arrived with different content. ' +
          'Re-submit with a fresh request id, or refresh and try again.',
      });
    }

    // Tenant-FK validation — `attach_plan.fk_invalid: <field>`
    // (validate_attach_plan_tenant_fks, 00303). Spec §8.1.
    if (message.includes('attach_plan.fk_invalid')) {
      return AppErrors.validationFailed('booking.fk_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }

    // Snapshot UUID validation — applied_rule_ids[] / setup rule_ids[] /
    // approval reasons[].rule_id (validate_attach_plan_internal_refs,
    // 00304, errcode 42501). Spec §8.2.
    if (message.includes('attach_plan.internal_refs') && code === '42501') {
      return AppErrors.validationFailed('booking.snapshot_uuid_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }

    // Internal cross-reference validation — order_line_items[].order_id
    // not in plan.orders[], etc. Spec §8.2.
    if (message.includes('attach_plan.internal_refs')) {
      return AppErrors.validationFailed('booking.internal_ref_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }

    // Service rule deny — pre-flight any_deny short-circuit inside the RPC
    // (00315:106-110, errcode P0001).
    if (message.includes('service_rule_deny')) {
      return AppErrors.validationFailed('service_rule_deny', {
        detail: this.extractRaiseMessage(message),
      });
    }

    // Catch-all — surface the raw message so ops can triage; server-class.
    this.log.error(
      `multi-room create_booking_with_attach_plan unexpected error: code=${code} message=${message}`,
    );
    return AppErrors.server('booking.unexpected_error', {
      detail: message || 'Unexpected error during multi-room booking creation.',
    });
  }

  /** Strip the `prefix: ` part of a `RAISE EXCEPTION` message so callers
   *  can present the human-readable tail. Mirrors
   *  booking-flow.service.ts:780-783. */
  private extractRaiseMessage(raw: string): string {
    const idx = raw.indexOf(': ');
    return idx >= 0 ? raw.slice(idx + 2) : raw;
  }

  /**
   * Create approvals rows from a matched room rule's approval_config.
   * Single-step or parallel/sequential honoured by `threshold`.
   *
   * Byte-for-byte mirror of `BookingFlowService.createApprovalRows`
   * (booking-flow.service.ts:1208-1241) — that method is `private` on
   * BookingFlowService and the Slice 3 brief mandates Option B (do NOT
   * modify booking-flow.service.ts). Replicating the small body here is
   * the lower-blast-radius choice over exposing a shared helper that
   * would touch the single-room file. Keep in lockstep with single-room.
   */
  private async createApprovalRows(
    bookingId: string,
    config: ApprovalConfig,
    tenantId: string,
  ): Promise<void> {
    const approvers = config.required_approvers ?? [];
    if (approvers.length === 0) return;
    if (await this.hasRoomApprovalRows(bookingId, tenantId)) return;
    const chainThreshold: 'all' | 'any' = config.threshold ?? 'all';
    const parallelGroup = chainThreshold === 'all' ? `parallel-${bookingId}` : null;
    // One shared approval_chain_id per call — all approvers on a single
    // booking share it. Mirrors the engine path + single-room. Without
    // chain_id the inbox fan-out trigger (00402) gates on
    // `approval_chain_id IS NOT NULL` and silently no-ops, leaving
    // approvers un-notified on a freshly-created booking.
    const approvalChainId = randomUUID();

    const rows = approvers.map((a) => ({
      tenant_id: tenantId,
      target_entity_type: 'booking',
      target_entity_id: bookingId,
      approval_chain_id: approvalChainId,
      parallel_group: parallelGroup,
      chain_threshold: chainThreshold,
      approver_person_id: a.type === 'person' ? a.id : null,
      approver_team_id: a.type === 'team' ? a.id : null,
      status: 'pending',
    }));

    const { error } = await this.supabase.admin.from('approvals').insert(rows);
    if (error) {
      throw AppErrors.server('booking.unexpected_error', {
        detail: `multi-room approval rows insert failed for booking=${bookingId}`,
        cause: error,
      });
    }
  }

  private async hasActiveBookingWorkflow(
    bookingId: string,
    tenantId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.admin
      .from('workflow_instances')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .in('status', ['active', 'waiting'])
      .limit(1)
      .maybeSingle();
    if (error) {
      throw AppErrors.server('booking.unexpected_error', {
        detail: `workflow instance read failed for booking=${bookingId}`,
        cause: error,
      });
    }
    return Boolean(data);
  }

  private async hasRoomApprovalRows(
    bookingId: string,
    tenantId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('target_entity_type', 'booking')
      .eq('target_entity_id', bookingId)
      .not('approval_chain_id', 'is', null)
      .in('status', ['pending', 'approved'])
      .limit(1)
      .maybeSingle();
    if (error) {
      throw AppErrors.server('booking.unexpected_error', {
        detail: `approval row read failed for booking=${bookingId}`,
        cause: error,
      });
    }
    return Boolean(data);
  }

  private async loadSpaces(
    tenantId: string,
    spaceIds: string[],
  ): Promise<Map<string, {
    id: string; type: string; reservable: boolean; active: boolean;
    setup_buffer_minutes: number | null; teardown_buffer_minutes: number | null;
    check_in_required: boolean | null; check_in_grace_minutes: number | null;
  }>> {
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('id, type, reservable, active, setup_buffer_minutes, teardown_buffer_minutes, check_in_required, check_in_grace_minutes')
      .eq('tenant_id', tenantId)
      .in('id', spaceIds);
    // C3+I4: DB-side read failure → server-class, no pgErr.message interpolation.
    if (error) throw AppErrors.server('load_spaces_failed');
    const out = new Map<string, {
      id: string; type: string; reservable: boolean; active: boolean;
      setup_buffer_minutes: number | null; teardown_buffer_minutes: number | null;
      check_in_required: boolean | null; check_in_grace_minutes: number | null;
    }>();
    for (const row of (data ?? []) as Array<{
      id: string; type: string; reservable: boolean; active: boolean;
      setup_buffer_minutes: number | null; teardown_buffer_minutes: number | null;
      check_in_required: boolean | null; check_in_grace_minutes: number | null;
    }>) {
      out.set(row.id, row);
    }
    return out;
  }
}
