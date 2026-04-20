import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';
import { LocationTeamsController } from './location-teams.controller';
import { SpaceGroupsController } from './space-groups.controller';
import { DomainParentsController } from './domain-parents.controller';

@Module({
  providers: [RoutingService, ResolverService, ResolverRepository],
  controllers: [
    RoutingRuleController,
    LocationTeamsController,
    SpaceGroupsController,
    DomainParentsController,
  ],
  exports: [RoutingService],
})
export class RoutingModule {}
