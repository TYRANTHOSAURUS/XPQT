import { Module, forwardRef } from '@nestjs/common';

import { PermissionGuard } from '../../common/permission-guard';
import { TicketModule } from '../ticket/ticket.module';
import { ServiceRoutingController } from './service-routing.controller';
import { ServiceRoutingService } from './service-routing.service';
import { SetupWorkOrderTriggerService } from './setup-work-order-trigger.service';

@Module({
  imports: [forwardRef(() => TicketModule)],
  providers: [PermissionGuard, ServiceRoutingService, SetupWorkOrderTriggerService],
  controllers: [ServiceRoutingController],
  exports: [ServiceRoutingService, SetupWorkOrderTriggerService],
})
export class ServiceRoutingModule {}
