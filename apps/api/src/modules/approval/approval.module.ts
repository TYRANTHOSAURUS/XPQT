import { Module, forwardRef } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ApprovalController } from './approval.controller';
import { TicketModule } from '../ticket/ticket.module';
import { ReservationsModule } from '../reservations/reservations.module';

@Module({
  // forwardRef on ReservationsModule keeps the dep graph safe even if a
  // future change makes the reservations module call back into approvals.
  imports: [forwardRef(() => TicketModule), forwardRef(() => ReservationsModule)],
  providers: [ApprovalService],
  controllers: [ApprovalController],
  exports: [ApprovalService],
})
export class ApprovalModule {}
