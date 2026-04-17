import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';

@Module({
  providers: [RoutingService, ResolverService, ResolverRepository],
  controllers: [RoutingRuleController],
  exports: [RoutingService],
})
export class RoutingModule {}
