import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CriteriaSetInput, CriteriaSetService } from './criteria-set.service';
import { PermissionGuard } from '../../common/permission-guard';

/**
 * criteria_sets admin CRUD. Per-action permissions from the new catalog
 * (`criteria_sets.read`, `.create`, `.update`, `.delete`). Roles that held
 * legacy `criteria_sets:manage` were remapped to `criteria_sets.*` in
 * migration 00110.
 */
@Controller('criteria-sets')
export class CriteriaSetController {
  constructor(
    private readonly service: CriteriaSetService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() request: Request) {
    await this.permissions.requirePermission(request, 'criteria_sets.read');
    return this.service.list();
  }

  @Get(':id')
  async getById(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'criteria_sets.read');
    return this.service.getById(id);
  }

  @Post()
  async create(@Req() request: Request, @Body() dto: CriteriaSetInput) {
    await this.permissions.requirePermission(request, 'criteria_sets.create');
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Partial<CriteriaSetInput>,
  ) {
    await this.permissions.requirePermission(request, 'criteria_sets.update');
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'criteria_sets.delete');
    return this.service.remove(id);
  }

  @Post('preview')
  async preview(
    @Req() request: Request,
    @Body() dto: { expression: unknown; limit?: number },
  ) {
    await this.permissions.requirePermission(request, 'criteria_sets.read');
    return this.service.preview(dto?.expression, dto?.limit);
  }

  @Get(':id/matches')
  async matches(
    @Req() request: Request,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    await this.permissions.requirePermission(request, 'criteria_sets.read');
    const parsed = limit ? Number(limit) : undefined;
    return this.service.getMatches(id, Number.isFinite(parsed) ? parsed : undefined);
  }
}
