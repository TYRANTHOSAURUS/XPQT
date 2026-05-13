import { Module, forwardRef } from '@nestjs/common';
import { ApprovalService } from './approval.service';
import { ApprovalConfigCompilerService } from './approval-config-compiler.service';
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
  // ApprovalConfigCompilerService — Phase 1.5 sub-step 6.A.X. Pure-TS,
  // zero-DI compiler that transforms `ApprovalConfig` to a
  // `workflow_definitions.graph_definition` jsonb. Exported so the
  // room-booking-rules service (cutover in sub-step 6.E) can call it
  // before invoking the `ensure_room_booking_rule_workflow_definition`
  // RPC.
  providers: [ApprovalService, ApprovalConfigCompilerService],
  controllers: [ApprovalController],
  exports: [ApprovalService, ApprovalConfigCompilerService],
})
export class ApprovalModule {}
