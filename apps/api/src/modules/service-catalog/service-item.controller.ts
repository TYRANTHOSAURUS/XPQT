import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CreateServiceItemDto,
  OfferingDto,
  ServiceItemService,
  UpdateServiceItemDto,
} from './service-item.service';
import { PermissionGuard } from '../../common/permission-guard';

@Controller('admin/service-items')
export class ServiceItemController {
  constructor(
    private readonly service: ServiceItemService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() request: Request) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.list();
  }

  @Get(':id')
  async getById(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.getById(id);
  }

  @Post()
  async create(@Req() request: Request, @Body() dto: CreateServiceItemDto) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateServiceItemDto,
  ) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.remove(id);
  }

  @Put(':id/offerings')
  async putOfferings(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { offerings: OfferingDto[] },
  ) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    if (!body || !Array.isArray(body.offerings)) {
      throw new BadRequestException('offerings array required');
    }
    return this.service.putOfferings(id, body.offerings);
  }

  @Get(':id/coverage-matrix')
  async coverageMatrix(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.getCoverageMatrix(id);
  }

  @Get('by-request-type/:requestTypeId')
  async getByRequestTypeId(@Req() request: Request, @Param('requestTypeId') requestTypeId: string) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    return this.service.getByRequestTypeId(requestTypeId);
  }

  @Put(':id/categories')
  async putCategories(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { category_ids: string[] },
  ) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    if (!body || !Array.isArray(body.category_ids)) {
      throw new BadRequestException('category_ids array required');
    }
    return this.service.putCategories(id, body.category_ids);
  }

  @Put(':id/handler-at')
  async setHandlerAt(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { space_id: string; assignee: { kind: 'team' | 'vendor'; id: string } | null },
  ) {
    await this.permissions.requirePermission(request, 'service_catalog:manage');
    if (!body || !body.space_id) {
      throw new BadRequestException('space_id required');
    }
    return this.service.setHandlerAt(id, body);
  }
}
