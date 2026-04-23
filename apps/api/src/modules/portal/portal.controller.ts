import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PortalService } from './portal.service';
import { PortalSubmitService } from './portal-submit.service';
import { PortalSubmitDto } from './portal-submit.types';

@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly submit: PortalSubmitService,
  ) {}

  private authUid(request: Request): string {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    return authUid;
  }

  @Get('me')
  async getMe(@Req() request: Request) {
    return this.portal.getMe(this.authUid(request));
  }

  @Patch('me')
  async patchMe(
    @Req() request: Request,
    @Body() body: { current_location_id: string },
  ) {
    if (!body?.current_location_id) {
      throw new BadRequestException('current_location_id is required');
    }
    return this.portal.setCurrentLocation(this.authUid(request), body.current_location_id);
  }

  @Get('catalog')
  async getCatalog(
    @Req() request: Request,
    @Query('location_id') locationId?: string,
  ) {
    if (!locationId) {
      throw new BadRequestException('location_id is required');
    }
    return this.portal.getCatalog(this.authUid(request), locationId);
  }

  @Get('spaces')
  async getSpaces(
    @Req() request: Request,
    @Query('under') under?: string,
  ) {
    if (!under) {
      throw new BadRequestException('under (space_id) is required');
    }
    return this.portal.getSpaces(this.authUid(request), under);
  }

  @Get('me/onboard-locations')
  async onboardLocations(@Req() request: Request) {
    return this.portal.getOnboardableLocations(this.authUid(request));
  }

  @Post('me/claim-default-location')
  async claimDefaultLocation(
    @Req() request: Request,
    @Body() body: { space_id: string },
  ) {
    if (!body?.space_id) {
      throw new BadRequestException('space_id is required');
    }
    return this.portal.claimDefaultLocation(this.authUid(request), body.space_id);
  }

  @Post('tickets')
  async submitTicket(@Req() request: Request, @Body() dto: PortalSubmitDto) {
    return this.submit.submit(this.authUid(request), dto);
  }
}
