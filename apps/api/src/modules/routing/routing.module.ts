import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { ResolverService } from './resolver.service';
import { ResolverRepository } from './resolver-repository';
import { RoutingRuleController } from './routing.controller';
import { LocationTeamsController } from './location-teams.controller';
import { SpaceGroupsController } from './space-groups.controller';
import { DomainParentsController } from './domain-parents.controller';
import { RoutingSimulatorController } from './simulator.controller';
import { RoutingSimulatorService } from './simulator.service';
import { RoutingAuditService } from './audit.service';
import { RoutingCoverageService } from './coverage.service';
import { RoutingEvaluatorService } from './routing-evaluator.service';
import { PolicyStoreService } from './policy-store.service';
import { DomainRegistryService } from './domain-registry.service';

@Module({
  providers: [
    RoutingService,
    ResolverService,
    ResolverRepository,
    RoutingSimulatorService,
    RoutingAuditService,
    RoutingCoverageService,
    RoutingEvaluatorService,
    PolicyStoreService,
    DomainRegistryService,
  ],
  controllers: [
    RoutingRuleController,
    LocationTeamsController,
    SpaceGroupsController,
    DomainParentsController,
    RoutingSimulatorController,
  ],
  exports: [RoutingService, RoutingEvaluatorService, PolicyStoreService, DomainRegistryService],
})
export class RoutingModule {}
