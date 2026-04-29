import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import {
  ServiceRoutingService,
  type ServiceRoutingUpsertDto,
} from './service-routing.service';

/**
 * Admin endpoints for the service routing matrix. Backed by
 * `location_service_routing` (00194). Auto-creation flow consumes the
 * matrix via the `resolve_setup_routing` SQL function — these endpoints
 * are admin-side CRUD only.
 *
 * Permission gate: `rooms.admin` for writes (consistent with cost-centers
 * and other routing-config admin surfaces in this module). Reads gated to
 * the same since the matrix isn't needed by portal/portal-order flows.
 */
@Controller('admin/service-routing')
export class ServiceRoutingController {
  constructor(
    private readonly service: ServiceRoutingService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.service.list();
  }

  @Get(':id')
  async findOne(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.service.findOne(id);
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: ServiceRoutingUpsertDto) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({
        code: 'invalid_payload',
        message: 'request body required',
      });
    }
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: Partial<ServiceRoutingUpsertDto>,
  ) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({
        code: 'invalid_payload',
        message: 'request body required',
      });
    }
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.service.remove(id);
  }
}
