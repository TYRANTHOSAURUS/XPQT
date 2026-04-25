// Reservations module — owns the reservations table lifecycle.
//
// PARTIAL — Phase C scaffold. The full booking pipeline (BookingFlowService,
// ListBookableRoomsService, RankingService, MultiAttendeeFinder,
// MultiRoomBookingService) is added once Phase B (room-booking-rules) is
// integrated. Until then this module exposes:
//
//   - ReservationService    : findOne, listMine, cancelOne, restore, editOne, skipOccurrence
//   - ConflictGuardService  : preCheck, snapshotBuffersForBooking, isExclusionViolation
//   - RecurrenceService     : pure expand + previewImpact
//   - CheckInService        : explicit check-in + auto-release cron
//   - ReservationVisibilityService : 3-tier visibility filter
//
// NOTE: this module is NOT yet wired into AppModule. Wiring happens once the
// concurrent Phase B + Phase H subagents complete their work and we integrate
// all three together.

import { Module } from '@nestjs/common';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';
import { ConflictGuardService } from './conflict-guard.service';
import { RecurrenceService } from './recurrence.service';
import { CheckInService } from './check-in.service';
import { ReservationVisibilityService } from './reservation-visibility.service';

@Module({
  providers: [
    ReservationService,
    ConflictGuardService,
    RecurrenceService,
    CheckInService,
    ReservationVisibilityService,
  ],
  controllers: [ReservationController],
  exports: [
    ReservationService,
    ConflictGuardService,
    RecurrenceService,
    CheckInService,
    ReservationVisibilityService,
  ],
})
export class ReservationsModule {}
