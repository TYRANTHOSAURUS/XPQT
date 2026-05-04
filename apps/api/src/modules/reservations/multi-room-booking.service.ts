import {
  ConflictException, Inject, Injectable, Logger, BadRequestException, ForbiddenException, NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { BundleService } from '../booking-bundles/bundle.service';
import { ConflictGuardService } from './conflict-guard.service';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import {
  SLOT_WITH_BOOKING_SELECT,
  slotWithBookingToReservation,
  type SlotWithBookingEmbed,
} from './reservation-projection';
import {
  BOOKING_TX_BOUNDARY,
  type BookingTransactionBoundary,
} from './booking-transaction-boundary';
import { BookingCompensationService } from './booking-compensation.service';
import type { ActorContext, Reservation, PolicySnapshot } from './dto/types';

/**
 * Multi-room atomic create — post-canonicalisation (2026-05-02).
 *
 * Pre-rewrite: this service did N sequential `bookingFlow.create` calls, one
 * per room, with a `multi_room_groups` row tying them together. The rewrite
 * collapses that into ONE atomic `create_booking` RPC call (00277:236-334)
 * with N slot specs in `p_slots`. The single booking row IS the multi-room
 * group; the N slots are the rooms. The dropped `multi_room_groups` /
 * `primary_reservation_id` machinery is replaced by the booking_id grouping.
 *
 * Spec §G3 still applies: if any room would conflict (rule deny, GiST race),
 * the whole atomic group fails — no partial bookings. The RPC enforces this
 * inside one transaction so atomicity is now a DB property, not a
 * sequential-best-effort choreography.
 *
 * Service attach (catering / AV) lives on the PRIMARY room only — multi-room
 * events have one bundle per booking, regardless of N rooms. Post-RPC we
 * delegate to BundleService.attachServicesToBooking with the new booking id.
 *
 * Returns shape: `{ group_id, reservations[] }`. Under canonicalisation
 * `group_id` is the booking id (the atomic grouping), and each
 * `Reservation` is one slot's projection. Controller doesn't change.
 */
@Injectable()
export class MultiRoomBookingService {
  private readonly log = new Logger(MultiRoomBookingService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly conflict: ConflictGuardService,
    private readonly ruleResolver: RuleResolverService,
    private readonly bundle: BundleService,
    // /full-review v3 — `bundleCascade` parameter REMOVED. ec6daf7
    // ("atomic service attachment via compensation boundary") moved the
    // legacy `bundleCascade.cancelOrdersForReservation` cleanup onto the
    // txBoundary path; the field was held for DI signature compatibility
    // but never read post-refactor. Removed to clear `TS6138` and avoid
    // a phantom dependency. The 7 existing spec call sites are updated
    // to drop the corresponding constructor argument in the same commit.
    /** Phase 1.3 — wraps `attachServicesToBooking` so a failure rolls back
     *  the booking via `delete_booking_with_guard` (00292). Optional only
     *  to keep older multi-room specs constructible without the new
     *  collaborators; the create path enforces presence when services
     *  are non-empty. */
    @Optional() @Inject(BOOKING_TX_BOUNDARY) private readonly txBoundary?: BookingTransactionBoundary,
    @Optional() private readonly compensation?: BookingCompensationService,
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
      source?: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'auto';
      services?: Array<{
        catalog_item_id: string;
        menu_id?: string | null;
        quantity: number;
        service_window_start_at?: string | null;
        service_window_end_at?: string | null;
        repeats_with_series?: boolean;
        linked_asset_id?: string | null;
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
      throw new BadRequestException({
        code: 'multi_room_requires_two',
        message: 'Multi-room bookings require at least two spaces.',
      });
    }
    if (spaceIds.length > 10) {
      throw new BadRequestException({
        code: 'multi_room_too_many',
        message: 'Multi-room bookings are limited to 10 spaces.',
      });
    }

    // 1. Per-room rule resolution + space hydration. We resolve rules
    //    per-room because each room can have distinct rule set (e.g.
    //    catering required for room A, not B). The most restrictive
    //    outcome wins for the booking-level status.
    const spaceRows = await this.loadSpaces(tenantId, spaceIds);
    const denialMessages: string[] = [];
    let anyRequireApproval = false;
    const matchedRuleIds = new Set<string>();
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
        throw new NotFoundException({ code: 'space_not_found', message: `Space ${spaceId}` });
      }
      if (!space.active) {
        throw new BadRequestException({ code: 'space_inactive', message: `Space ${spaceId}` });
      }
      if (!space.reservable) {
        throw new BadRequestException({ code: 'space_not_reservable', message: `Space ${spaceId}` });
      }

      const buffers = await this.conflict.snapshotBuffersForBooking({
        space_id: spaceId,
        requester_person_id: input.requester_person_id,
        start_at: input.start_at,
        end_at: input.end_at,
        room_setup_buffer_minutes: space.setup_buffer_minutes ?? 0,
        room_teardown_buffer_minutes: space.teardown_buffer_minutes ?? 0,
      });

      const ruleOutcome = await this.ruleResolver.resolve({
        requester_person_id: input.requester_person_id,
        space_id: spaceId,
        start_at: input.start_at,
        end_at: input.end_at,
        attendee_count: input.attendee_count ?? null,
        criteria: {},
      });
      ruleOutcome.matchedRules.forEach((r) => matchedRuleIds.add(r.id));
      if (ruleOutcome.final === 'deny') {
        const overridable = actor.has_override_rules && ruleOutcome.overridable;
        if (!overridable) {
          throw new ForbiddenException({
            code: 'rule_deny',
            message: ruleOutcome.denialMessages[0] || 'Booking denied by booking rules.',
            denial_messages: ruleOutcome.denialMessages,
            failed_space_id: spaceId,
          });
        }
        if (!actor.override_reason) {
          throw new BadRequestException({
            code: 'override_reason_required',
            message: 'Service-desk override requires a reason.',
          });
        }
        denialMessages.push(...ruleOutcome.denialMessages);
      }
      if (ruleOutcome.final === 'require_approval') {
        anyRequireApproval = true;
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

    // 2. Coerce source. The legacy ReservationSource admits 'auto' for
    //    calendar-sync / system actors; the new bookings.source CHECK
    //    rejects it (00277:56-58).
    //
    //    /full-review v3 closure Nit (2026-05-04) — split coercion by
    //    actor: system:recurrence → 'recurrence' (provenance accurate
    //    after 00295), other system actors → 'calendar_sync', humans
    //    → input.source ?? 'portal'.
    const rawSource = actor.user_id.startsWith('system:')
      ? 'auto'
      : input.source ?? 'portal';
    const bookingSource: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence' =
      rawSource === 'auto'
        ? actor.user_id.startsWith('system:recurrence') ? 'recurrence' : 'calendar_sync'
        : rawSource;

    const status: 'pending_approval' | 'confirmed' = anyRequireApproval ? 'pending_approval' : 'confirmed';
    const policySnapshot: PolicySnapshot = {
      matched_rule_ids: Array.from(matchedRuleIds),
      effects_seen: [],
    };

    // 3. Atomic create_booking RPC with N slots (00277:236-334). The slot
    //    GiST exclusion fires inside the transaction so concurrent races
    //    surface as 23P01 here — caller gets a clean 409 with the
    //    failed-room id.
    const primarySpaceId = spaceIds[0];
    const { data: rpcData, error: rpcError } = await this.supabase.admin.rpc('create_booking', {
      p_requester_person_id: input.requester_person_id,
      p_location_id: primarySpaceId,                // booking-level anchor; slot-level holds the per-room space
      p_start_at: input.start_at,
      p_end_at: input.end_at,
      p_source: bookingSource,
      p_status: status,
      p_slots: slotSpecs,
      p_tenant_id: tenantId,
      p_host_person_id: input.host_person_id ?? null,
      p_title: null,
      p_description: null,
      p_timezone: 'UTC',
      p_booked_by_user_id: actor.user_id,
      p_cost_center_id: input.bundle?.cost_center_id ?? null,
      p_cost_amount_snapshot: null,
      p_policy_snapshot: policySnapshot,
      p_applied_rule_ids: Array.from(matchedRuleIds),
      p_config_release_id: null,
      p_recurrence_series_id: null,
      p_recurrence_index: null,
      p_template_id: input.bundle?.template_id ?? null,
    });

    if (rpcError) {
      if (this.conflict.isExclusionViolation(rpcError)) {
        throw new ConflictException({
          code: 'multi_room_booking_failed',
          message: 'One or more rooms are no longer available. No partial bookings created.',
          // The RPC inserts N slots in a single tx; on race the GiST
          // exclusion fails for whichever slot collided. We don't get
          // the offending space_id back from Postgres, so report all
          // requested rooms — the client picker will surface
          // alternatives.
          failed_space_ids: spaceIds,
        });
      }
      throw new BadRequestException({
        code: 'multi_room_create_failed',
        message: rpcError.message,
      });
    }

    const rpcRow = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { booking_id: string; slot_ids: string[] }
      | undefined;
    if (!rpcRow?.booking_id) {
      throw new BadRequestException({
        code: 'multi_room_create_failed',
        message: 'create_booking returned no booking_id',
      });
    }
    const bookingId = rpcRow.booking_id;

    // 4. Service attach (catering / AV) — primary slot only. Anchor on
    //    the booking id (the bundle, post-canonicalisation).
    //
    //    Phase 1.3: identical pattern to BookingFlowService.create. Wrap the
    //    attach in `txBoundary.runWithCompensation` so a failure rolls back
    //    the booking + slots atomically via `delete_booking_with_guard`
    //    (00292). Per blocker map (docs/follow-ups/phase-1-3-blocker-map.md):
    //    only recurrence_series can block compensation, and multi-room
    //    create doesn't materialise series, so partial_failure should be
    //    rare in practice — but the boundary still surfaces it for safety.
    //
    //    The legacy `bundleCascade.cancelOrdersForReservation` cleanup is
    //    no longer needed at this layer: the compensation RPC deletes the
    //    booking which cascades order rows via 00278:116 (SET NULL —
    //    Cleanup inside BundleService.attachServicesToBooking already
    //    ran on its own throw path before re-raising to us, so orders
    //    are already gone; the SET NULL is harmless).
    if (input.services && input.services.length > 0) {
      if (!this.txBoundary || !this.compensation) {
        throw new Error(
          'BookingTransactionBoundary + BookingCompensationService not injected — ' +
            'multi-room cannot atomically attach services. Wire both into ReservationsModule.providers.',
        );
      }
      // AttachServicesArgs shape verified at bundle.service.ts:58 (Phase 1.3
      // Read first #6): { booking_id, requester_person_id, bundle?, services }.
      const bundle = this.bundle;
      const compensation = this.compensation;
      await this.txBoundary.runWithCompensation(
        bookingId,
        () =>
          bundle.attachServicesToBooking({
            booking_id: bookingId,
            requester_person_id: input.requester_person_id,
            bundle: input.bundle
              ? {
                  bundle_type: input.bundle.bundle_type,
                  cost_center_id: input.bundle.cost_center_id ?? null,
                  template_id: input.bundle.template_id ?? null,
                  source: bookingSource,
                }
              : { source: bookingSource },
            services: input.services!,
          }),
        (id) => compensation.deleteBooking(id),
      );
    }

    // 5. Read the slots back through the booking for the response shape.
    const { data: slotRows, error: readErr } = await this.supabase.admin
      .from('booking_slots')
      .select(SLOT_WITH_BOOKING_SELECT)
      .eq('tenant_id', tenantId)
      .eq('booking_id', bookingId)
      .order('display_order', { ascending: true });
    if (readErr || !slotRows) {
      throw new BadRequestException({
        code: 'multi_room_read_failed',
        message: readErr?.message ?? 'no slots returned',
      });
    }
    const reservations = (slotRows as unknown as SlotWithBookingEmbed[]).map(
      slotWithBookingToReservation,
    );

    // Audit — phase K. One event per group create.
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: 'booking.multi_room_created',
        entity_type: 'booking',
        entity_id: bookingId,
        details: {
          space_ids: spaceIds,
          slot_ids: rpcRow.slot_ids,
          requester_person_id: input.requester_person_id,
          start_at: input.start_at,
          end_at: input.end_at,
        },
      });
    } catch { /* best-effort */ }

    this.log.log(`multi_room booking ${bookingId}: ${spaceIds.length} rooms`);
    return { group_id: bookingId, reservations };
  }

  // === helpers ===

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
    if (error) throw new BadRequestException(`load_spaces_failed:${error.message}`);
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

