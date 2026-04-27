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
import { LegalHoldService } from './legal-hold.service';
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
    private readonly legalHold: LegalHoldService,
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

  // -------------------- erasure requests --------------------

  @Post('persons/:personId/erase')
  async initiateErasure(
    @Req() req: Request,
    @Param('personId', ParseUUIDPipe) personId: string,
    @Body() body: { reason: string; hard_delete?: boolean; fulfill?: boolean },
  ) {
    const { userId } = await this.permission.requirePermission(req, GdprPermission.FulfillRequest);
    const tenant = TenantContext.current();

    const dsr = await this.dataSubject.createErasureRequest({
      tenantId: tenant.id,
      subjectPersonId: personId,
      initiatedByUserId: userId,
      reason: body?.reason,
      hardDelete: body?.hard_delete === true,
    });

    // If denied at intake (e.g. legal hold), return immediately.
    if (dsr.status === 'denied') return { request: dsr };

    if (body?.fulfill !== false) {
      const result = await this.dataSubject.fulfillErasureRequest({
        tenantId: tenant.id,
        requestId: dsr.id,
        actorUserId: userId,
        hardDelete: body?.hard_delete === true,
      });
      return {
        request: result.request,
        breakdown: result.breakdown,
        total_processed: result.totalProcessed,
        status: result.status,
      };
    }

    return { request: dsr };
  }

  // -------------------- legal holds --------------------

  @Get('legal-holds')
  async listHolds(
    @Req() req: Request,
    @Query('include_released') includeReleased?: string,
  ) {
    await this.permission.requirePermission(req, GdprPermission.PlaceLegalHold);
    const tenant = TenantContext.current();
    return this.legalHold.listAll(tenant.id, {
      includeReleased: includeReleased === 'true',
    });
  }

  @Post('legal-holds')
  async placeHold(
    @Req() req: Request,
    @Body() body: {
      hold_type: 'person' | 'category' | 'tenant_wide';
      subject_person_id?: string;
      data_category?: string;
      reason: string;
      expires_at?: string;
    },
  ) {
    const { userId } = await this.permission.requirePermission(req, GdprPermission.PlaceLegalHold);
    if (!body?.hold_type) throw new BadRequestException('hold_type is required');
    if (!body?.reason)    throw new BadRequestException('reason is required');

    const tenant = TenantContext.current();
    return this.legalHold.place({
      tenantId: tenant.id,
      holdType: body.hold_type,
      subjectPersonId: body.subject_person_id,
      dataCategory: body.data_category,
      reason: body.reason,
      initiatedByUserId: userId,
      expiresAt: body.expires_at,
    });
  }

  @Post('legal-holds/:id/release')
  async releaseHold(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason: string },
  ) {
    const { userId } = await this.permission.requirePermission(req, GdprPermission.PlaceLegalHold);
    if (!body?.reason) throw new BadRequestException('reason is required');

    const tenant = TenantContext.current();
    return this.legalHold.release({
      tenantId: tenant.id,
      holdId: id,
      releasedByUserId: userId,
      reason: body.reason,
    });
  }
}
