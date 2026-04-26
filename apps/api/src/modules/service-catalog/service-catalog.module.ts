import { Module } from '@nestjs/common';

import { ServiceCatalogController } from './service-catalog.controller';
import { ServiceRuleService } from './service-rule.service';

@Module({
  providers: [ServiceRuleService],
  controllers: [ServiceCatalogController],
  exports: [ServiceRuleService],
})
export class ServiceCatalogModule {}
