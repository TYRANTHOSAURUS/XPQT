import { Module } from '@nestjs/common';
import { FloorPlanController } from './floor-plan.controller';
import { FloorPlanAdminController } from './floor-plan-admin.controller';
import { FloorPlanService } from './floor-plan.service';
import { FloorPlanDraftService } from './floor-plan-draft.service';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [FloorPlanController, FloorPlanAdminController],
  providers: [FloorPlanService, FloorPlanDraftService, PermissionGuard],
  exports: [FloorPlanService],
})
export class FloorPlanModule {}
