import { Module, forwardRef } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ApprovalController } from './approval.controller';
import { TicketModule } from '../ticket/ticket.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { BookingBundlesModule } from '../booking-bundles/booking-bundles.module';

@Module({
  // forwardRef on ReservationsModule + BookingBundlesModule keeps the dep
  // graph safe — neither imports ApprovalModule today, but both can plausibly
  // call back into approvals in the future without breaking the cycle check.
  imports: [
    forwardRef(() => TicketModule),
    forwardRef(() => ReservationsModule),
    forwardRef(() => BookingBundlesModule),
  ],
  providers: [ApprovalService],
  controllers: [ApprovalController],
  exports: [ApprovalService],
})
export class ApprovalModule {}
