// apps/api/src/modules/portal-announcements/portal-announcements.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { PortalAnnouncementsService } from './portal-announcements.service';
import { PublishAnnouncementDto } from './dto';

@Controller('admin/portal-announcements')
@UseGuards(AuthGuard, AdminGuard)
export class PortalAnnouncementsController {
  constructor(private readonly service: PortalAnnouncementsService) {}

  @Get()
  async list() {
    return this.service.listAll();
  }

  @Post()
  async publish(@Req() req: Request, @Body() dto: PublishAnnouncementDto) {
    const uid = (req as { user?: { id: string } }).user?.id ?? null;
    return this.service.publish(dto, uid as string);
  }

  @Delete(':id')
  async unpublish(@Param('id') id: string) {
    await this.service.unpublish(id);
    return { ok: true };
  }
}
