// apps/api/src/modules/portal-announcements/portal-announcements.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../../common/require-permission.decorator';
import { PortalAnnouncementsService } from './portal-announcements.service';
import { PublishAnnouncementDto } from './dto';

@Controller('admin/portal-announcements')
export class PortalAnnouncementsController {
  constructor(private readonly service: PortalAnnouncementsService) {}

  @Get()
  @RequirePermission('settings.read')
  async list() {
    return this.service.listAll();
  }

  @Post()
  @RequirePermission('settings.update')
  async publish(@Req() req: Request, @Body() dto: PublishAnnouncementDto) {
    const uid = (req as { user?: { id: string } }).user?.id ?? null;
    return this.service.publish(dto, uid as string);
  }

  @Delete(':id')
  @RequirePermission('settings.update')
  async unpublish(@Param('id') id: string) {
    await this.service.unpublish(id);
    return { ok: true };
  }
}
