import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { RoutingRuleController } from './routing.controller';

@Module({
  providers: [RoutingService],
  controllers: [RoutingRuleController],
  exports: [RoutingService],
})
export class RoutingModule {}
