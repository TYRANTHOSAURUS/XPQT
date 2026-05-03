import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { BrandingService } from './branding.service';
import { BrandingController } from './branding.controller';
import { MealWindowsService } from './meal-windows.service';
import { MealWindowsController } from './meal-windows.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  providers: [TenantService, BrandingService, MealWindowsService],
  controllers: [TenantController, BrandingController, MealWindowsController],
  exports: [TenantService, MealWindowsService],
})
export class TenantModule {}
