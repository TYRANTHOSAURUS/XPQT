import { Module, forwardRef } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { RoutingModule } from '../routing/routing.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowModule } from '../workflow/workflow.module';

@Module({
  imports: [
    RoutingModule,
    SlaModule,
    forwardRef(() => WorkflowModule),
  ],
  providers: [TicketService],
  controllers: [TicketController],
  exports: [TicketService],
})
export class TicketModule {}
