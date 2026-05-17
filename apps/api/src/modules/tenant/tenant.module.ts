import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { BrandingService } from './branding.service';
import { BrandingController } from './branding.controller';
import { MealWindowsService } from './meal-windows.service';
import { MealWindowsController } from './meal-windows.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Global()
@Module({
  // RLS audit Slice 11.3: BrandingController re-gated AuthGuard+AdminGuard
  // → @RequirePermission('settings.update') (public GET /current/branding
  // stays public); no controller here uses AdminGuard anymore, so
  // AuthModule is dropped and the permission guards are provided locally
  // (config-engine.module pattern). The global AuthGuard (APP_GUARD)
  // still runs and sets request.user.platformUserId for the permission
  // path; the explicit per-route AuthGuard was redundant post-Slice-1.
  providers: [
    TenantService,
    BrandingService,
    MealWindowsService,
    PermissionGuard,
    PermissionMetadataGuard,
  ],
  controllers: [TenantController, BrandingController, MealWindowsController],
  exports: [TenantService, MealWindowsService],
})
export class TenantModule {}
