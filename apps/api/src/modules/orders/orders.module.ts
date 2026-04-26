import { Module } from '@nestjs/common';

import { OrdersController } from './orders.controller';
import { OrderService } from './order.service';

@Module({
  providers: [OrderService],
  controllers: [OrdersController],
  exports: [OrderService],
})
export class OrdersModule {}
