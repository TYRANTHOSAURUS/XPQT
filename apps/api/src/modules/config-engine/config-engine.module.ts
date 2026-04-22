import { Module } from '@nestjs/common';
import { ConfigEngineService } from './config-engine.service';
import { RequestTypeService } from './request-type.service';
import { ServiceCatalogService } from './service-catalog.service';
import { RequestTypeController } from './request-type.controller';
import { ServiceCatalogController } from './service-catalog.controller';
import { ConfigEntityController } from './config-entity.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [ConfigEngineService, RequestTypeService, ServiceCatalogService, PermissionGuard],
  controllers: [RequestTypeController, ServiceCatalogController, ConfigEntityController],
  exports: [ConfigEngineService, RequestTypeService, ServiceCatalogService],
})
export class ConfigEngineModule {}
