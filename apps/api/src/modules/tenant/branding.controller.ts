import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import {
  BrandingService,
  LogoKind,
  UpdateBrandingDto,
} from './branding.service';

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
  @UseGuards(AuthGuard, AdminGuard)
  async updateBranding(@Body() dto: UpdateBrandingDto) {
    return this.branding.update(dto);
  }

  @Post('branding/logo')
  @UseGuards(AuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadLogo(
    @Body('kind') kind: LogoKind,
    @UploadedFile()
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('Missing file');
    if (!VALID_KINDS.includes(kind)) {
      throw new BadRequestException('kind must be light, dark, or favicon');
    }
    return this.branding.uploadLogo(kind, file);
  }

  @Delete('branding/logo/:kind')
  @UseGuards(AuthGuard, AdminGuard)
  async deleteLogo(@Param('kind') kind: LogoKind) {
    if (!VALID_KINDS.includes(kind)) {
      throw new BadRequestException('kind must be light, dark, or favicon');
    }
    return this.branding.removeLogo(kind);
  }
}
