import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppErrors } from '../../common/errors';
import { WorkflowService } from '../workflow/workflow.service';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import { ConflictGuardService } from './conflict-guard.service';
import { RecurrenceService } from './recurrence.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { BundleService } from '../booking-bundles/bundle.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import type {
  ActorContext, Booking, CreateReservationInput, PolicySnapshot,
  Reservation,
} from './dto/types';
import type {
  AttachPlan,
  AttachPlanBookingSlot,
  BookingInput,
} from '../booking-bundles/attach-plan.types';
import { planUuid } from '../booking-bundles/plan-uuid';
import { comparePlanSlots } from '../booking-bundles/plan-sort';
import { canonicalApproverSort } from './edit-plan-helpers';
import type { AttachPlanApproval } from '../booking-bundles/attach-plan.types';

// Booking-audit Slice 7 — discovered finding D-8 (pre-existing P1, NOT
// Slice-7-caused). System/Outlook synthetic actors carry a non-uuid
// `system:*` sentinel user_id that 500'd the create-RPC uuid booker bind.
// Single shared guard (full rationale + git-blame in the util):
import { bookedByUserIdForRpc } from './booked-by-user-id.util';

/**
 * BookingFlowService — the canonical create-a-booking pipeline.
 *
 * This is the only path that should create rows in `bookings` + `booking_slots`.
 * The portal, desk scheduler, calendar-sync intercept, and recurrence
 * materialiser all funnel through here.
 *
 * Pipeline (post-canonicalisation 2026-05-02):
 *   1. Load + verify the space (active, reservable)
 *   2. Snapshot buffers/check-in/cost from the space
 *   3. Apply same-requester back-to-back buffer collapse
 *   4. Resolve booking rules via RuleResolverService
 *   5. Handle deny / require_approval / override
 *   6. Compute status + policy_snapshot
 *   7. CALL `create_booking` RPC — single Postgres function inserts the
 *      booking row + N slot rows atomically (00277:236-334). The slot
 *      `booking_slots_no_overlap` GiST exclusion (00277:211-217) catches
 *      concurrent races and surfaces as 23P01.
 *   8. Fan out side effects (approval row creation; event emission;
 *      notifications + calendar sync are TODOs wired in Phase J / H)
 *
 * Return shape: `Booking` — the just-inserted bookings row. Slots are
 * accessible via the returned `booking.id` if a downstream caller needs them
 * (today nothing in the create-time pipeline reads back individual slot rows;
 * the legacy `Reservation`-flat shape is still synthesized for transitional
 * consumers via `bookingToLegacyReservation` below).
 */
@Injectable()
export class BookingFlowService {
  private readonly log = new Logger(BookingFlowService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conflict: ConflictGuardService,
    private readonly ruleResolver: RuleResolverService,
    @Optional() private readonly recurrence?: RecurrenceService,
    @Optional() private readonly notifications?: BookingNotificationsService,
    @Optional() private readonly bundle?: BundleService,
    /** Used on 409 conflict to suggest 3 alternative rooms at the same
     *  time/criteria so the user can one-click rebook instead of redoing
     *  the whole reservation. Optional to keep specs that mock booking-flow
     *  without needing the full picker pipeline. */
    @Optional() private readonly picker?: ListBookableRoomsService,
    // Booking-audit Slice 7 (audit 03 P2-1): the dead `@Optional()`
    // txBoundary / compensation injects (BookingTransactionBoundary +
    // BookingCompensationService) were removed. They were already a
    // verified no-op here since P1-1 (B.0.D.2 made `create()` atomic via
    // `create_booking_with_attach_plan`; the only remaining boundary
    // caller was the recurrence occurrence-clone, now ported to a direct
    // `delete_booking_with_guard` call in RecurrenceService). Both legacy
    // classes are deleted.
    /**
     * Phase 1.5 sub-step 6.E — when a matched rule carries a populated
     * `workflow_definition_id`, start a workflow_instance via
     * `WorkflowService.start({entityKind: 'booking'})` INSTEAD of the
     * legacy `createApprovalRows` path. Optional + forwardRef to keep the
     * existing booking-flow specs constructible without wiring the full
     * workflow stack; the cutover at line ~360 checks for presence before
     * attempting the workflow path.
     */
    @Optional() @Inject(forwardRef(() => WorkflowService))
    private readonly workflowService?: WorkflowService,
  ) {}

  /**
   * Run the full pipeline and atomically create one Booking + N BookingSlot
   * rows via the combined `create_booking_with_attach_plan` RPC
   * (00277-shaped booking + slots + any orders/OLIs/asset_reservations/
   * approvals + outbox emissions, ONE transaction), or throw a structured
   * error.
   *
   * audit-03 P2-3 (deferred-closeout) — the legacy 20-arg `create_booking`
   * RPC (00277:236-334) + `createApprovalRows` were RETIRED. ALL single-room
   * creates (with OR without services) now route through
   * `createWithAttachPlan`:
   *   - The two paths had diverged: with-services was atomic
   *     (B.0.D.2 cutover) while no-services kept the non-atomic
   *     create_booking + best-effort `createApprovalRows`. Two RPC
   *     families, two approval-row code paths, two idempotency stories.
   *   - The combined RPC's step-10 approvals INSERT was extended 7→11 cols
   *     (migration 00431) so the no-services FLAT approval case is now
   *     committed IN-TRANSACTION with chain-aware columns → inbox-notified
   *     (the 00402 trigger fires; pre-P2-3 a no-services pending-approval
   *     booking created via the *combined* RPC had approval_chain_id=NULL
   *     and was silently un-notified — that path is now correct).
   *   - WORKFLOW-DEF approval rules (rule carries
   *     `workflow_definition_id`) keep the engine-owned path: the plan
   *     emits NO approval rows; `createWithAttachPlan` starts the
   *     workflow_instance POST-RPC (parity with the legacy `create`
   *     fan-out — equivalent, not improved, deferred-with-owner).
   *
   * Single-room only — multi-room batches multiple slot specs into one RPC
   * call (MultiRoomBookingService, separate path).
   *
   * Returns a transitional `Reservation` shim whose `id` is the BOOKING id
   * (`bookings.id`). Approval rows use `target_entity_type='booking'`.
   *
   * Errors:
   *   - 403 'rule_deny' — a deny rule fired and the actor cannot override
   *   - 409 'booking.slot_conflict' — `booking_slots_no_overlap` GiST
   *     exclusion (00277:211-217) rejected; alternatives populated via picker
   *   - 400 'invalid_input' — basic validation failures
   */
  async create(input: CreateReservationInput, actor: ActorContext): Promise<Reservation> {
    this.assertValid(input);
    const tenantId = TenantContext.current().id;
    this.log.log(
      `[create] space=${input.space_id} services_len=${input.services?.length ?? 0} bundle_present=${!!input.bundle} source=${input.source ?? 'portal'}`,
    );

    // audit-03 P2-3 cutover — ALL single-room creates (with OR without
    // services) go through the combined RPC `create_booking_with_attach_
    // plan` (one transaction commits booking + slots + any orders/
    // asset_reservations/OLIs/approvals + outbox emissions). The legacy
    // 20-arg `create_booking` RPC path + `createApprovalRows` are deleted.
    // `buildAttachPlan` produces an empty service graph for the no-services
    // case, plus (FLAT approval case) the deterministic chain-aware
    // approval rows the 00431 RPC commits in-transaction.
    //
    // Spec §3.1 + §7.6 of
    // docs/superpowers/specs/2026-05-04-domain-outbox-design.md +
    // docs/follow-ups/audit03-deferred-p2-3-decision.md.
    return this.createWithAttachPlan(input, actor, tenantId);
  }

