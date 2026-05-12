import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/permission-guard';
import { MaintenancePlanController } from './maintenance-plan.controller';
import { MaintenancePlanService } from './maintenance-plan.service';
import { PMGeneratorCron } from './pm-generator.cron';
import { PMGeneratorService } from './pm-generator.service';

/**
 * MaintenanceModule — Slice C PM (preventive-maintenance) generator surface.
 *
 * Plan: ai/slice-c-plan.md §5. Bundles:
 *   - MaintenancePlanService (CRUD over maintenance_plans).
 *   - PMGeneratorService (the per-tenant generation pipeline).
 *   - PMGeneratorCron (nightly @Cron('0 3 * * *') trigger; gated by
 *     PM_GENERATOR_ENABLED).
 *   - MaintenancePlanController (admin endpoints).
 *
 * ScheduleModule.forRoot() is wired in app.module.ts (already in place
 * for WorkflowWaitSweeperCron) — no extra registration needed here.
 *
 * Permission gate: PermissionGuard is provided locally rather than
 * imported from another module (it's defined under apps/api/src/common,
 * not exported as a NestModule provider elsewhere). Same pattern as
 * other admin-only controllers that need user_has_permission checks.
 */
@Module({
  providers: [
    MaintenancePlanService,
    PMGeneratorService,
    PMGeneratorCron,
    PermissionGuard,
  ],
  controllers: [MaintenancePlanController],
  exports: [MaintenancePlanService, PMGeneratorService],
})
export class MaintenanceModule {}
