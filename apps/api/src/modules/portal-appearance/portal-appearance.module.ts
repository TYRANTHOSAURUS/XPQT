// apps/api/src/modules/portal-appearance/portal-appearance.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { PortalAppearanceController } from './portal-appearance.controller';
import { PortalAppearanceService } from './portal-appearance.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [PortalAppearanceController],
  providers: [PortalAppearanceService],
  exports: [PortalAppearanceService],
})
export class PortalAppearanceModule {}
