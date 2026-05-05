import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable,
  InternalServerErrorException, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import { ConflictGuardService } from './conflict-guard.service';
import { RecurrenceService } from './recurrence.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { BundleService } from '../booking-bundles/bundle.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import {
  BOOKING_TX_BOUNDARY,
  type BookingTransactionBoundary,
} from './booking-transaction-boundary';
import { BookingCompensationService } from './booking-compensation.service';
import type {
  ActorContext, Booking, CreateReservationInput, PolicySnapshot,
  RecurrenceScope, Reservation,
} from './dto/types';
import type {
  AttachPlan,
  AttachPlanBookingSlot,
  BookingInput,
} from '../booking-bundles/attach-plan.types';
import { planUuid } from '../booking-bundles/plan-uuid';
import { comparePlanSlots } from '../booking-bundles/plan-sort';

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
    /** Phase 1.3 — wraps `attachServicesToBooking` so a failure rolls back
     *  the booking via `delete_booking_with_guard` (00292). Optional only
     *  to keep older booking-flow specs (no service attach) constructible
     *  without the new collaborators; the create path enforces presence
     *  when services are non-empty. */
    /**
     * B.0.D.2 cutover: the combined RPC `create_booking_with_attach_plan`
     * is atomic, so the post-create attach + compensation pattern is no
     * longer used by `create()`. These properties remain in the
     * constructor signature so existing tests + DI wiring keep working
     * unchanged, and so the legacy compensation primitive stays
     * available if any future caller (e.g. a recovery script, the
     * standalone-order flow) needs it. Marked `Optional` for the same
     * reason.
     */
    @Optional() @Inject(BOOKING_TX_BOUNDARY) private readonly txBoundary?: BookingTransactionBoundary,
    @Optional() private readonly compensation?: BookingCompensationService,
  ) {
    // Reference unused fields so the strict `noUnusedLocals` check passes.
    // These are kept on the class for the reasons documented above.
    void this.txBoundary;
    void this.compensation;
  }

  /**
   * Run the full pipeline and atomically create one Booking + one BookingSlot
   * via the `create_booking` RPC (00277:236-334), or throw a structured error.
   *
   * Single-room only — multi-room batches multiple slot specs into one RPC
   * call (deferred to MultiRoomBookingService rewrite, separate slice).
   *
   * Returns the inserted Booking. The slot id is also returned by the RPC and
   * accessible via the wrapping `Reservation` shim's `id` field (which now
   * holds the BOOKING id, not the slot id — see breaking-change comment below).
   *
   * BREAKING CHANGE for downstream callers (each fixed in its own slice):
   *   - The returned object's `id` is now the BOOKING id (`bookings.id`),
   *     not a `reservations.id`. Multi-room/recurrence/check-in services
   *     that use the returned id to look up the row in `reservations` will
   *     hit empty results until they're rewritten to read `bookings`.
   *   - `recurrence_master_id` / `multi_room_group_id` are always null
   *     (those columns no longer exist).
   *   - Approval rows now use `target_entity_type='booking'` instead of
   *     `'reservation'` (00278:172).
   *
   * Errors:
   *   - 403 'rule_deny' — a deny rule fired and the actor cannot override
   *   - 409 'reservation_slot_conflict' — `booking_slots_no_overlap` GiST
   *     exclusion (00277:211-217) rejected; alternatives populated via picker
   *   - 400 'invalid_input' — basic validation failures
   */
  async create(input: CreateReservationInput, actor: ActorContext): Promise<Reservation> {
    this.assertValid(input);
    const tenantId = TenantContext.current().id;
    // Trace incoming payload so we can diagnose the disappearing-services
    // bug when it shows up. Logs at LOG (not DEBUG) so it lands in the
    // default Nest output without needing log-level changes.
    this.log.log(
      `[create] space=${input.space_id} services_len=${input.services?.length ?? 0} bundle_present=${!!input.bundle} source=${input.source ?? 'portal'}`,
    );

    // B.0.D.2 cutover: WITH-services path goes through the combined RPC
    // `create_booking_with_attach_plan` (one transaction commits booking +
    // slots + orders + asset_reservations + OLIs + approvals + outbox
    // emissions). NO-services path stays on the existing `create_booking`
    // RPC unchanged — there's nothing to attach, the combined RPC's
    // attach_operations idempotency table would just be cluttered with
    // no-op rows, and the existing path is well-tested.
    //
    // Spec §3.1 + §7.6 of
    // docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
    if (input.services && input.services.length > 0) {
      return this.createWithAttachPlan(input, actor, tenantId);
    }

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

    // 6. Status + policy_snapshot — applied to BOTH booking + slot (the RPC
    //    mirrors the booking-level status onto each created slot, 00277:323).
    const status: 'pending_approval' | 'confirmed' =
      ruleOutcome.final === 'require_approval' ? 'pending_approval' : 'confirmed';

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

    // 7. Atomic create via RPC. The RPC inserts one bookings row + N
    //    booking_slots rows in a single transaction; the GiST exclusion on
    //    booking_slots fires inside that transaction so concurrent races
    //    surface as 23P01 here.
    //
    //    Source-narrowing: the legacy `ReservationSource` admits 'auto' for
    //    calendar-sync polling, but the new `bookings.source` CHECK constraint
    //    does not (00277:56-58, FIX#2).
    //
    //    /full-review v3 closure Nit (2026-05-04) — split the 'auto'
    //    coercion target by caller. Pre-fix every 'auto' became
    //    'calendar_sync', mislabelling system-recurrence occurrences as
    //    Outlook/Google sync events. Now: system-recurrence actors
    //    (user_id starting with 'system:recurrence') get 'recurrence';
    //    everything else still falls back to 'calendar_sync'. The
    //    'recurrence' value lives on bookings.source per migration 00295.
    const rawSource = input.source ?? 'portal';
    const bookingSource: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence' =
      rawSource === 'auto'
        ? actor.user_id.startsWith('system:recurrence') ? 'recurrence' : 'calendar_sync'
        : rawSource;

    // Map legacy reservation_type 'other' → 'asset' (the new schema's
    // closest analogue; 00277:122 lists room/desk/asset/parking only).
    // Default 'room' as before.
    const inputType = input.reservation_type ?? 'room';
    const slotType: 'room' | 'desk' | 'asset' | 'parking' =
      inputType === 'other' ? 'asset' : inputType;

    const slotSpec = {
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
      display_order: 0,
    };

    const { data: rpcData, error: rpcError } = await this.supabase.admin.rpc('create_booking', {
      // Ordering matches the RPC parameter list (00277:236-292).
      p_requester_person_id: input.requester_person_id,
      p_location_id: input.space_id,            // single-room: booking anchors at the slot's space
      p_start_at: input.start_at,
      p_end_at: input.end_at,
      p_source: bookingSource,
      p_status: status,
      p_slots: [slotSpec],
      // Optional booking attributes
      p_tenant_id: tenantId,                    // explicit (admin client bypasses RLS, no JWT to derive from)
      p_host_person_id: input.host_person_id ?? null,
      p_title: input.title ?? null,
      p_description: input.description ?? null,
      p_timezone: input.timezone ?? 'UTC',
      p_booked_by_user_id: actor.user_id,
      p_cost_center_id: input.bundle?.cost_center_id ?? null,
      p_cost_amount_snapshot: costAmount,
      p_policy_snapshot: policySnapshot,
      p_applied_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
      p_config_release_id: null,                // not surfaced through the booking-flow input today
      p_recurrence_series_id: input.recurrence_series_id ?? null,
      p_recurrence_index: input.recurrence_index ?? null,
      p_template_id: input.bundle?.template_id ?? null,
    });

    if (rpcError) {
      if (this.conflict.isExclusionViolation(rpcError)) {
        // Look up the conflicting rows + ask the picker for alternative
        // rooms at the same time so the frontend can render a one-click
        // rebook list.
        const conflicts = await this.conflict.preCheck({
          space_id: input.space_id,
          effective_start_at: this.subtractMinutes(input.start_at, buffers.setup_buffer_minutes),
          effective_end_at: this.addMinutes(input.end_at, buffers.teardown_buffer_minutes),
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
        throw new ConflictException({
          code: 'reservation_slot_conflict',
          message: 'Just booked — pick another slot.',
          conflicts: conflicts.map((c) => ({ id: c.id, start_at: c.start_at, end_at: c.end_at })),
          alternatives,
        });
      }
      this.log.error(`create_booking RPC failed: ${rpcError.message}`);
      throw new BadRequestException({ code: 'insert_failed', message: rpcError.message });
    }

    // RPC returns `setof (booking_id uuid, slot_ids uuid[])` — supabase-js
    // surfaces the row(s) as an array. Take the first row.
    const rpcRow = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { booking_id: string; slot_ids: string[] }
      | undefined;
    if (!rpcRow?.booking_id) {
      throw new BadRequestException({
        code: 'insert_failed',
        message: 'create_booking RPC returned no booking_id',
      });
    }
    const bookingId = rpcRow.booking_id;
    const slotIds = rpcRow.slot_ids ?? [];

    // Re-read the booking row so downstream callers (notifications, audit,
    // bundle service) have the full server-canonical state (defaults filled
    // in, updated_at, etc.). Tenant-filter is RLS-bypassed but explicit for
    // belt-and-braces.
    const { data: bookingRow, error: readErr } = await this.supabase.admin
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (readErr || !bookingRow) {
      this.log.error(`booking re-read failed: ${readErr?.message ?? 'no row'}`);
      throw new BadRequestException({
        code: 'insert_failed',
        message: readErr?.message ?? 'Booking re-read returned no row',
      });
    }
    const booking = bookingRow as unknown as Booking;

    // 8. Fan out side effects (best-effort)
    // - Approval row creation (when require_approval).
    //   target_entity_type changed from 'reservation' → 'booking' (00278:172).
    if (status === 'pending_approval' && ruleOutcome.approvalConfig) {
      await this.createApprovalRows(bookingId, ruleOutcome.approvalConfig, tenantId);
    }

    // Build a transitional `Reservation`-shaped envelope for downstream
    // consumers (notifications, audit, bundle attach) that haven't migrated
    // to the `Booking` shape yet. The slot-level fields are populated from
    // our slotSpec since we just created exactly one slot.
    //
    // BREAKING CHANGE: `id` is now the BOOKING id, not the (deleted)
    // reservations.id. Other slices (multi-room, recurrence, check-in,
    // reservation.service) that assumed `id` = `reservations.id` will
    // need to read `bookings` instead.
    const reservation: Reservation = bookingToLegacyReservation(
      booking,
      slotSpec,
      slotIds[0] ?? null,
      ruleOutcome.matchedRules.map((r) => r.id),
      bookingSource,
      slotType,
    );

    // - Notifications (Phase J)
    if (this.notifications) {
      if (status === 'pending_approval' && ruleOutcome.approvalConfig) {
        // Fire-and-forget: don't block the response on the notification round-trip.
        void this.notifications.onApprovalRequested(reservation, ruleOutcome.approvalConfig);
      } else {
        void this.notifications.onCreated(reservation);
      }
    }

    // - Audit. entity_type was 'reservation'; now 'booking' to match the
    //   new canonical entity. Historical 'reservation' events stay
    //   immutable per 00278:18.
    void this.audit(tenantId, 'booking.created', {
      booking_id: booking.id,
      slot_ids: slotIds,
      space_id: input.space_id,
      source: booking.source,
      requester_person_id: booking.requester_person_id,
      status: booking.status,
      matched_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
    });

    // B.0.D.2: services attach is now handled by `createWithAttachPlan`
    // (the with-services path returns early at the top of `create`).
    // The post-create attach + txBoundary compensation has been retired
    // for the canonical create path; the legacy `attachServicesToBooking`
    // method stays callable for `addLinesToBundle` (post-create line
    // additions on an existing booking) and the deprecated
    // `attachServicesToReservation` shim.

    // - Recurrence series materialisation (master row + first 90d of rows).
    //   Fire-and-forget so the user gets their first booking back immediately.
    //   Runs AFTER bundle attach so the materialiser sees the booking with
    //   any attached services and can clone them per occurrence.
    //
    //   NOTE: RecurrenceService is a separate slice — it still references
    //   `reservations` / `parent_reservation_id` and will fail at runtime
    //   until rewritten. We still call it here so the integration point
    //   stays observable.
    if (
      input.recurrence_rule &&
      !input.recurrence_series_id &&  // not itself an occurrence being materialised
      this.recurrence &&
      booking.status !== 'pending_approval'
    ) {
      void this.startSeries(reservation, input.recurrence_rule).catch((err) => {
        this.log.warn(`startSeries failed for ${booking.id}: ${(err as Error).message}`);
      });
    }

    // TODO(phase-H): enqueue outlook calendar push (uses calendar-sync adapter)

    return reservation;
  }

  /**
   * B.0.D.2 — combined-RPC path: booking WITH services. Calls
   * `buildAttachPlan` to produce `{ bookingInput, attachPlan }`, then
   * invokes `create_booking_with_attach_plan` (00309 / spec §7.6) which
   * commits booking + slots + orders + asset_reservations + OLIs +
   * approvals + outbox emissions in one transaction. No `txBoundary`
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
      throw new Error(
        'BundleService not injected — booking-flow cannot build attach plan. ' +
          'Wire BookingBundlesModule into ReservationsModule.imports.',
      );
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
    const { bookingInput, attachPlan } = await this.buildAttachPlan(
      input,
      actor,
      idempotencyKey,
    );

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
      throw await this.mapAttachPlanRpcError(rpcError, input, bookingInput, actor);
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
      throw new InternalServerErrorException({
        code: 'booking.unexpected_error',
        message: 'create_booking_with_attach_plan returned no booking_id',
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
      throw new InternalServerErrorException({
        code: 'booking.unexpected_error',
        message: readErr?.message ?? 'Booking re-read returned no row',
      });
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

    // Post-RPC best-effort fan-out (notifications + audit). All failures
    // are logged but do NOT roll back the booking — the RPC already
    // committed; rollback is impossible from here.
    //
    // Notification: combined-RPC pending_approval path uses `onCreated`
    // for v1 because the plan-builder already discarded `approvalConfig`
    // by the time we reach here, and the persisted `approvals` rows
    // carry only `approver_person_id` (no team variant on the plan).
    // A follow-up can split this into a dedicated
    // `onApprovalRequestedFromPlan(reservation, approvalIds)` that
    // re-loads the approval rows; out of B.0.D.2 scope.
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
  ): Promise<Error> {
    const code = rpcError.code ?? '';
    const message = rpcError.message ?? '';

    // GiST exclusion — booking_slots_no_overlap. Mirrors the
    // no-services path's conflict mapping (load conflicts + ask the
    // picker for 3 alternative rooms at the same time).
    if (this.conflict.isExclusionViolation(rpcError as never)) {
      const conflicts = await this.conflict.preCheck({
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
      return new ConflictException({
        code: 'booking.slot_conflict',
        message: 'Just booked — pick another slot.',
        conflicts: conflicts.map((c) => ({ id: c.id, start_at: c.start_at, end_at: c.end_at })),
        alternatives,
      });
    }

    // Idempotency payload mismatch — same key, different payload (the
    // caller's plan changed between retries; the RPC refuses to silently
    // serve a stale cached_result).
    if (message.includes('attach_operations.payload_mismatch')) {
      return new ConflictException({
        code: 'booking.idempotency_payload_mismatch',
        message:
          'A retry of this booking attempt arrived with different content. ' +
          'Re-submit with a fresh request id, or refresh and try again.',
      });
    }

    // Tenant-FK validation — `attach_plan.fk_invalid: <field>` raised by
    // `validate_attach_plan_tenant_fks` (00303). Spec §8.1.
    if (message.includes('attach_plan.fk_invalid')) {
      return new BadRequestException({
        code: 'booking.fk_invalid',
        message: this.extractRaiseMessage(message),
      });
    }

    // Snapshot UUID validation — applied_rule_ids[] / setup_emit.rule_ids[] /
    // approvals.reasons[].rule_id all raise with errcode 42501 from
    // `validate_attach_plan_internal_refs` (00304). Spec §8.2.
    if (message.includes('attach_plan.internal_refs') && code === '42501') {
      return new BadRequestException({
        code: 'booking.snapshot_uuid_invalid',
        message: this.extractRaiseMessage(message),
      });
    }

    // Internal cross-reference validation — order_line_items[].order_id
    // not in plan.orders[], etc. Spec §8.2.
    if (message.includes('attach_plan.internal_refs')) {
      return new BadRequestException({
        code: 'booking.internal_ref_invalid',
        message: this.extractRaiseMessage(message),
      });
    }

    // Service rule deny — pre-flight any_deny short-circuit inside the
    // RPC. errcode is P0001 ('42P10' was the v5 spec value; the actual
    // 00309 migration uses P0001 which is what plpgsql RAISE defaults
    // to). String-match defensively.
    if (message.includes('service_rule_deny')) {
      return new BadRequestException({
        code: 'service_rule_deny',
        message: this.extractRaiseMessage(message),
      });
    }

    // Catch-all. Surface the raw message so ops can triage.
    this.log.error(
      `create_booking_with_attach_plan unexpected error: code=${code} message=${message}`,
    );
    return new InternalServerErrorException({
      code: 'booking.unexpected_error',
      message: message || 'Unexpected error during booking creation.',
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
  ): Promise<{ bookingInput: BookingInput; attachPlan: AttachPlan }> {
    if (!idempotencyKey || idempotencyKey.length === 0) {
      throw new BadRequestException({
        code: 'idempotency_key_required',
        message: 'buildAttachPlan: idempotencyKey required.',
      });
    }
    this.assertValid(input);
    const tenantId = TenantContext.current().id;

    // 1+2. Load space + verify
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

    // 4. Resolve booking rules
    const ruleOutcome = await this.ruleResolver.resolve({
      requester_person_id: input.requester_person_id,
      space_id: input.space_id,
      start_at: input.start_at,
      end_at: input.end_at,
      attendee_count: input.attendee_count ?? null,
      criteria: {},
    });

    // 5. Deny gate — same shape as `create`
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
    }

    // 6. Status + policy + cost (mirrors `create`)
    const status: 'pending_approval' | 'confirmed' =
      ruleOutcome.final === 'require_approval' ? 'pending_approval' : 'confirmed';

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

    const costAmountSnapshot = this.computeCost(space, input);

    // Source narrowing — mirrors `create` (the new bookings.source CHECK
    // constraint at 00277:56-58 doesn't admit 'auto'; coerce based on
    // actor identity).
    const rawSource = input.source ?? 'portal';
    const bookingSource: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence' =
      rawSource === 'auto'
        ? actor.user_id.startsWith('system:recurrence') ? 'recurrence' : 'calendar_sync'
        : rawSource;

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
      booked_by_user_id: actor.user_id,
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
      applied_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
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
        throw new Error(
          'BundleService not injected — booking-flow cannot build attach plan. ' +
            'Wire BookingBundlesModule into ReservationsModule.imports.',
        );
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

    return { bookingInput, attachPlan };
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

  /**
   * Edit at series scope. The 'this' scope is handled by ReservationService.editOne
   * directly. 'this_and_following' splits the series at this occurrence and
   * applies the patch to the new series. 'series' re-materialises the entire
   * series with the patch (cancels future occurrences and creates new ones).
   *
   * For v1 we implement the structural change (split) and leave the patch
   * application as field-by-field updates. Time-shape changes (recurrence_rule
   * itself) are out of scope for this seam — emit a warning and degrade.
   */
  async editScope(
    reservationId: string,
    scope: RecurrenceScope,
    patch: {
      space_id?: string;
      start_at?: string;
      end_at?: string;
      attendee_count?: number;
      attendee_person_ids?: string[];
      host_person_id?: string;
    },
  ): Promise<{ scope: RecurrenceScope; new_series_id?: string; updated: number }> {
    if (scope === 'this') {
      // Caller should use ReservationService.editOne; we don't duplicate it here.
      throw new BadRequestException({
        code: 'wrong_endpoint',
        message: "Use the regular edit endpoint for scope='this'.",
      });
    }
    if (!this.recurrence) {
      throw new BadRequestException({
        code: 'recurrence_unavailable',
        message: 'Recurrence service not configured.',
      });
    }

    const tenantId = TenantContext.current().id;

    // Post-canonicalisation (2026-05-02):
    //   - `recurrence_series_id` lives on `bookings` (00277:74), not slots
    //   - `host_person_id` lives on `bookings` (00277:37)
    //   - `space_id` / `attendee_count` / `attendee_person_ids` live on
    //     `booking_slots` (00277:124, 138-139)
    // The patch is split per-table accordingly. Multi-slot bookings get
    // the slot-level update applied to ALL slots in the series — v1
    // expects multi-room editScope to be rare; if a caller needs per-slot
    // targeting they should use ReservationService.editOne with scope='this'.
    const bookingPatch: Record<string, unknown> = {};
    if (patch.host_person_id !== undefined) bookingPatch.host_person_id = patch.host_person_id;
    const slotPatch: Record<string, unknown> = {};
    if (patch.space_id) slotPatch.space_id = patch.space_id;
    if (patch.attendee_count !== undefined) slotPatch.attendee_count = patch.attendee_count;
    if (patch.attendee_person_ids !== undefined) slotPatch.attendee_person_ids = patch.attendee_person_ids;

    if (scope === 'this_and_following') {
      const newSeriesId = await this.recurrence.splitSeries(reservationId);

      let updated = 0;
      if (Object.keys(bookingPatch).length > 0) {
        const { data, error } = await this.supabase.admin
          .from('bookings')
          .update(bookingPatch)
          .eq('tenant_id', tenantId)
          .eq('recurrence_series_id', newSeriesId)
          .select('id');
        if (error) throw new BadRequestException({ code: 'edit_scope_failed', message: error.message });
        updated = (data ?? []).length;
      }
      if (Object.keys(slotPatch).length > 0) {
        // Resolve booking ids for the series, then update their slots.
        const { data: bookingsRows, error: bErr } = await this.supabase.admin
          .from('bookings')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('recurrence_series_id', newSeriesId);
        if (bErr) throw new BadRequestException({ code: 'edit_scope_failed', message: bErr.message });
        const bookingIds = ((bookingsRows ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (bookingIds.length > 0) {
          const { data: slotsRows, error: sErr } = await this.supabase.admin
            .from('booking_slots')
            .update(slotPatch)
            .eq('tenant_id', tenantId)
            .in('booking_id', bookingIds)
            .select('id');
          if (sErr) throw new BadRequestException({ code: 'edit_scope_failed', message: sErr.message });
          updated = Math.max(updated, (slotsRows ?? []).length);
        }
      }
      return { scope, new_series_id: newSeriesId, updated };
    }

    // 'series' — apply patch to all rows in the series, forward & past.
    // Pull the source series id from the pivot booking.
    const { data: pivot } = await this.supabase.admin
      .from('bookings')
      .select('recurrence_series_id')
      .eq('id', reservationId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const seriesId = (pivot as { recurrence_series_id?: string } | null)?.recurrence_series_id;
    if (!seriesId) {
      throw new BadRequestException({ code: 'not_recurring', message: 'Not part of a series.' });
    }
    if (Object.keys(bookingPatch).length === 0 && Object.keys(slotPatch).length === 0) {
      return { scope, updated: 0 };
    }

    let updated = 0;
    if (Object.keys(bookingPatch).length > 0) {
      const { data, error } = await this.supabase.admin
        .from('bookings')
        .update(bookingPatch)
        .eq('tenant_id', tenantId)
        .eq('recurrence_series_id', seriesId)
        .select('id');
      if (error) throw new BadRequestException({ code: 'edit_scope_failed', message: error.message });
      updated = (data ?? []).length;
    }
    if (Object.keys(slotPatch).length > 0) {
      const { data: bookingsRows, error: bErr } = await this.supabase.admin
        .from('bookings')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('recurrence_series_id', seriesId);
      if (bErr) throw new BadRequestException({ code: 'edit_scope_failed', message: bErr.message });
      const bookingIds = ((bookingsRows ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (bookingIds.length > 0) {
        const { data: slotsRows, error: sErr } = await this.supabase.admin
          .from('booking_slots')
          .update(slotPatch)
          .eq('tenant_id', tenantId)
          .in('booking_id', bookingIds)
          .select('id');
        if (sErr) throw new BadRequestException({ code: 'edit_scope_failed', message: sErr.message });
        updated = Math.max(updated, (slotsRows ?? []).length);
      }
    }
    return { scope, updated };
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
   *
   * target_entity_type is now 'booking' (was 'reservation'). The CHECK
   * constraint added in 00278:170-172 enforces this at the DB layer; the
   * older approval-routing module still types the union as
   * 'booking_bundle' | 'order' (see approval-routing.service.ts:37) and
   * needs widening in its own slice. The dispatcher map in
   * approval.service.ts:329-347 must learn the new 'booking' value.
   */
  private async createApprovalRows(
    bookingId: string,
    config: { required_approvers?: Array<{ type: 'team' | 'person'; id: string }>; threshold?: 'all' | 'any' },
    tenantId: string,
  ): Promise<void> {
    const approvers = config.required_approvers ?? [];
    if (approvers.length === 0) return;
    const parallelGroup = config.threshold === 'all' ? `parallel-${bookingId}` : null;

    const rows = approvers.map((a) => ({
      tenant_id: tenantId,
      target_entity_type: 'booking',
      target_entity_id: bookingId,
      parallel_group: parallelGroup,
      approver_person_id: a.type === 'person' ? a.id : null,
      approver_team_id: a.type === 'team' ? a.id : null,
      status: 'pending',
    }));

    const { error } = await this.supabase.admin.from('approvals').insert(rows);
    if (error) this.log.warn(`approval rows insert failed for booking=${bookingId}: ${error.message}`);
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
