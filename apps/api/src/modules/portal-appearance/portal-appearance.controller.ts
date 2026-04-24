// apps/api/src/modules/portal-appearance/portal-appearance.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { PortalAppearanceService } from './portal-appearance.service';
import { UpdatePortalAppearanceDto } from './dto';

@Controller('admin/portal-appearance')
@UseGuards(AuthGuard, AdminGuard)
export class PortalAppearanceController {
  constructor(private readonly service: PortalAppearanceService) {}

  @Get('list')
  async list() {
    return this.service.list();
  }

  @Get()
  async get(@Query('location_id') locationId: string) {
    if (!locationId) throw new BadRequestException('location_id is required');
    return this.service.get(locationId);
  }

  @Patch()
  async update(@Body() dto: UpdatePortalAppearanceDto) {
    return this.service.update(dto);
  }

  @Post('hero')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadHero(
    @Query('location_id') locationId: string,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    return this.service.uploadHero(locationId, file);
  }

  @Delete('hero')
  async removeHero(@Query('location_id') locationId: string) {
    if (!locationId) throw new BadRequestException('location_id is required');
    return this.service.removeHero(locationId);
  }
}
