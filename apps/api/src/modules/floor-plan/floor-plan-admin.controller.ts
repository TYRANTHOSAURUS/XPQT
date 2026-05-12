import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { TenantContext } from '../../common/tenant-context';
import { FloorPlanService } from './floor-plan.service';

/**
 * Admin index endpoint: `GET /admin/floor-plans-index`
 *
 * Returns a summary row per floor space in the tenant (name, building, has_plan,
 * last_published_at). Used by the admin floor plans list page.
 *
 * Separate controller (distinct path) to avoid route collision with the
 * per-floor `/floors/:floorSpaceId/plan` controller.
 *
 * Auth: global `AuthGuard` (APP_GUARD) + `floor_plans.admin` permission check.
 */
@Controller('admin/floor-plans-index')
export class FloorPlanAdminController {
  constructor(
    private readonly plan: FloorPlanService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async indexForAdmin(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'floor_plans.admin');
    const tenantId = TenantContext.current().id;
    return this.plan.listForAdmin(tenantId);
  }
}
