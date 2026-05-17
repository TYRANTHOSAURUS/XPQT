// Reservations module — owns the reservations table lifecycle.
//
// Phase C wiring complete. Imports:
//   - RoomBookingRulesModule for RuleResolverService (Phase B)
//   - CalendarSyncModule for RoomMailboxService.registerIntercept hook (Phase J)
//   - NotificationModule for BookingNotificationsService

import { ConflictException, ForbiddenException, forwardRef, Logger, Module, OnModuleInit } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { AppError } from '../../common/errors';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';
import { ConflictGuardService } from './conflict-guard.service';
import { RecurrenceService } from './recurrence.service';
import { CheckInService } from './check-in.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { BookingFlowService } from './booking-flow.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import { RankingService } from './ranking.service';
import { MultiRoomBookingService } from './multi-room-booking.service';
import { MultiAttendeeFinder } from './multi-attendee.service';
import { BookingNotificationsService } from './booking-notifications.service';
import { AssembleEditPlanService } from './assemble-edit-plan.service';
import { RoomBookingRulesModule } from '../room-booking-rules/room-booking-rules.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { NotificationModule } from '../notification/notification.module';
import { BookingBundlesModule } from '../booking-bundles/booking-bundles.module';
import { OrdersModule } from '../orders/orders.module';
import { OrderService } from '../orders/order.service';
import { RoomMailboxService } from '../calendar-sync/room-mailbox.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import type { ActorContext, CreateReservationInput } from './dto/types';

@Module({
  imports: [
    RoomBookingRulesModule,
    CalendarSyncModule,
    NotificationModule,
    BookingBundlesModule,
    OrdersModule,
    // Phase 1.5 sub-step 6.E: WorkflowService is invoked when a matched
    // rule carries a populated workflow_definition_id. forwardRef because
    // WorkflowModule's outbox handlers reach back through ReservationsModule
    // for booking-lifecycle event types (see booking-flow.service.ts emit
    // path); the cycle is benign at runtime since the providers don't read
    // each other at construction time.
    forwardRef(() => WorkflowModule),
  ],
  providers: [
    ReservationService,
    ConflictGuardService,
    RecurrenceService,
    CheckInService,
    ReservationVisibilityService,
    BookingFlowService,
    ListBookableRoomsService,
    RankingService,
    MultiRoomBookingService,
    MultiAttendeeFinder,
    BookingNotificationsService,
    // B.4 step 2D-C — TS-side EditPlan builder for the edit_booking RPC.
    // Step 2D-D will wire it into the editSlot controller path.
    AssembleEditPlanService,
  ],
  controllers: [ReservationController],
  exports: [
    ReservationService,
    ConflictGuardService,
    RecurrenceService,
    CheckInService,
    ReservationVisibilityService,
    BookingFlowService,
    ListBookableRoomsService,
    RankingService,
    MultiRoomBookingService,
    MultiAttendeeFinder,
    BookingNotificationsService,
    AssembleEditPlanService,
  ],
})
export class ReservationsModule implements OnModuleInit {
  private readonly log = new Logger(ReservationsModule.name);

  constructor(
    private readonly roomMailbox: RoomMailboxService,
    private readonly bookingFlow: BookingFlowService,
    private readonly recurrence: RecurrenceService,
    private readonly supabase: SupabaseService,
    private readonly tenants: TenantService,
    private readonly orders: OrderService,
  ) {}

  onModuleInit() {
    // Break the circular dep between BookingFlowService and RecurrenceService:
    // both are constructed independently, then wired here at module-init.
    this.recurrence.setBookingFlow(this.bookingFlow);
    // Sub-project 2: when a master reservation has a booking_bundle, the
    // materialiser fans out orders + lines + asset_reservations onto each
    // new occurrence. Wired here for the same reason — OrdersModule pulls
    // in ServiceCatalogModule which would otherwise create a cycle.
    this.recurrence.setOrdersFanOut({
      cloneOrderForOccurrence: (args) => this.orders.cloneOrderForOccurrence(args),
    });
    // Booking-audit Slice 2 (audit 03 P0-1/P1-5): the recurrence
    // cancelForward bundle-cascade wiring was REMOVED. cancelForward is
    // retired; ReservationService.cancelOne now routes every scope
    // (this | this_and_following | series) through the atomic
    // cancel_booking_with_cascade RPC (00408) which owns the whole
    // cascade in one transaction. No setBundleCascade call remains.

    // Wire the calendar-sync intercept handler. When a Pattern-A room mailbox
    // receives an Outlook invite, room-mailbox.service translates it to a
    // draft and calls this handler. We resolve the organizer + attendees to
    // person_ids and run the booking pipeline with source='calendar_sync'.
    this.roomMailbox.registerIntercept(async ({ draft, tenantId }) => {
      try {
        const tenant = await this.tenants.resolveById(tenantId);
        if (!tenant) {
          this.log.warn(`Outlook intercept: tenant ${tenantId} not found`);
          return { outcome: 'deferred' as const };
        }
        return await TenantContext.run(
          tenant,
          async () => this.handleOutlookIntercept(draft, tenantId),
        );
      } catch (err) {
        this.log.error(`Outlook intercept threw: ${(err as Error).message}`);
        return { outcome: 'deferred' as const };
      }
    });
  }

