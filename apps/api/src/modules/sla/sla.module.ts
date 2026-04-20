import { Module, forwardRef } from '@nestjs/common';
import { SlaService } from './sla.service';
import { BusinessHoursService } from './business-hours.service';
import { SlaController } from './sla.controller';
import { SlaPolicyController } from './sla-policy.controller';
import { NotificationModule } from '../notification/notification.module';
import { TicketModule } from '../ticket/ticket.module';

@Module({
  imports: [NotificationModule, forwardRef(() => TicketModule)],
  providers: [SlaService, BusinessHoursService],
  controllers: [SlaController, SlaPolicyController],
  exports: [SlaService],
})
export class SlaModule {}
