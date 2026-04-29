import { Module } from '@nestjs/common';

import { PermissionGuard } from '../../common/permission-guard';
import { ServiceRoutingController } from './service-routing.controller';
import { ServiceRoutingService } from './service-routing.service';

@Module({
  providers: [PermissionGuard, ServiceRoutingService],
  controllers: [ServiceRoutingController],
  exports: [ServiceRoutingService],
})
export class ServiceRoutingModule {}
