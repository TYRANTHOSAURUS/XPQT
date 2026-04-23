import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CriteriaSetInput, CriteriaSetService } from './criteria-set.service';
import { PermissionGuard } from '../../common/permission-guard';

/**
 * criteria_sets admin CRUD. Guarded by `criteria_sets:manage` (seeded on
 * the admin role in migration 00067; not retired in Phase E because
 * request_type_audience_rules / form_variants / on_behalf_rules still
 * reference criteria_sets).
 */
@Controller('criteria-sets')
export class CriteriaSetController {
  constructor(
    private readonly service: CriteriaSetService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() request: Request) {
    await this.permissions.requirePermission(request, 'criteria_sets:manage');
    return this.service.list();
  }

  @Get(':id')
  async getById(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'criteria_sets:manage');
    return this.service.getById(id);
  }

  @Post()
  async create(@Req() request: Request, @Body() dto: CriteriaSetInput) {
    await this.permissions.requirePermission(request, 'criteria_sets:manage');
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Partial<CriteriaSetInput>,
  ) {
    await this.permissions.requirePermission(request, 'criteria_sets:manage');
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'criteria_sets:manage');
    return this.service.remove(id);
  }

  @Post('preview')
  async preview(
    @Req() request: Request,
    @Body() dto: { expression: unknown },
  ) {
    await this.permissions.requirePermission(request, 'criteria_sets:manage');
    return this.service.preview(dto?.expression);
  }
}
