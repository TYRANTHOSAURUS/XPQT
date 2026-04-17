import { Global, Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { BrandingService } from './branding.service';
import { BrandingController } from './branding.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuthModule],
  providers: [TenantService, BrandingService],
  controllers: [TenantController, BrandingController],
  exports: [TenantService],
})
export class TenantModule {}
