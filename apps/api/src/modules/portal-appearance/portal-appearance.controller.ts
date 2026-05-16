// apps/api/src/modules/portal-appearance/portal-appearance.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermission } from '../../common/require-permission.decorator';
import { PortalAppearanceService } from './portal-appearance.service';
import { UpdatePortalAppearanceDto } from './dto';
import { AppErrors } from '../../common/errors';

@Controller('admin/portal-appearance')
export class PortalAppearanceController {
  constructor(private readonly service: PortalAppearanceService) {}

  @Get('list')
  @RequirePermission('settings.read')
  async list() {
    return this.service.list();
  }

  @Get()
  @RequirePermission('settings.read')
  async get(@Query('location_id') locationId: string) {
    if (!locationId) throw AppErrors.validationFailed('portal_appearance.location_required', { detail: 'location_id is required' });
    return this.service.get(locationId);
  }

  @Patch()
  @RequirePermission('settings.update')
  async update(@Body() dto: UpdatePortalAppearanceDto) {
    return this.service.update(dto);
  }

  @Post('hero')
  @RequirePermission('settings.update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadHero(
    @Query('location_id') locationId: string,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!locationId) throw AppErrors.validationFailed('portal_appearance.location_required', { detail: 'location_id is required' });
    if (!file) throw AppErrors.validationFailed('portal_appearance.file_required', { detail: 'file is required' });
    return this.service.uploadHero(locationId, file);
  }

  @Delete('hero')
  @RequirePermission('settings.update')
  async removeHero(@Query('location_id') locationId: string) {
    if (!locationId) throw AppErrors.validationFailed('portal_appearance.location_required', { detail: 'location_id is required' });
    return this.service.removeHero(locationId);
  }
}
