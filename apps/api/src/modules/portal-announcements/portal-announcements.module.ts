// apps/api/src/modules/portal-announcements/portal-announcements.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { PortalAnnouncementsController } from './portal-announcements.controller';
import { PortalAnnouncementsService } from './portal-announcements.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [PortalAnnouncementsController],
  providers: [PortalAnnouncementsService],
  exports: [PortalAnnouncementsService],
})
export class PortalAnnouncementsModule {}
