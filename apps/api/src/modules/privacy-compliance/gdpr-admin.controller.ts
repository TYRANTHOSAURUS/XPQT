import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { TenantContext } from '../../common/tenant-context';
import { DataSubjectService } from './data-subject.service';
import { GdprPermission } from './event-types';
import {
  RetentionService,
  type SetCategorySettingsInput,
} from './retention.service';

/**
 * Admin-only GDPR endpoints. Permission-gated via PermissionGuard.
 *
 * Sprint 3 surface:
 *   GET  /api/admin/gdpr/retention                    — list category settings
 *   PATCH /api/admin/gdpr/retention/:category         — change retention + LIA
 *   POST /api/admin/gdpr/persons/:personId/access     — initiate Art. 15 request
 *   GET  /api/admin/gdpr/requests                     — list DSR rows
 *   GET  /api/admin/gdpr/requests/:id                 — fetch one DSR
 *
 * Sprint 4 will add:
 *   POST /api/admin/gdpr/persons/:personId/erase      — initiate Art. 17 request
 *   POST /api/admin/gdpr/legal-holds                  — place hold
 *   POST /api/admin/gdpr/legal-holds/:id/release      — release hold
 *
 * Spec: gdpr-baseline-design.md §6 + §12.
 */
@Controller('admin/gdpr')
export class GdprAdminController {
  constructor(
    private readonly permission: PermissionGuard,
    private readonly retention: RetentionService,
    private readonly dataSubject: DataSubjectService,
  ) {}

  // -------------------- retention --------------------

  @Get('retention')
  async listRetention(@Req() req: Request) {
    await this.permission.requirePermission(req, GdprPermission.Configure);
    const tenant = TenantContext.current();
    return this.retention.listCategorySettings(tenant.id);
  }

  @Get('retention/:category')
  async getRetention(@Req() req: Request, @Param('category') category: string) {
    await this.permission.requirePermission(req, GdprPermission.Configure);
    const tenant = TenantContext.current();
    return this.retention.getCategorySettings(tenant.id, category);
  }

  @Post('retention/:category')
  async updateRetention(
    @Req() req: Request,
    @Param('category') category: string,
    @Body() body: { retention_days?: number; lia_text?: string | null; reason: string },
  ) {
    const { userId } = await this.permission.requirePermission(req, GdprPermission.Configure);
    if (!body?.reason) throw new BadRequestException('reason is required');

    const tenant = TenantContext.current();
    const patch: SetCategorySettingsInput = {
      retentionDays: body.retention_days,
      liaText: body.lia_text ?? undefined,
    };
    return this.retention.setCategorySettings(tenant.id, category, patch, userId, body.reason);
  }

  // -------------------- access requests --------------------

  @Post('persons/:personId/access')
  async initiateAccess(
    @Req() req: Request,
    @Param('personId', ParseUUIDPipe) personId: string,
    @Body() body: { fulfill?: boolean } = {},
  ) {
    const { userId } = await this.permission.requirePermission(req, GdprPermission.FulfillRequest);
    const tenant = TenantContext.current();

    const dsr = await this.dataSubject.createAccessRequest({
      tenantId: tenant.id,
      subjectPersonId: personId,
      initiatedByUserId: userId,
    });

    // Default: fulfill in the same request. Async fulfilment (queue + worker)
    // will land in Sprint 5 if export sizes warrant; today's data volumes
    // make the inline path fine.
    if (body.fulfill !== false) {
      const result = await this.dataSubject.fulfillAccessRequest({
        tenantId: tenant.id,
        requestId: dsr.id,
        actorUserId: userId,
      });
      return {
        request: result.request,
        download_url: result.signedUrl,
        download_expires_at: result.expiresAt,
        breakdown: result.breakdown,
      };
    }

    return { request: dsr };
  }

  @Get('requests')
  async listRequests(
    @Req() req: Request,
    @Query('subject_person_id') subjectPersonId?: string,
    @Query('status') status?: string,
  ) {
    await this.permission.requirePermission(req, GdprPermission.FulfillRequest);
    const tenant = TenantContext.current();
    return this.dataSubject.listRequests(tenant.id, {
      subjectPersonId: subjectPersonId ?? undefined,
      status: status ?? undefined,
    });
  }

  @Get('requests/:id')
  async getRequest(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    await this.permission.requirePermission(req, GdprPermission.FulfillRequest);
    const tenant = TenantContext.current();
    return this.dataSubject.getRequest(tenant.id, id);
  }
}
