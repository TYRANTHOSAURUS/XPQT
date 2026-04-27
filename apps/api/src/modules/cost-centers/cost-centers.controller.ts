import {
  BadRequestException,
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
import { CostCentersService, type CostCenterUpsertDto } from './cost-centers.service';

/**
 * Reads are intentionally NOT gated: the portal `/portal/order` flow
 * needs the active-cost-center list to render its Select. Cost centers
 * carry codes + names + a default approver — non-sensitive lookup data
 * scoped per tenant by RLS.
 *
 * Writes (create/update/delete) require `rooms.admin`.
 */
@Controller('admin/cost-centers')
export class CostCentersController {
  constructor(
    private readonly service: CostCentersService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Query('active') active?: string) {
    const filter =
      active === 'true' ? { active: true } : active === 'false' ? { active: false } : undefined;
    return this.service.list(filter);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CostCenterUpsertDto) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: Partial<CostCenterUpsertDto>) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    return this.service.remove(id);
  }
}
