import { Module } from '@nestjs/common';

import { PermissionGuard } from '../../common/permission-guard';
import { RoomBookingRulesModule } from '../room-booking-rules/room-booking-rules.module';
import { ServiceCatalogController } from './service-catalog.controller';
import { ServiceRuleService } from './service-rule.service';
import { ServiceRuleResolverService } from './service-rule-resolver.service';

@Module({
  imports: [RoomBookingRulesModule],
  providers: [PermissionGuard, ServiceRuleService, ServiceRuleResolverService],
  controllers: [ServiceCatalogController],
  exports: [ServiceRuleService, ServiceRuleResolverService],
})
export class ServiceCatalogModule {}