  /**
   * B.0.D.2 — combined-RPC path: booking WITH services. Calls
   * `buildAttachPlan` to produce `{ bookingInput, attachPlan }`, then
   * invokes `create_booking_with_attach_plan` (00309 / spec §7.6) which
   * commits booking + slots + orders + asset_reservations + OLIs +
   * approvals + outbox emissions in one transaction. No in-process
   * compensation needed — the RPC is atomic; if any insert fails the
   * whole transaction rolls back and `attach_operations` doesn't persist.
   *
   * Idempotency key construction (spec §3.3):
   *   `booking.create:${actor.user_id}:${actor.client_request_id}`
   *
   * Two distinct user clicks on the form get different `client_request_id`
   * values (mutation-attempt scope on the client). React Query retries of
   * the SAME click reuse the same id, hitting the `attach_operations`
   * cached_result row and returning the prior result without re-inserting.
   *
   * Error mapping (spec §7.6, §3.1):
   *   - 23505 / `attach_operations.payload_mismatch` (P0001) → 409
   *     `booking.idempotency_payload_mismatch`
   *   - 23P01 (booking_slots_no_overlap GiST exclusion) → existing
   *     `reservation_slot_conflict` mapping with picker alternatives
   *   - 42501 with `attach_plan.fk_invalid: …` → 400
   *     `booking.fk_invalid`
   *   - 22023 with `attach_plan.internal_refs: …` → 400
   *     `booking.internal_ref_invalid`
   *   - 42501 with `…rule_ids[]` / `applied_rule_ids[]` →
   *     `booking.snapshot_uuid_invalid`
   *   - P0001 `service_rule_deny: …` → 400 with structured deny payload
   *   - other → 500 `booking.unexpected_error`
   */
  private async createWithAttachPlan(
    input: CreateReservationInput,
    actor: ActorContext,
    tenantId: string,
  ): Promise<Reservation> {
    if (!this.bundle) {
      throw AppErrors.server('booking.bundle_not_injected', {
        detail: 'BundleService not injected — booking-flow cannot build attach plan.',
      });
    }

    // Idempotency key — spec §3.3 producer-wiring table. Falls back to a
    // local randomUUID when the actor has no client_request_id (legacy
    // tests or the recurrence materialiser construct ActorContext
    // directly without going through the controller — they get a random
    // key per call which is correct: no retry semantics expected there).
    const clientRequestId = actor.client_request_id ?? randomUUID();
    const idempotencyKey = `booking.create:${actor.user_id}:${clientRequestId}`;

    // Build the plan (TS-side: rule resolver, approval routing, deterministic
    // UUIDs). Throws on rule deny, override-reason missing, basic input
    // validation — same gates as the no-services path's `create` body.
    const { bookingInput, attachPlan, approvalCutover } =
      await this.buildAttachPlan(input, actor, idempotencyKey);

    this.log.log(
      `[create-with-attach-plan] booking=${bookingInput.booking_id} services=${input.services?.length ?? 0} idem=${idempotencyKey}`,
    );

    // ── Atomic combined RPC ─────────────────────────────────────────
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
      throw await this.mapAttachPlanRpcError(rpcError, input, bookingInput, actor, tenantId);
    }

