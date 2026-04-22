import { Module } from '@nestjs/common';
import { TicketModule } from '../ticket/ticket.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalSubmitService } from './portal-submit.service';

@Module({
  imports: [TicketModule],
  providers: [PortalService, PortalSubmitService],
  controllers: [PortalController],
  exports: [PortalService, PortalSubmitService],
})
export class PortalModule {}
