// apps/api/src/modules/portal-announcements/portal-announcements.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';
import { PortalAnnouncementsController } from './portal-announcements.controller';
import { PortalAnnouncementsService } from './portal-announcements.service';

@Module({
  // RLS audit Slice 11.3: re-gated AuthGuard+AdminGuard →
  // @RequirePermission('settings.read'/'settings.update'); AuthModule
  // dropped, permission guards provided locally (config-engine pattern).
  imports: [SupabaseModule],
  controllers: [PortalAnnouncementsController],
  providers: [PortalAnnouncementsService, PermissionGuard, PermissionMetadataGuard],
  exports: [PortalAnnouncementsService],
})
export class PortalAnnouncementsModule {}
