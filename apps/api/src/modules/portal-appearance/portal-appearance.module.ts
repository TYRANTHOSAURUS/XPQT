// apps/api/src/modules/portal-appearance/portal-appearance.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';
import { PortalAppearanceController } from './portal-appearance.controller';
import { PortalAppearanceService } from './portal-appearance.service';

@Module({
  // RLS audit Slice 11.3: re-gated AuthGuard+AdminGuard →
  // @RequirePermission('settings.read'/'settings.update'); AuthModule
  // dropped, permission guards provided locally (config-engine pattern).
  imports: [SupabaseModule],
  controllers: [PortalAppearanceController],
  providers: [PortalAppearanceService, PermissionGuard, PermissionMetadataGuard],
  exports: [PortalAppearanceService],
})
export class PortalAppearanceModule {}
