import { Module, forwardRef } from '@nestjs/common';
import { WorkOrderService } from './work-order.service';
import { WorkOrderController } from './work-order.controller';
import { SlaModule } from '../sla/sla.module';
import { TicketModule } from '../ticket/ticket.module';

@Module({
  imports: [
    // SlaModule is forward-referenced to mirror TicketModule's pattern: SLA
    // cycles through ticket-shaped services. TicketModule is also forwarded
    // because we re-use TicketVisibilityService (assertCanPlan).
    forwardRef(() => SlaModule),
    forwardRef(() => TicketModule),
  ],
  providers: [WorkOrderService],
  controllers: [WorkOrderController],
  exports: [WorkOrderService],
})
export class WorkOrdersModule {}
