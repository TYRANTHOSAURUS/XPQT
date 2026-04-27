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
import {
  BundleTemplatesService,
  type BundleTemplateUpsertDto,
} from './bundle-templates.service';

/**
 * Reads are open: the portal /portal/rooms BundleTemplatePicker (chip row)
 * lists active templates for any authenticated user. Writes require
 * `rooms.admin`.
 */
@Controller('admin/bundle-templates')
export class BundleTemplatesController {
  constructor(
    private readonly service: BundleTemplatesService,
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
  async create(@Req() req: Request, @Body() dto: BundleTemplateUpsertDto) {
    await this.permissions.requirePermission(req, 'rooms.admin');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: Partial<BundleTemplateUpsertDto>,
  ) {
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
