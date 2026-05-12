import { Controller, Get, Param } from '@nestjs/common';
import { TenantContext } from '../../common/tenant-context';
import { FloorPlanService } from './floor-plan.service';

/**
 * Lightweight building-level endpoints.
 *
 * Mounted at `buildings/:buildingId`. Auth: global AuthGuard (APP_GUARD).
 */
@Controller('buildings/:buildingId')
export class BuildingsController {
  constructor(private readonly plan: FloorPlanService) {}

  /** GET /api/buildings/:buildingId/floors — floor spaces for a building. */
  @Get('floors')
  async listFloors(@Param('buildingId') buildingId: string) {
    const tenantId = TenantContext.current().id;
    return this.plan.listBuildingFloors(buildingId, tenantId);
  }
}
