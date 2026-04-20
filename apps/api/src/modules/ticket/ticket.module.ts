import { Module, forwardRef } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { DispatchService } from './dispatch.service';
import { TicketVisibilityService } from './ticket-visibility.service';
import { RoutingModule } from '../routing/routing.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ApprovalModule } from '../approval/approval.module';

@Module({
  imports: [
    RoutingModule,
    forwardRef(() => SlaModule),
    forwardRef(() => WorkflowModule),
    forwardRef(() => ApprovalModule),
  ],
  providers: [TicketService, DispatchService, TicketVisibilityService],
  controllers: [TicketController],
  exports: [TicketService, DispatchService, TicketVisibilityService],
})
export class TicketModule {}
