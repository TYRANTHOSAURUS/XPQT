// Reservations module — owns the reservations table lifecycle.
//
// Phase C wiring complete. Imports:
//   - RoomBookingRulesModule for RuleResolverService (Phase B)
//   - CalendarSyncModule for RoomMailboxService.registerIntercept hook (Phase J)
//   - NotificationModule for BookingNotificationsService

import { ConflictException, ForbiddenException, Logger, Module, OnModuleInit } from '@nestjs/common';
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
import { RoomBookingRulesModule } from '../room-booking-rules/room-booking-rules.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { NotificationModule } from '../notification/notification.module';
import { RoomMailboxService } from '../calendar-sync/room-mailbox.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TenantService } from '../tenant/tenant.service';
import type { ActorContext, CreateReservationInput } from './dto/types';

@Module({
  imports: [RoomBookingRulesModule, CalendarSyncModule, NotificationModule],
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
  ) {}

  onModuleInit() {
    // Break the circular dep between BookingFlowService and RecurrenceService:
    // both are constructed independently, then wired here at module-init.
    this.recurrence.setBookingFlow(this.bookingFlow);

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
      person_id: organizer.id,
      is_service_desk: false,
      has_override_rules: false,
    };

    try {
      await this.bookingFlow.create(input, actor);
      return { outcome: 'accepted' };
    } catch (err) {
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
