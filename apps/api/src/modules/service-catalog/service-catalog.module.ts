import { Module } from '@nestjs/common';
import { ServiceItemService } from './service-item.service';
import { ServiceItemController } from './service-item.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [ServiceItemService, PermissionGuard],
  controllers: [ServiceItemController],
  exports: [ServiceItemService],
})
export class ServiceCatalogModule {}
