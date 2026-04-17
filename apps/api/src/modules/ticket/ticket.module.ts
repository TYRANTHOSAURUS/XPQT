import { Module, forwardRef } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { DispatchService } from './dispatch.service';
import { RoutingModule } from '../routing/routing.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ApprovalModule } from '../approval/approval.module';

@Module({
  imports: [
    RoutingModule,
    SlaModule,
    forwardRef(() => WorkflowModule),
    forwardRef(() => ApprovalModule),
  ],
  providers: [TicketService, DispatchService],
  controllers: [TicketController],
  exports: [TicketService, DispatchService],
})
export class TicketModule {}
