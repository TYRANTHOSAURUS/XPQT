import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermission } from '../../common/require-permission.decorator';
import {
  BrandingService,
  LogoKind,
  UpdateBrandingDto,
} from './branding.service';
import { AppErrors } from '../../common/errors';

const VALID_KINDS: LogoKind[] = ['light', 'dark', 'favicon'];

@Controller('tenants')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  // Public — called pre-auth by the login page
  @Get('current/branding')
  async getBranding() {
    return this.branding.get();
  }

  @Put('branding')
  @RequirePermission('settings.update')
  async updateBranding(@Body() dto: UpdateBrandingDto) {
    return this.branding.update(dto);
  }

  @Post('branding/logo')
  @RequirePermission('settings.update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadLogo(
    @Body('kind') kind: LogoKind,
    @UploadedFile()
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!file) throw AppErrors.validationFailed('tenant.file_required', { detail: 'Missing file' });
    if (!VALID_KINDS.includes(kind)) {
      throw AppErrors.validationFailed('tenant.invalid_image_kind', {
        detail: 'kind must be light, dark, or favicon',
      });
    }
    return this.branding.uploadLogo(kind, file);
  }

  @Delete('branding/logo/:kind')
  @RequirePermission('settings.update')
  async deleteLogo(@Param('kind') kind: LogoKind) {
    if (!VALID_KINDS.includes(kind)) {
      throw AppErrors.validationFailed('tenant.invalid_image_kind', {
        detail: 'kind must be light, dark, or favicon',
      });
    }
    return this.branding.removeLogo(kind);
  }
}
