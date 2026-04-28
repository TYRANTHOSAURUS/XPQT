import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { TenantContext } from '../../common/tenant-context';
import { DailyListFollowupService } from './daily-list-followup.service';

/**
 * Desk-side post-cutoff change workflow controller. Backs the "Today's
 * late changes" widget on /desk home (spec §10) and the per-line
 * confirm-phoned button.
 *
 * Auth: `tickets.read` for read endpoints (the desk dashboard surface
 * is gated by the same role any desk operator already has). Confirm
 * action requires `tickets.create` since it mutates an order line —
 * matches the existing booking-edit gating.
 *
 * The DB trigger in 00178 owns the flag-flipping side; this surface
 * only reads + clears.
 */
@Controller('desk')
export class DailyListFollowupController {
  constructor(
    private readonly followup: DailyListFollowupService,
    private readonly permissions: PermissionGuard,
  ) {}

  /**
   * GET /desk/post-cutoff-changes
   *
   * Returns vendor-grouped post-cutoff change events that need phone
   * follow-up. Empty array when nothing pending — UI hides the widget.
   */
  @Get('post-cutoff-changes')
  async list(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'tickets.read');
    const tenantId = TenantContext.current().id;
    return this.followup.listPostCutoffChanges(tenantId);
  }

  /**
   * POST /desk/order-lines/:lineId/confirm-phoned
   *
   * Stamps the line as phoned-through. Idempotent on already-confirmed
   * rows. The DB trigger re-flags on subsequent edits, so a fresh edit
   * reopens the loop.
   */
  @Post('order-lines/:lineId/confirm-phoned')
  async confirm(
    @Req() req: Request,
    @Param('lineId') lineId: string,
    @Body() _body: Record<string, unknown> = {},
  ) {
    const { userId } = await this.permissions.requirePermission(req, 'tickets.create');
    const tenantId = TenantContext.current().id;
    return this.followup.confirmPhoned({ tenantId, lineId, userId });
  }
}
