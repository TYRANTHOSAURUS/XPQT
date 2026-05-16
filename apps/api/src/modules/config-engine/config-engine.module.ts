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
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  // RLS audit Slice 11.3: ConfigEntityController (the last AdminGuard
  // consumer here) re-gated AdminGuard → @RequirePermission(
  // 'request_types.*'); AuthModule dropped. All controllers in this
  // module now gate via the permission catalog (PermissionGuard +
  // PermissionMetadataGuard, provided below).
  providers: [
    ConfigEngineService,
    RequestTypeService,
    ServiceCatalogService,
    CriteriaSetService,
    PermissionGuard,
    PermissionMetadataGuard,
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
