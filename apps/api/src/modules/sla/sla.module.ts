import { Module, forwardRef } from '@nestjs/common';
import { SlaService } from './sla.service';
import { BusinessHoursService } from './business-hours.service';
import { SlaController } from './sla.controller';
import { SlaPolicyController } from './sla-policy.controller';
import { NotificationModule } from '../notification/notification.module';
import { TicketModule } from '../ticket/ticket.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [NotificationModule, forwardRef(() => TicketModule), AuthModule],
  providers: [SlaService, BusinessHoursService],
  controllers: [SlaController, SlaPolicyController],
  // BusinessHoursService is exported so the outbox SlaTimerHandler
  // (apps/api/src/modules/outbox/handlers/sla-timer-recompute.handler.ts)
  // can compute SLA timer due_at values without going through the full
  // SlaService surface. B.2.A.Step12 commit 2.
  exports: [SlaService, BusinessHoursService],
})
export class SlaModule {}
