import { Module, forwardRef } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ApprovalController } from './approval.controller';
import { TicketModule } from '../ticket/ticket.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { BookingBundlesModule } from '../booking-bundles/booking-bundles.module';
import { VisitorsModule } from '../visitors/visitors.module';

@Module({
  // forwardRef on ReservationsModule + BookingBundlesModule keeps the dep
  // graph safe — neither imports ApprovalModule today, but both can plausibly
  // call back into approvals in the future without breaking the cycle check.
  //
  // VisitorsModule (slice 3): forwardRef is mandatory because VisitorsModule
  // already imports ApprovalModule (the InvitationService creates the
  // approval row at invite time). Without forwardRef on both sides Nest
  // would refuse to compile the cycle.
  imports: [
    forwardRef(() => TicketModule),
    forwardRef(() => ReservationsModule),
    forwardRef(() => BookingBundlesModule),
    forwardRef(() => VisitorsModule),
  ],
  providers: [ApprovalService],
  controllers: [ApprovalController],
  exports: [ApprovalService],
})
export class ApprovalModule {}