    // RPC returns the cached_result jsonb. supabase-js surfaces it directly.
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
        detail: 'create_booking_with_attach_plan returned no booking_id',
      });
    }

    // Re-read the booking row so downstream consumers (notifications,
    // audit, recurrence) see the server-canonical state (defaults filled
    // in, updated_at, etc.). Same shape as the no-services path's re-read.
    const { data: bookingRow, error: readErr } = await this.supabase.admin
      .from('bookings')
      .select('*')
      .eq('id', result.booking_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (readErr || !bookingRow) {
      this.log.error(`booking re-read failed after combined RPC: ${readErr?.message ?? 'no row'}`);
      throw AppErrors.server('booking.unexpected_error', { cause: readErr });
    }
    const booking = bookingRow as unknown as Booking;

    // The plan builder already canonicalised slot_type + source on the
    // bookingInput; reuse those for the legacy projection (no need to
    // recompute). The plan's first slot is the primary (display_order=0).
    const primarySlot = bookingInput.slots[0];
    const reservation: Reservation = bookingToLegacyReservation(
      booking,
      {
        slot_type: primarySlot.slot_type,
        space_id: primarySlot.space_id,
        start_at: primarySlot.start_at,
        end_at: primarySlot.end_at,
        attendee_count: primarySlot.attendee_count,
        attendee_person_ids: primarySlot.attendee_person_ids,
        setup_buffer_minutes: primarySlot.setup_buffer_minutes,
        teardown_buffer_minutes: primarySlot.teardown_buffer_minutes,
        check_in_required: primarySlot.check_in_required,
        check_in_grace_minutes: primarySlot.check_in_grace_minutes,
      },
      primarySlot.id,
      bookingInput.applied_rule_ids,
      bookingInput.source,
      primarySlot.slot_type,
    );

    // ── audit-03 P2-3 STEP D — WORKFLOW-DEF post-RPC hybrid ─────────────
    //
    // When the matched room rule carries a `workflow_definition_id`, the
    // plan emitted NO approval rows (the workflow engine owns them). Start
    // the workflow_instance now — POST-RPC, best-effort, mirroring the
    // legacy `create` fan-out (old :367-373). The booking already committed
    // atomically; the workflow start is the SAME best-effort post-commit
    // step it always was on this rule class (equivalent — NOT improved,
    // NOT regressed; engine-owned approval rows, deferred-with-owner per
    // docs/follow-ups/audit03-deferred-p2-3-decision.md).
    //
    // The FLAT approval case needs NO post-RPC work here: its approval rows
    // (with the deterministic shared chain_id) were committed
    // IN-TRANSACTION by the 00431 RPC, and the 00402 AFTER INSERT trigger
    // already fanned out the inbox notifications. Double-notify is
    // impossible — the trigger is the ONLY notification path for FLAT rows
    // now (no TS-side onApprovalRequested call here), and its
    // ON CONFLICT (tenant_id,user_id,event_kind,chain_id) DO NOTHING makes
    // even a retried insert idempotent.
    if (
      this.workflowService &&
      approvalCutover.workflowDefinitionId &&
      approvalCutover.status === 'pending_approval'
    ) {
      try {
        await this.workflowService.start({
          definitionId: approvalCutover.workflowDefinitionId,
          entityKind: 'booking',
          entityId: result.booking_id,
          tenantId,
        });
      } catch (err) {
        // Best-effort, parity with the legacy fan-out: a workflow-start
        // failure does NOT roll back the committed booking. Log + continue
        // (the workflow backstop / ops triage owns recovery).
        this.log.error(
          `workflow start failed for booking=${result.booking_id} def=${approvalCutover.workflowDefinitionId}: ${(err as Error).message}`,
        );
      }
    }

    // Post-RPC best-effort fan-out (notifications + audit). All failures
    // are logged but do NOT roll back the booking — the RPC already
    // committed; rollback is impossible from here.
    //
    // Notification: `onCreated` for the requester-facing "your booking is
    // in" message. The pending-approval APPROVER notification is NOT sent
    // from here — for FLAT rows it comes from the 00402 inbox trigger
    // (chain_id-bearing rows committed in-transaction by the 00431 RPC);
    // for WORKFLOW-DEF rows the engine's approval node owns it. Sending
    // `onApprovalRequested` here too would double-notify the approver.
    if (this.notifications) {
      void this.notifications.onCreated(reservation);
    }

    void this.audit(tenantId, 'booking.created', {
      booking_id: booking.id,
      slot_ids: result.slot_ids,
      order_ids: result.order_ids,
      order_line_item_ids: result.order_line_item_ids,
      asset_reservation_ids: result.asset_reservation_ids,
      approval_ids: result.approval_ids,
      space_id: input.space_id,
      source: booking.source,
      requester_person_id: booking.requester_person_id,
      status: booking.status,
      matched_rule_ids: bookingInput.applied_rule_ids,
      idempotency_key: idempotencyKey,
      via: 'create_booking_with_attach_plan',
    });

    // Recurrence series — same gate as no-services path. The materialiser
    // sees the booking with its services attached because the combined
    // RPC committed them all in one transaction.
    if (
      input.recurrence_rule &&
      !input.recurrence_series_id &&
      this.recurrence &&
      booking.status !== 'pending_approval'
    ) {
      void this.startSeries(reservation, input.recurrence_rule).catch((err) => {
        this.log.warn(`startSeries failed for ${booking.id}: ${(err as Error).message}`);
      });
    }

    return reservation;
  }

  /**
   * Map a PostgREST `create_booking_with_attach_plan` RPC error to the
   * appropriate Nest HTTP exception with a structured `code` so the
   * frontend can present specific messages. Spec §7.6 + §8.
   *
   * The error shape from supabase-js / PostgREST has `code` (the SQLSTATE)
   * and `message` (the `RAISE EXCEPTION` text). We branch first on
   * SQLSTATE, then string-match the message prefix for the structured
   * error variants the RPC raises (`attach_plan.fk_invalid: …`,
   * `attach_plan.internal_refs: …`, `service_rule_deny: …`,
   * `attach_operations.payload_mismatch`).
   *
   * The 23P01 GiST-exclusion path mirrors the no-services path's
   * `create_booking` handler (load conflicts + alternatives) so the UX
   * is consistent.
   */
  private async mapAttachPlanRpcError(
    rpcError: { code?: string; message?: string },
    input: CreateReservationInput,
    bookingInput: BookingInput,
    actor: ActorContext,
    tenantId: string,
  ): Promise<Error> {
    const code = rpcError.code ?? '';
    const message = rpcError.message ?? '';

    // GiST exclusion — booking_slots_no_overlap. Mirrors the
    // no-services path's conflict mapping (load conflicts + ask the
    // picker for 3 alternative rooms at the same time).
    if (this.conflict.isExclusionViolation(rpcError as never)) {
      const conflicts = await this.conflict.preCheck({
        tenant_id: tenantId,
        space_id: input.space_id,
        effective_start_at: this.subtractMinutes(
          input.start_at,
          bookingInput.slots[0].setup_buffer_minutes,
        ),
        effective_end_at: this.addMinutes(
          input.end_at,
          bookingInput.slots[0].teardown_buffer_minutes,
        ),
      });
      let alternatives: Array<{ space_id: string; name: string; capacity: number | null }> = [];
      if (this.picker) {
        try {
          const result = await this.picker.list(
            {
              start_at: input.start_at,
              end_at: input.end_at,
              attendee_count: input.attendee_count ?? 1,
              requester_id: input.requester_person_id,
              limit: 4,
            },
            actor,
          );
          alternatives = result.rooms
            .filter((r) => r.space_id !== input.space_id)
            .slice(0, 3)
            .map((r) => ({ space_id: r.space_id, name: r.name, capacity: r.capacity }));
        } catch (e) {
          this.log.warn(`alternatives lookup failed: ${(e as Error).message}`);
        }
      }
      return AppErrors.conflict('booking.slot_conflict', {
        detail: `Just booked — pick another slot. Conflicts=${conflicts.map((c) => c.id).join(',')}; alternatives=${alternatives.map((a) => a.space_id).join(',') || 'none'}`,
      });
    }

    // Idempotency payload mismatch — same key, different payload (the
    // caller's plan changed between retries; the RPC refuses to silently
    // serve a stale cached_result).
    if (message.includes('attach_operations.payload_mismatch')) {
      return AppErrors.conflict('booking.idempotency_payload_mismatch', {
        detail:
          'A retry of this booking attempt arrived with different content. ' +
          'Re-submit with a fresh request id, or refresh and try again.',
      });
    }

    // Tenant-FK validation — `attach_plan.fk_invalid: <field>` raised by
    // `validate_attach_plan_tenant_fks` (00303). Spec §8.1.
    if (message.includes('attach_plan.fk_invalid')) {
      return AppErrors.validationFailed('booking.fk_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }

    // Snapshot UUID validation — applied_rule_ids[] / setup_emit.rule_ids[] /
    // approvals.reasons[].rule_id all raise with errcode 42501 from
    // `validate_attach_plan_internal_refs` (00304). Spec §8.2.
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

    // Service rule deny — pre-flight any_deny short-circuit inside the
    // RPC. errcode is P0001 ('42P10' was the v5 spec value; the actual
    // 00309 migration uses P0001 which is what plpgsql RAISE defaults
    // to). String-match defensively.
    if (message.includes('service_rule_deny')) {
      return AppErrors.validationFailed('service_rule_deny', {
        detail: this.extractRaiseMessage(message),
      });
    }

    // Catch-all. Surface the raw message so ops can triage.
    this.log.error(
      `create_booking_with_attach_plan unexpected error: code=${code} message=${message}`,
    );
    return AppErrors.server('booking.unexpected_error', {
      detail: message || 'Unexpected error during booking creation.',
    });
  }

  /** Strip the `prefix: ` part of a `RAISE EXCEPTION` message so callers
   *  can present the human-readable tail. */
  private extractRaiseMessage(raw: string): string {
    const idx = raw.indexOf(': ');
    return idx >= 0 ? raw.slice(idx + 2) : raw;
  }

  /**
   * `buildAttachPlan` — pure plan-builder for the combined-RPC path
   * (`create_booking_with_attach_plan`). Returns `{ bookingInput, attachPlan }`
   * — both jsonb-shaped for the RPC arguments. Does NOT call the RPC.
   *
   * Spec: §7.4 + §7.5 + §7.6 of
   * docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
   *
   * Pipeline:
   *   1. Validate input (assertValid mirrors `create`).
   *   2. Load + verify the space (active, reservable).
   *   3. Snapshot buffers (back-to-back collapse).
   *   4. Resolve booking rules.
   *   5. Handle deny / require_approval / override gates (mirrors `create`'s
   *      ForbiddenException + override-reason gates so `create` and
   *      `buildAttachPlan` stay in lockstep).
   *   6. Compute status + policy_snapshot + cost_amount_snapshot.
   *   7. Pre-generate booking_id + slot_ids via `planUuid`.
   *   8. Build BookingInput (mirrors `create_booking` RPC param list at
   *      00277:236-292).
   *   9. Delegate to `BundleService.buildAttachPlan` for service rows
   *      (returns AttachPlan with pre-gen UUIDs, sorted canonically).
   *   10. Compose the result.
   *
   * Dormant in B.0.C — `BookingFlowService.create` keeps using the
   * `create_booking` RPC + `attachServicesToBooking` until B.0.D rewires
   * the call site to `create_booking_with_attach_plan`.
   *
   * **Single-room only** for v1 — multi-room batches multiple slot specs
   * into one call (deferred to MultiRoomBookingService rewrite, separate
   * slice). Mirrors the same constraint as `create`.
   */
  async buildAttachPlan(
    input: CreateReservationInput,
    actor: ActorContext,
    idempotencyKey: string,
  ): Promise<{
    bookingInput: BookingInput;
    attachPlan: AttachPlan;
    /**
     * audit-03 P2-3 STEP D — WORKFLOW-DEF post-RPC cutover info. When the
     * matched room rule carries a `workflow_definition_id`, the plan emits
     * NO approval rows (the workflow engine owns them); `createWithAttachPlan`
     * must start the workflow_instance POST-RPC (parity with the legacy
     * `create` fan-out at the old :367-373). For the FLAT / confirmed cases
     * `workflowDefinitionId` is null and the approvals (if any) are already
     * in the plan + committed in-transaction by the 00431 RPC.
     */
    approvalCutover: {
      status: 'pending_approval' | 'confirmed';
      workflowDefinitionId: string | null;
    };
  }> {
    if (!idempotencyKey || idempotencyKey.length === 0) {
      throw AppErrors.validationFailed('booking.idempotency_key_required', {
        detail: 'buildAttachPlan: idempotencyKey required.',
      });
    }
    this.assertValid(input);
    const tenantId = TenantContext.current().id;

    // audit-03 D-6 (V2 / V1 create-path) — the request-canonical
    // resolution-basis instant. The booking row does NOT exist yet on
    // create, so there is no `bookings.created_at` to anchor on (unlike
    // the attach path). The controller chokepoint (`actorFromRequest`)
    // defaults ONE instant per request onto `actor.resolution_basis_at`;
    // synthetic/system actors + unit tests that build an ActorContext
    // directly leave it unset → fall back to a single read here (still
    // ONE basis for the whole plan-build, just not retry-stable for
    // those non-HTTP callers, which have no retry semantics anyway).
    // This SAME instant threads to (a) the room-rule resolver context
    // (V2), (b) the service-rule producer + predicate engine (V1/V3-time)
    // — so a same-intent create retry straddling a tenant lead-time-rule
    // boundary recomputes a byte-identical p_booking_input + p_attach_plan.
    const resolutionBasisAt = actor.resolution_basis_at ?? new Date().toISOString();
    const resolutionBasisMs = Date.parse(resolutionBasisAt);

    // 1+2. Load space + verify
    const space = await this.loadSpace(input.space_id, tenantId);

    // 3. Buffer collapse for same-requester back-to-back
    const buffers = await this.conflict.snapshotBuffersForBooking({
      tenant_id: tenantId,
      space_id: input.space_id,
      requester_person_id: input.requester_person_id,
      start_at: input.start_at,
      end_at: input.end_at,
      room_setup_buffer_minutes: space.setup_buffer_minutes ?? 0,
      room_teardown_buffer_minutes: space.teardown_buffer_minutes ?? 0,
    });

    // 4. Resolve booking rules — anchored on the request-canonical basis
    //    (audit-03 D-6 V2/V3-time) so the matched room-rule set, and
    //    therefore the hashed policy_snapshot / applied_rule_ids / status,
    //    is wall-clock-independent across a same-intent create retry.
    const ruleOutcome = await this.ruleResolver.resolve(
      {
        requester_person_id: input.requester_person_id,
        space_id: input.space_id,
        start_at: input.start_at,
        end_at: input.end_at,
        attendee_count: input.attendee_count ?? null,
        criteria: {},
        resolution_basis_ms: resolutionBasisMs,
      },
      tenantId,
    );

    // 5. Deny gate — same shape as `create`
    if (ruleOutcome.final === 'deny') {
      const canOverride = actor.has_override_rules && ruleOutcome.overridable;
      if (!canOverride) {
        throw AppErrors.forbidden('rule_deny', ruleOutcome.denialMessages[0] || 'Booking denied by booking rules.');
      }
      if (!actor.override_reason) {
        throw AppErrors.validationFailed('override_reason_required', { detail: 'Service-desk override requires a reason.' });
      }
    }

    // 6. Status + policy + cost (mirrors `create`)
    const status: 'pending_approval' | 'confirmed' =
      ruleOutcome.final === 'require_approval' ? 'pending_approval' : 'confirmed';

    // audit-03 D-6 (V3-order) — canonical-sort the matched rules ONCE by
    // id, then derive EVERY hashed collection (matched_rule_ids,
    // effects_seen, rule_evaluations, applied_rule_ids) from the SAME
    // sorted array. Sorting once and re-deriving keeps `effects_seen` /
    // `rule_evaluations` positionally aligned with `matched_rule_ids`
    // (they would desync if sorted independently) AND makes all four
    // byte-stable in the hashed p_booking_input across a same-intent
    // retry. Belt-and-suspenders over the now-id-ordered rule fetch +
    // stable resolver sort. `ruleOutcome.final` is order-independent
    // (deny>approval>allow precedence), so the deny/status gate above is
    // unaffected by reordering.
    const sortedMatchedRules = [...ruleOutcome.matchedRules].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const policySnapshot: PolicySnapshot = {
      matched_rule_ids: sortedMatchedRules.map((r) => r.id),
      effects_seen: sortedMatchedRules.map((r) => r.effect),
      buffers_collapsed_for_back_to_back:
        buffers.setup_buffer_minutes !== (space.setup_buffer_minutes ?? 0) ||
        buffers.teardown_buffer_minutes !== (space.teardown_buffer_minutes ?? 0),
      source_room_check_in_required: space.check_in_required ?? false,
      source_room_setup_buffer_minutes: space.setup_buffer_minutes ?? 0,
      source_room_teardown_buffer_minutes: space.teardown_buffer_minutes ?? 0,
      rule_evaluations: sortedMatchedRules.map((r) => ({
        rule_id: r.id,
        matched: true,
        effect: r.effect,
        denial_message: r.denial_message ?? undefined,
      })),
    };

    const costAmountSnapshot = this.computeCost(space, input);

    // Source narrowing — mirrors `create`. Booking-audit Slice 8 (audit 03
    // P2-2) removed the `'auto'` coercion: producers now pass a
    // DB-CHECK-valid `bookings.source` directly, so `input.source` can
    // never be `'auto'` here and no actor-prefix re-derivation is needed.
    const bookingSource: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence' =
      input.source ?? 'portal';

    // Map legacy 'other' → 'asset' (00277:122 admits room/desk/asset/parking).
    const inputType = input.reservation_type ?? 'room';
    const slotType: 'room' | 'desk' | 'asset' | 'parking' =
      inputType === 'other' ? 'asset' : inputType;

    // 7. Pre-generate booking_id + slot_ids via planUuid (deterministic)
    const bookingId = planUuid(idempotencyKey, 'booking', '0');
    const slotDisplayOrder = 0;            // single-room: always slot 0
    const slotId = planUuid(idempotencyKey, 'slot', String(slotDisplayOrder));

    // 8. BookingInput — every field the create_booking RPC param list
    //    expects (00277:236-292), shaped as the §7.4 BookingInput jsonb.
    const slot: AttachPlanBookingSlot = {
      id: slotId,
      slot_type: slotType,
      space_id: input.space_id,
      start_at: input.start_at,
      end_at: input.end_at,
      attendee_count: input.attendee_count ?? null,
      attendee_person_ids: input.attendee_person_ids ?? [],
      setup_buffer_minutes: buffers.setup_buffer_minutes,
      teardown_buffer_minutes: buffers.teardown_buffer_minutes,
      check_in_required: space.check_in_required ?? false,
      check_in_grace_minutes: space.check_in_grace_minutes ?? 15,
      display_order: slotDisplayOrder,
    };
    // Canonical sort — single-slot is a no-op, but the discipline matters
    // when multi-room lands.
    const slots = [slot].sort(comparePlanSlots);
    const slotIds = slots.map((s) => s.id);

    const bookingInput: BookingInput = {
      booking_id: bookingId,
      slot_ids: slotIds,
      requester_person_id: input.requester_person_id,
      host_person_id: input.host_person_id ?? null,
      booked_by_user_id: bookedByUserIdForRpc(actor), // D-8 (Slice 7): system:* sentinel → null (uuid bind)
      location_id: input.space_id,
      start_at: input.start_at,
      end_at: input.end_at,
      timezone: input.timezone ?? 'UTC',
      status,
      source: bookingSource,
      title: input.title ?? null,
      description: input.description ?? null,
      cost_center_id: input.bundle?.cost_center_id ?? null,
      cost_amount_snapshot: costAmountSnapshot,
      policy_snapshot: policySnapshot as unknown as Record<string, unknown>,
      // audit-03 D-6 (V3-order) — same canonically-sorted source as
      // policy_snapshot.matched_rule_ids (re-deriving from the same sorted
      // array, not the raw resolver order).
      applied_rule_ids: sortedMatchedRules.map((r) => r.id),
      config_release_id: null,
      recurrence_series_id: input.recurrence_series_id ?? null,
      recurrence_index: input.recurrence_index ?? null,
      template_id: input.bundle?.template_id ?? null,
      slots,
    };

    // 9. AttachPlan — delegate to BundleService.buildAttachPlan when there
    //    are services; produce an empty plan otherwise.
    let attachPlan: AttachPlan;
    if (input.services && input.services.length > 0) {
      if (!this.bundle) {
        throw AppErrors.server('booking.bundle_not_injected', {
          detail: 'BundleService not injected — booking-flow cannot build attach plan.',
        });
      }
      attachPlan = await this.bundle.buildAttachPlan({
        booking_id: bookingId,
        tenant_id: tenantId,
        booking: {
          location_id: input.space_id,
          requester_person_id: input.requester_person_id,
          host_person_id: input.host_person_id ?? null,
          start_at: input.start_at,
          end_at: input.end_at,
          attendee_count: input.attendee_count ?? null,
          source: bookingSource,
          // audit-03 D-6 (create path) — there is no booking row yet, so
          // the lead-time resolution basis is the request-canonical
          // instant, NOT a `bookings.created_at`. `buildAttachPlan` reads
          // this for `hydrateLines` + the service-rule predicate engine,
          // so the hashed p_attach_plan matches the hashed p_booking_input
          // and a same-intent create retry never spuriously 409s.
          created_at: resolutionBasisAt,
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
      });
    } else {
      // audit-03 P2-3 STEP C — the no-services approval builder (the
      // P0-defuser). Pre-P2-3 the no-services single-room path went through
      // the legacy `create_booking` RPC + `createApprovalRows` (which wrote
      // chain-aware approval rows → inbox-notified). The P2-3 consolidation
      // routes it through `create_booking_with_attach_plan` instead — so
      // the approval rows MUST now be expressed in the plan, or a freshly
      // created pending-approval room booking would have ZERO approval
      // rows (a permanently-stuck booking — the exact P0 the legacy
      // multi-room path had before B.0.D).
      //
      // Two sub-cases (mirrors the legacy `create` fan-out at ~:366-377):
      //
      //   FLAT case  (status==='pending_approval' && approvalConfig &&
      //               !approvalWorkflowDefinitionId): build approvals[]
      //               mirroring createApprovalRows OUTCOME, with HARD
      //               determinism (planUuid-derived ids + shared chain id;
      //               NO randomUUID/Date.now in the hashed plan). Handled
      //               atomically by the 00431 RPC in-transaction.
      //
      //   WORKFLOW-DEF case (approvalWorkflowDefinitionId set): approvals
      //               stay []; the workflow engine owns the approval rows.
      //               `createWithAttachPlan` starts the workflow_instance
      //               POST-RPC (STEP D), exactly as the legacy `create`
      //               path did. Deferred-with-owner: engine-owned, not
      //               regressed (parity, not improvement).
      //
      //   else (confirmed / no approval rule): approvals stay [].
      const approvals: AttachPlanApproval[] = [];
      let anyPendingApproval = false;

      if (
        status === 'pending_approval' &&
        ruleOutcome.approvalConfig &&
        !ruleOutcome.approvalWorkflowDefinitionId
      ) {
        const config = ruleOutcome.approvalConfig;
        // Raw rule JSON has NO inherent approver order — canonical-sort
        // BEFORE mapping so a same-intent retry hashes byte-identically
        // (unsorted = D-5/D-6-class spurious attach_operations 409).
        const sortedApprovers = canonicalApproverSort(
          config.required_approvers ?? [],
        );
        if (sortedApprovers.length > 0) {
          const chainThreshold: 'all' | 'any' = config.threshold ?? 'all';
          // parallel_group iff threshold==='all' (EXACTLY createApprovalRows
          // semantics). bookingId is planUuid-derived ⇒ deterministic.
          const parallelGroup =
            chainThreshold === 'all' ? `parallel-${bookingId}` : null;
          // ONE shared, DETERMINISTIC chain id per call (NOT randomUUID —
          // see plan-uuid.ts rationale + the C2 note in
          // approval-routing.service.ts). '__chain__' sentinel cannot
          // collide with a real approver key (person/team ids are UUIDs).
          const approvalChainId = planUuid(
            idempotencyKey,
            'approval',
            '__chain__',
          );
          const emptyScope = {
            reservation_ids: [],
            order_ids: [],
            order_line_item_ids: [],
            ticket_ids: [],
            asset_reservation_ids: [],
            reasons: [],
          };
          // `canonicalApproverSort` already imposes a stable `(type, id)`
          // order, so iterating it directly yields a deterministically
          // ordered `approvals[]` (the same invariant `assemblePlan`'s
          // final sort enforces — but here `comparePlanApprovals`, which
          // keys on `approver_person_id`, is UNUSABLE because team rows
          // have a null `approver_person_id`; the canonical-sort order IS
          // the determinism guarantee).
          for (const a of sortedApprovers) {
            // person/team split EXACTLY like createApprovalRows. The
            // stableIndex IS the approver id (its uniqueness within the
            // canonically-sorted set holds for both person and team).
            approvals.push({
              id: planUuid(idempotencyKey, 'approval', a.id),
              target_entity_type: 'booking',
              target_entity_id: bookingId,
              approver_person_id: a.type === 'person' ? a.id : null,
              approver_team_id: a.type === 'team' ? a.id : null,
              approval_chain_id: approvalChainId,
              parallel_group: parallelGroup,
              chain_threshold: chainThreshold,
              scope_breakdown: emptyScope,
              status: 'pending',
            });
          }
          anyPendingApproval = true;
        }
      }

      attachPlan = {
        version: 1,
        any_pending_approval: anyPendingApproval,
        any_deny: false,
        deny_messages: [],
        orders: [],
        asset_reservations: [],
        order_line_items: [],
        approvals,
        bundle_audit_payload: {
          bundle_id: bookingId,
          booking_id: bookingId,
          order_ids: [],
          order_line_item_ids: [],
          asset_reservation_ids: [],
          approval_ids: approvals.map((ap) => ap.id),
          // Lockstep with the top-level any_pending_approval (P2-3 STEP C).
          any_pending_approval: anyPendingApproval,
        },
      };
    }

    return {
      bookingInput,
      attachPlan,
      // audit-03 P2-3 STEP D — surface the WORKFLOW-DEF cutover decision so
      // `createWithAttachPlan` can start the workflow_instance POST-RPC.
      // `workflowDefinitionId` is non-null ONLY when the matched rule is a
      // workflow-def approval rule (in which case the plan emitted NO
      // approval rows — the engine owns them). FLAT approval rows are
      // already in `attachPlan.approvals` + committed by the 00431 RPC.
      approvalCutover: {
        status,
        workflowDefinitionId:
          status === 'pending_approval' && ruleOutcome.approvalConfig
            ? ruleOutcome.approvalWorkflowDefinitionId
            : null,
      },
    };
  }

  /**
   * Create the recurrence_series row + materialise the next 90 days.
   * Called fire-and-forget after a recurring booking's master row is written.
   * If materialisation fails partially (conflict-guard skips), the series is
   * still alive — the rollover cron will keep extending it nightly.
   *
   * Post-canonicalisation (2026-05-02):
   *   - `recurrence_series.parent_reservation_id` was renamed to
   *     `parent_booking_id` (00278:179-181). FK now targets `bookings.id`.
   *   - `master.id` is now the BOOKING id, so the rename is semantic-correct.
   *   - The follow-up update of the master row used to write to `reservations`;
   *     it now writes to `bookings`. `recurrence_master_id` was dropped from
   *     the schema (the series → bookings link is one-direction).
   *   - `recurrence.materialize` is owned by RecurrenceService which still
   *     reads/writes `reservations` and will fail at runtime until rewritten
   *     in its own slice. We still call it so the integration point is
   *     observable.
   */
  private async startSeries(master: Reservation, rule: NonNullable<CreateReservationInput['recurrence_rule']>): Promise<void> {
    if (!this.recurrence) return;

    // Insert series row anchored at the master booking.
    const horizon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: seriesRow, error: seriesErr } = await this.supabase.admin
      .from('recurrence_series')
      .insert({
        tenant_id: master.tenant_id,
        recurrence_rule: rule,
        series_start_at: master.start_at,
        series_end_at: rule.until ?? null,
        max_occurrences: rule.count ?? 365,
        materialized_through: horizon,
        parent_booking_id: master.id,            // renamed 00278:179-181
      })
      .select('id')
      .single();
    if (seriesErr || !seriesRow) {
      this.log.warn(`series insert failed: ${seriesErr?.message ?? 'unknown'}`);
      return;
    }
    const seriesId = (seriesRow as { id: string }).id;

    // Link the master booking back to the series. recurrence_master_id is
    // dropped — the only canonical link is recurrence_series_id on bookings.
    // Defense-in-depth per the project's #0 invariant: admin-client writes
    // filter by tenant_id explicitly even though uuid id collisions are
    // practically impossible.
    await this.supabase.admin
      .from('bookings')
      .update({
        recurrence_series_id: seriesId,
        recurrence_index: 0,
      })
      .eq('tenant_id', master.tenant_id)
      .eq('id', master.id);

    // Materialise the rolling 90-day window. Owned by another slice — see
    // RecurrenceService rewrite TODO.
    try {
      await this.recurrence.materialize(seriesId, new Date(horizon));
    } catch (err) {
      this.log.warn(`materialize failed for series ${seriesId}: ${(err as Error).message}`);
    }
  }

  // B.4 Step 2F.3 (2026-05-12) — `editScope` deleted. The legacy bare-
  // UPDATE path (no rule eval, no conflict guard, no capacity check, no
  // approval re-eval, no cost recompute — bug 6 in docs/follow-ups
  // /b4-booking-edit-pipeline.md:98) was replaced by
  // `ReservationService.editScope` which assembles N per-occurrence plans
  // through `AssembleEditPlanService.assembleScopeEditPlan` and applies
  // them atomically via the `edit_booking_scope` RPC (00371). The
  // controller cutover lives at reservation.controller.ts:editScope.
  //
  // No caller of `BookingFlowService.editScope` remained outside the
  // controller; the deletion is fully scoped to this method.

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
    const tenantId = TenantContext.current().id;

    const ruleOutcome = await this.ruleResolver.resolve(
      {
        requester_person_id: input.requester_person_id,
        space_id: input.space_id,
        start_at: input.start_at,
        end_at: input.end_at,
        attendee_count: input.attendee_count ?? null,
        criteria: {},
      },
      tenantId,
    );

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
      throw AppErrors.validationFailed('invalid_input', { detail: 'space_id and requester_person_id required' });
    }
    const start = new Date(input.start_at).getTime();
    const end = new Date(input.end_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw AppErrors.validationFailed('invalid_input', { detail: 'invalid dates' });
    }
    if (end <= start) {
      throw AppErrors.validationFailed('invalid_input', { detail: 'end_at must be after start_at' });
    }
  }

  /**
   * Load + tenant-validate a `spaces` row.
   *
   * Visibility (B.4 step 2D-C, 2026-05-12): EXPOSED (was `private`) so the
   * `assembleEditPlan` orchestrator can reuse the same tenant-scoped read +
   * `space_inactive` / `space_not_reservable` validation when building the
   * `EditPlan` for a target room. The shape + invariants are unchanged.
   * Reference: docs/follow-ups/b4-booking-edit-pipeline.md §3.3 step 3
   * (cited at "loadSpace in booking-flow.service.ts:1264-1282" — re-anchored
   * after this exposure).
   *
   * Phase 8 (Tier B follow-up #2): `tenantId` is threaded explicitly so
   * a missing/wrong tenant is a compile error, not a runtime cross-tenant
   * leak through the admin client.
   */
  async loadSpace(spaceId: string, tenantId: string): Promise<{
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
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('id, type, reservable, capacity, setup_buffer_minutes, teardown_buffer_minutes, check_in_required, check_in_grace_minutes, cost_per_hour, active')
      .eq('tenant_id', tenantId)
      .eq('id', spaceId)
      .maybeSingle();
    if (error || !data) throw AppErrors.notFoundWithCode('space_not_found', 'Space not found.');
    if (!(data as { active: boolean }).active) throw AppErrors.validationFailed('space_inactive');
    if (!(data as { reservable: boolean }).reservable) {
      throw AppErrors.validationFailed('space_not_reservable');
    }
    return data as never;
  }

  private computeCost(space: { cost_per_hour: string | null }, input: CreateReservationInput): string | null {
    if (!space.cost_per_hour) return null;
    const minutes = (new Date(input.end_at).getTime() - new Date(input.start_at).getTime()) / 60000;
    const cost = (Number(space.cost_per_hour) * minutes) / 60;
    return cost.toFixed(2);
  }

  private addMinutes(iso: string, minutes: number): string {
    return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
  }
  private subtractMinutes(iso: string, minutes: number): string {
    return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
  }

  private async audit(tenantId: string, eventType: string, details: Record<string, unknown>) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        // Canonical entity_type — booking events use 'booking' post-rewrite.
        // Per-slot events (check-in, auto-release) live elsewhere with
        // entity_type='booking_slot' (deferred to those slices).
        entity_type: 'booking',
        entity_id: (details.booking_id as string) ?? null,
        details,
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Transitional projection: Booking + slotSpec → Reservation (legacy shape)
// ─────────────────────────────────────────────────────────────────────────
//
// The canonical entity is now `Booking` (one row in `bookings`) plus N
// `BookingSlot` rows. Several callers (notifications, audit, bundle attach,
// multi-room rollback) still consume the flat `Reservation` shape that
// merged booking + reservation fields. This helper synthesises that
// shape from a freshly-created Booking + the slot spec we just sent to
// the RPC.
//
// `id` is the BOOKING id (breaking change — historically the reservation
// id). `effective_*_at` is computed locally to mirror the trigger
// `booking_slots_compute_effective_window` (00277:194-201).
//
// Returns a transitional shim — DO NOT extend; new code should consume
// `Booking` + `BookingSlot` directly. Removed once consumers migrate.
function bookingToLegacyReservation(
  booking: Booking,
  slotSpec: {
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
  },
  slotId: string | null,
  appliedRuleIds: string[],
  source: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence',
  slotType: 'room' | 'desk' | 'asset' | 'parking',
): Reservation {
  // Compute effective window the same way the slot trigger does so
  // consumers comparing against the slot row see consistent values.
  const effectiveStart = new Date(
    new Date(slotSpec.start_at).getTime() - slotSpec.setup_buffer_minutes * 60_000,
  ).toISOString();
  const effectiveEnd = new Date(
    new Date(slotSpec.end_at).getTime() + slotSpec.teardown_buffer_minutes * 60_000,
  ).toISOString();

  return {
    id: booking.id,
    // /full-review I2 fix — surface the per-slot id so multi-room
    // consumers can address a specific room. `''` only when the caller
    // has no slot id yet (rare; create_booking always returns one).
    slot_id: slotId ?? '',
    // Phase 1.4: explicit booking-grouping field (= booking.id today,
    // emitted separately so list dedup/grouping consumers don't conflate
    // it with the per-slot key). Mirrors reservation-projection.ts.
    booking_id: booking.id,
    tenant_id: booking.tenant_id,
    // The legacy `reservation_type` is `'room' | 'desk' | 'parking' | 'other'`;
    // the new slot_type is `'room' | 'desk' | 'asset' | 'parking'`. Map
    // 'asset' → 'other' for the shim (the inverse of the create-time map).
    reservation_type: (slotType === 'asset' ? 'other' : slotType),
    space_id: slotSpec.space_id,
    requester_person_id: booking.requester_person_id,
    host_person_id: booking.host_person_id,
    start_at: slotSpec.start_at,
    end_at: slotSpec.end_at,
    attendee_count: slotSpec.attendee_count,
    attendee_person_ids: slotSpec.attendee_person_ids,
    status: booking.status,
    // Recurrence rule / master fields — null in the shim. The recurrence
    // service is a separate slice and will read these directly off the
    // Booking row when rewritten.
    recurrence_rule: null,
    recurrence_series_id: booking.recurrence_series_id,
    // recurrence_master_id field dropped from the projection — the
    // canonical series link is recurrence_series_id (one direction).
    recurrence_index: booking.recurrence_index,
    recurrence_overridden: booking.recurrence_overridden,
    recurrence_skipped: booking.recurrence_skipped,
    linked_order_id: null,                      // never used by callers in practice; kept for shape completeness
    approval_id: null,                          // approvals back-link via target_entity_id, no inverse cache
    setup_buffer_minutes: slotSpec.setup_buffer_minutes,
    teardown_buffer_minutes: slotSpec.teardown_buffer_minutes,
    effective_start_at: effectiveStart,
    effective_end_at: effectiveEnd,
    check_in_required: slotSpec.check_in_required,
    check_in_grace_minutes: slotSpec.check_in_grace_minutes,
    checked_in_at: null,
    released_at: null,
    cancellation_grace_until: null,
    policy_snapshot: booking.policy_snapshot,
    applied_rule_ids: appliedRuleIds,
    source,
    booked_by_user_id: booking.booked_by_user_id,
    cost_amount_snapshot: booking.cost_amount_snapshot,
    // multi_room_group_id field dropped from the projection — multi-room
    // atomicity is expressed via shared booking_id on slots.
    calendar_event_id: booking.calendar_event_id,
    calendar_provider: booking.calendar_provider,
    calendar_etag: booking.calendar_etag,
    calendar_last_synced_at: booking.calendar_last_synced_at,
    // booking_bundle_id was dropped from the Reservation projection by
    // slice H6 (00288). The booking IS the bundle (00277:27); readers
    // that need the bundle id should use Reservation.id directly.
    created_at: booking.created_at,
    updated_at: booking.updated_at,
  };
}
