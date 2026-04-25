// Reservations module — owns the reservations table lifecycle.
//
// Phase C wiring complete. Imports:
//   - RoomBookingRulesModule for RuleResolverService (Phase B)
//   - CalendarSyncModule for RoomMailboxService.registerIntercept hook (Phase H)

import { Module, OnModuleInit } from '@nestjs/common';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';
import { ConflictGuardService } from './conflict-guard.service';
import { RecurrenceService } from './recurrence.service';
import { CheckInService } from './check-in.service';
import { ReservationVisibilityService } from './reservation-visibility.service';
import { BookingFlowService } from './booking-flow.service';
import { ListBookableRoomsService } from './list-bookable-rooms.service';
import { RankingService } from './ranking.service';
import { RoomBookingRulesModule } from '../room-booking-rules/room-booking-rules.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { RoomMailboxService } from '../calendar-sync/room-mailbox.service';
import { Logger } from '@nestjs/common';

@Module({
  imports: [RoomBookingRulesModule, CalendarSyncModule],
  providers: [
    ReservationService,
    ConflictGuardService,
    RecurrenceService,
    CheckInService,
    ReservationVisibilityService,
    BookingFlowService,
    ListBookableRoomsService,
    RankingService,
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
  ],
})
export class ReservationsModule implements OnModuleInit {
  private readonly log = new Logger(ReservationsModule.name);

  constructor(
    private readonly roomMailbox: RoomMailboxService,
  ) {}

  onModuleInit() {
    // Wire the calendar-sync intercept handler. When a Pattern-A room mailbox
    // receives an Outlook invite, room-mailbox.service translates it to a
    // draft and calls this handler. The handler should resolve the organizer
    // + attendees to person_ids and run the booking pipeline.
    //
    // For now we return 'deferred' so the intercept is audited but neither
    // accepted nor rejected — Phase J will implement the email→person
    // resolution and call BookingFlowService.create with source='calendar_sync'.
    this.roomMailbox.registerIntercept(async (input) => {
      this.log.warn(
        `Outlook intercept received for space=${input.spaceId} (deferred — Phase J wiring pending)`,
      );
      return { outcome: 'deferred' as const };
    });
  }
}
