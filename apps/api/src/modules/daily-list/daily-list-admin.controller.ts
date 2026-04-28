import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { TenantContext } from '../../common/tenant-context';
import { DailyListService, type ServiceType } from './daily-list.service';

/**
 * Admin-side daglijst surface — drives the `/admin/vendors/:id`
 * Fulfillment tab (Sprint 3 spec §9):
 *   - history list (last 30 days)
 *   - preview today's bucket (assemble + render but don't send)
 *   - regenerate now (mint v_n+1 + send)
 *   - send-now (force=true a specific row, e.g. resend after admin
 *     edits the recipient email)
 *   - download (short admin-TTL signed URL — never the 7-day email URL)
 *
 * Permissions:
 *   - read endpoints: `vendors.read`
 *   - write/admin endpoints: `vendors.admin` (matched by `vendors.*` and
 *     `*.*` wildcards via user_has_permission).
 */
@Controller('admin/vendors/:vendorId/daily-list')
export class DailyListAdminController {
  constructor(
    private readonly dailyList: DailyListService,
    private readonly permissions: PermissionGuard,
  ) {}

  /**
   * GET /admin/vendors/:vendorId/daily-list/history
   *
   * Optional `since=YYYY-MM-DD` query for non-default windows. Returns
   * up to 200 rows (vendor_daily_lists.getHistory cap), oldest-first
   * within day, latest-day-first.
   */
  @Get('history')
  async history(
    @Req() req: Request,
    @Param('vendorId') vendorId: string,
    @Query('since') since?: string,
  ) {
    await this.permissions.requirePermission(req, 'vendors.read');
    const tenantId = TenantContext.current().id;
    const rows = await this.dailyList.getHistory({ tenantId, vendorId, since });
    /* Strip payload from list response — admins only need it on the
       preview/detail surface. Keeps the JSON small for tenants with
       a multi-month history. */
    return rows.map(({ payload, ...rest }) => ({
      ...rest,
      total_lines: payload?.total_lines ?? null,
      total_quantity: payload?.total_quantity ?? null,
      building_name: payload?.building?.name ?? null,
    }));
  }

  /**
   * POST /admin/vendors/:vendorId/daily-list/preview
   *
   * Body: { listDate, buildingId?, serviceType }
   *
   * Pure read — assembles the payload that WOULD be in the next
   * version (no DB writes, no PDF render, no send). Use to populate the
   * "Preview today's list" view in the Fulfillment tab. The actual
   * version commit happens via /regenerate.
   */
  @Post('preview')
  async preview(
    @Req() req: Request,
    @Param('vendorId') vendorId: string,
    @Body() body: PreviewBody,
  ) {
    await this.permissions.requirePermission(req, 'vendors.read');
    const tenantId = TenantContext.current().id;
    assertPreviewBody(body);
    return this.dailyList.assemble({
      tenantId,
      vendorId,
      buildingId: body.buildingId ?? null,
      serviceType: body.serviceType,
      listDate: body.listDate,
    });
  }

  /**
   * POST /admin/vendors/:vendorId/daily-list/regenerate
   *
   * Body: { listDate, buildingId?, serviceType }
   *
   * Mint a new version (v_n+1) for the bucket and send it. Used by the
   * "Regenerate v2 now" button. If the bucket is empty (every line
   * cancelled since last cutoff), responds 400 with a `list_cancelled`
   * code so the UI can render the empty-bucket message instead of a
   * generic error.
   */
  @Post('regenerate')
  async regenerate(
    @Req() req: Request,
    @Param('vendorId') vendorId: string,
    @Body() body: PreviewBody,
  ) {
    const { userId } = await this.permissions.requirePermission(req, 'vendors.admin');
    const tenantId = TenantContext.current().id;
    assertPreviewBody(body);
    let row;
    try {
      row = await this.dailyList.generate({
        tenantId,
        vendorId,
        buildingId: body.buildingId ?? null,
        serviceType: body.serviceType,
        listDate: body.listDate,
        triggeredBy: 'admin_manual',
        generatedByUserId: userId,
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === 'ListCancelledError') {
        throw new BadRequestException({
          code: 'list_cancelled',
          message: 'No live lines for this bucket — nothing to regenerate.',
        });
      }
      throw err;
    }
    /* Generated rows start in 'never_sent'. Send immediately so the
       admin doesn't need a second click — same UX as the scheduler's
       generate→send chain. force=false because there's nothing prior. */
    const outcome = await this.dailyList.send({ tenantId, dailyListId: row.id });
    return { row, send: outcome };
  }

  /**
   * POST /admin/vendors/:vendorId/daily-list/:dailyListId/send
   *
   * Body: { force? }
   *
   * Resend an existing daglijst row. force=true is the admin "resend"
   * path used after correcting a vendor's email or when the vendor
   * reports they didn't receive the original. The send() CAS will use
   * `'sent'` as a from-state when force is true, and the correlationId
   * will append a nonce so the mail provider's idempotency cache
   * doesn't dedupe the new request.
   */
  @Post(':dailyListId/send')
  async send(
    @Req() req: Request,
    @Param('dailyListId') dailyListId: string,
    @Body() body: { force?: boolean } = {},
  ) {
    await this.permissions.requirePermission(req, 'vendors.admin');
    const tenantId = TenantContext.current().id;
    return this.dailyList.send({
      tenantId,
      dailyListId,
      force: Boolean(body.force),
    });
  }

  /**
   * GET /admin/vendors/:vendorId/daily-list/:dailyListId/download
   *
   * Mints a SHORT admin-TTL signed URL (~1 hour) — used by the
   * Fulfillment tab's per-row download button. NEVER use the 7-day
   * email TTL here; the admin link is for the operator to view the
   * historical PDF, not to share. Auto-renders the PDF if the row
   * never had one (legacy or sweeper-recovered).
   */
  @Get(':dailyListId/download')
  async download(
    @Req() req: Request,
    @Param('dailyListId') dailyListId: string,
  ) {
    await this.permissions.requirePermission(req, 'vendors.read');
    const tenantId = TenantContext.current().id;
    return this.dailyList.getDownloadUrl({ tenantId, dailyListId, ttl: 'admin' });
  }
}

interface PreviewBody {
  listDate: string;
  buildingId?: string | null;
  serviceType: ServiceType;
}

function assertPreviewBody(body: PreviewBody): void {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Body required');
  }
  if (!body.listDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.listDate)) {
    throw new BadRequestException('listDate must be YYYY-MM-DD');
  }
  if (!body.serviceType) {
    throw new BadRequestException('serviceType required');
  }
}
