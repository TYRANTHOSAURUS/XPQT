import { Module, forwardRef } from '@nestjs/common';

import { PermissionGuard } from '../../common/permission-guard';
import { TicketModule } from '../ticket/ticket.module';
import { ServiceRoutingController } from './service-routing.controller';
import { ServiceRoutingService } from './service-routing.service';
import { SetupWorkOrderRowBuilder } from './setup-work-order-row-builder.service';
import { SetupWorkOrderTriggerService } from './setup-work-order-trigger.service';

@Module({
  imports: [forwardRef(() => TicketModule)],
  providers: [
    PermissionGuard,
    ServiceRoutingService,
    SetupWorkOrderTriggerService,
    // B.0.C.5 — pure row-builder for the outbox handler path. Dormant
    // until the SetupWorkOrderHandler (B.0.D / Phase B cutover) consumes
    // it. Spec §7.7.
    SetupWorkOrderRowBuilder,
  ],
  controllers: [ServiceRoutingController],
  exports: [
    ServiceRoutingService,
    SetupWorkOrderTriggerService,
    SetupWorkOrderRowBuilder,
  ],
})
export class ServiceRoutingModule {}
