import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { PermissionGuard } from '../../common/permission-guard';
import { TenantContext } from '../../common/tenant-context';
import { FloorPlanService } from './floor-plan.service';
import { FloorPlanDraftService } from './floor-plan-draft.service';

/**
 * Per-floor endpoints: `/floors/:floorSpaceId/plan`
 *
 * Auth: global `AuthGuard` (via APP_GUARD in app.module.ts) — no explicit guard needed.
 * Admin actions additionally require `floor_plans.admin` permission, enforced via
 * `this.permissions.requirePermission`.
 */
@Controller('floors/:floorSpaceId/plan')
export class FloorPlanController {
  constructor(
    private readonly plan: FloorPlanService,
    private readonly draft: FloorPlanDraftService,
    private readonly permissions: PermissionGuard,
  ) {}

  /** GET /floors/:floorSpaceId/plan — public read, no admin permission required. */
  @Public()
  @Get()
  async getPublished(@Param('floorSpaceId') id: string) {
    const tenantId = TenantContext.current().id;
    return this.plan.getPublished(id, tenantId);
  }

  /** GET /floors/:floorSpaceId/plan/draft — creates on first call if none exists. */
  @Get('draft')
  async getDraft(@Param('floorSpaceId') id: string, @Req() req: Request) {
    const { userId } = await this.permissions.requirePermission(req, 'floor_plans.admin');
    const tenantId = TenantContext.current().id;
    return this.draft.getOrCreate(id, userId, tenantId);
  }

  /**
   * PATCH /floors/:floorSpaceId/plan/draft
   * Accepts `If-Match: <updated_at>` for optimistic locking. Returns 409 on stale.
   */
  @Patch('draft')
  async updateDraft(
    @Param('floorSpaceId') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.permissions.requirePermission(req, 'floor_plans.admin');
    const tenantId = TenantContext.current().id;
    return this.draft.update(id, tenantId, ifMatch, body);
  }

  /** DELETE /floors/:floorSpaceId/plan/draft — discards the in-progress draft. */
  @Delete('draft')
  async discardDraft(@Param('floorSpaceId') id: string, @Req() req: Request) {
    await this.permissions.requirePermission(req, 'floor_plans.admin');
    const tenantId = TenantContext.current().id;
    await this.draft.discard(id, tenantId);
    return { ok: true };
  }

  /** POST /floors/:floorSpaceId/plan/draft/publish — atomically publishes the draft via RPC. */
  @Post('draft/publish')
  async publish(@Param('floorSpaceId') id: string, @Req() req: Request) {
    await this.permissions.requirePermission(req, 'floor_plans.admin');
    const tenantId = TenantContext.current().id;
    return this.plan.publish(id, tenantId);
  }

  /** GET /floors/:floorSpaceId/plan/history — last 20 published snapshots. */
  @Get('history')
  async history(@Param('floorSpaceId') id: string, @Req() req: Request) {
    await this.permissions.requirePermission(req, 'floor_plans.admin');
    const tenantId = TenantContext.current().id;
    return this.plan.listPublishHistory(id, tenantId);
  }
}
