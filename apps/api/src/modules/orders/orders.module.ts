import { Module } from '@nestjs/common';

import { OrdersController } from './orders.controller';
import { OrderService } from './order.service';
import { ApprovalRoutingService } from './approval-routing.service';

@Module({
  providers: [OrderService, ApprovalRoutingService],
  controllers: [OrdersController],
  exports: [OrderService, ApprovalRoutingService],
})
export class OrdersModule {}
