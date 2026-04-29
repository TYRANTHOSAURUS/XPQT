import { Module, forwardRef } from '@nestjs/common';

import { ServiceCatalogModule } from '../service-catalog/service-catalog.module';
import { TicketModule } from '../ticket/ticket.module';
import { OrdersController } from './orders.controller';
import { OrderService } from './order.service';
import { ApprovalRoutingService } from './approval-routing.service';
import { CostService } from './cost.service';

@Module({
  imports: [ServiceCatalogModule, forwardRef(() => TicketModule)],
  providers: [OrderService, ApprovalRoutingService, CostService],
  controllers: [OrdersController],
  exports: [OrderService, ApprovalRoutingService, CostService],
})
export class OrdersModule {}
