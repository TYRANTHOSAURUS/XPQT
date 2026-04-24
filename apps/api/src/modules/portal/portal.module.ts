import { Module } from '@nestjs/common';
import { TicketModule } from '../ticket/ticket.module';
import { PortalAppearanceModule } from '../portal-appearance/portal-appearance.module';
import { PortalAnnouncementsModule } from '../portal-announcements/portal-announcements.module';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalSubmitService } from './portal-submit.service';

@Module({
  imports: [TicketModule, PortalAppearanceModule, PortalAnnouncementsModule],
  providers: [PortalService, PortalSubmitService],
  controllers: [PortalController],
  exports: [PortalService, PortalSubmitService],
})
export class PortalModule {}