  /**
   * Resolve organizer + attendee emails → person_ids, then run the booking
   * pipeline. Mapping outcome → intercept return:
   *   - success                     → { outcome: 'accepted' }
   *   - ForbiddenException(deny)    → { outcome: 'denied', denialMessage }
   *   - ConflictException(slot)     → { outcome: 'conflict' }
   *   - any other error             → { outcome: 'deferred' } (audit + retry on next webhook miss)
   */
  private async handleOutlookIntercept(
    draft: {
      tenant_id: string;
      space_id: string;
      start_at: string;
      end_at: string;
      organizer_email: string | null;
      attendee_emails: string[];
      attendee_count: number;
      external_event_id: string;
    },
    tenantId: string,
  ): Promise<{ outcome: 'accepted' | 'denied' | 'conflict' | 'deferred'; denialMessage?: string }> {
    if (!draft.organizer_email) {
      return {
        outcome: 'denied',
        denialMessage: 'Organizer is missing — cannot resolve to a Prequest user.',
      };
    }
    const organizer = await this.findPersonByEmail(draft.organizer_email, tenantId);
    if (!organizer) {
      return {
        outcome: 'denied',
        denialMessage: 'Organizer email is not a registered Prequest user.',
      };
    }

    const attendeePersonIds: string[] = [];
    for (const email of draft.attendee_emails) {
      // Best-effort attendee resolution; missing emails dropped silently.
      const p = await this.findPersonByEmail(email, tenantId);
      if (p) attendeePersonIds.push(p.id);
    }

    const input: CreateReservationInput = {
      space_id: draft.space_id,
      requester_person_id: organizer.id,
      start_at: draft.start_at,
      end_at: draft.end_at,
      attendee_count: draft.attendee_count,
      attendee_person_ids: attendeePersonIds,
      source: 'calendar_sync',
    };

    // Synthetic actor — the booking is non-overridable; rules + conflict
    // guard run as for any portal booking.
    const actor: ActorContext = {
      user_id: `system:outlook:${draft.external_event_id}`,
      // Synthetic — Outlook sync only calls bookingFlow.create, never the
      // F-CRIT-1 edit RPCs. Mirror user_id so the required field is set.
      auth_uid: `system:outlook:${draft.external_event_id}`,
      person_id: organizer.id,
      is_service_desk: false,
      has_override_rules: false,
    };

    try {
      await this.bookingFlow.create(input, actor);
      return { outcome: 'accepted' };
    } catch (err) {
      // I1 (Phase 7.A.2.b-d review): bookingFlow.create() now throws AppError,
      // not ForbiddenException/ConflictException. Dispatch on code, not class,
      // so deny + conflict don't get silently routed to "deferred".
      if (err instanceof AppError) {
        if (err.code === 'rule_deny' || err.code === 'service_rule_deny') {
          // detail carries the admin-authored denial prose for rule_deny;
          // service_rule_deny may stash structured deny payload in fields[].
          return {
            outcome: 'denied',
            denialMessage: err.detail ?? 'Booking denied by rules.',
          };
        }
        if (
          err.code === 'reservation_slot_conflict' ||
          err.code === 'booking.slot_conflict' ||
          err.code === 'asset_conflict'
        ) {
          return { outcome: 'conflict' };
        }
      }
      // Some legacy code paths may still throw raw Nest exceptions
      // (ForbiddenException / ConflictException); keep the class checks
      // as a fallback alongside the AppError-code dispatch above.
      if (err instanceof ForbiddenException) {
        const e = err.getResponse() as { code?: string; message?: string };
        return { outcome: 'denied', denialMessage: e?.message ?? 'Booking denied by rules.' };
      }
      if (err instanceof ConflictException) {
        return { outcome: 'conflict' };
      }
      this.log.error(`Outlook intercept booking flow failed: ${(err as Error).message}`);
      return { outcome: 'deferred' };
    }
  }

  private async findPersonByEmail(
    email: string,
    tenantId: string,
  ): Promise<{ id: string } | null> {
    const { data } = await this.supabase.admin
      .from('persons')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('email', email)
      .maybeSingle();
    return (data as { id: string } | null) ?? null;
  }
}
