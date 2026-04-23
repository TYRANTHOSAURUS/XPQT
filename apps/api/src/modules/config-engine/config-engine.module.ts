import { Module } from '@nestjs/common';
import { ConfigEngineService } from './config-engine.service';
import { RequestTypeService } from './request-type.service';
import { ServiceCatalogService } from './service-catalog.service';
import { CriteriaSetService } from './criteria-set.service';
import { RequestTypeController } from './request-type.controller';
import { ServiceCatalogController } from './service-catalog.controller';
import { ConfigEntityController } from './config-entity.controller';
import { CriteriaSetController } from './criteria-set.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [
    ConfigEngineService,
    RequestTypeService,
    ServiceCatalogService,
    CriteriaSetService,
    PermissionGuard,
  ],
  controllers: [
    RequestTypeController,
    ServiceCatalogController,
    ConfigEntityController,
    CriteriaSetController,
  ],
  exports: [ConfigEngineService, RequestTypeService, ServiceCatalogService, CriteriaSetService],
})
export class ConfigEngineModule {}
