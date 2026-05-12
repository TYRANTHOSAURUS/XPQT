import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { MaintenancePlanService } from './maintenance-plan.service';

/**
 * MaintenancePlanController — admin CRUD over public.maintenance_plans.
 *
 * Plan: ai/slice-c-plan.md §5. Every endpoint gated by the granular
 * maintenance_plans.<action> permission (registered in
 * packages/shared/src/permissions.ts; Tenant Admin via *.*, Service Desk
 * Lead via maintenance_plans.*, FM Agent reads via maintenance_plans.read,
 * Auditor reads via *.read).
 *
 * Permission semantics: 403 if the role lacks the action. The
 * not-in-tenant case raises 404 maintenance_plans.not_found (composite-FK
 * scoping + tenant filter — cross-tenant ids are indistinguishable from
 * missing ones per spec §6.1).
 *
 * No X-Client-Request-Id guard — these are admin config writes, not
 * customer-facing producer routes. The idempotency comes from the
 * underlying plan's own state (recompute on update; no command_operations
 * row required).
 */
@Controller('admin/maintenance/plans')
export class MaintenancePlanController {
  constructor(
    private readonly service: MaintenancePlanService,
    private readonly permissionGuard: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.permissionGuard.requirePermission(request, 'maintenance_plans.read');
    return this.service.list(query);
  }

  @Get(':id')
  async findById(@Req() request: Request, @Param('id') id: string) {
    await this.permissionGuard.requirePermission(request, 'maintenance_plans.read');
    return this.service.findById(id);
  }

  @Post()
  async create(@Req() request: Request, @Body() body: unknown) {
    await this.permissionGuard.requirePermission(request, 'maintenance_plans.create');
    const authUid = (request as { user?: { id: string } }).user?.id;
    return this.service.create(body, { authUid });
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.permissionGuard.requirePermission(request, 'maintenance_plans.update');
    const authUid = (request as { user?: { id: string } }).user?.id;
    return this.service.update(id, body, { authUid });
  }

  @Delete(':id')
  async delete(@Req() request: Request, @Param('id') id: string) {
    await this.permissionGuard.requirePermission(request, 'maintenance_plans.delete');
    const result = await this.service.delete(id);
    return { ok: true, mode: result.mode };
  }
}
