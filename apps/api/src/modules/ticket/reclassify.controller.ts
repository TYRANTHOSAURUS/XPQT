import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AppErrors } from '../../common/errors';
import { RequireClientRequestIdGuard } from '../../common/guards/require-client-request-id.guard';
import { ReclassifyService } from './reclassify.service';
import type { ReclassifyPreviewDto, ReclassifyExecuteDto } from './dto/reclassify.dto';

@Controller('tickets/:id/reclassify')
export class ReclassifyController {
  constructor(private readonly service: ReclassifyService) {}

  @Post('preview')
  async preview(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: ReclassifyPreviewDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    return this.service.computeImpact(id, dto.newRequestTypeId, actorAuthUid);
  }

  /** B.2.A I1 — producer route, requires X-Client-Request-Id (spec §3.9.1). */
  @Post()
  @UseGuards(RequireClientRequestIdGuard)
  async execute(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: ReclassifyExecuteDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    return this.service.execute(id, dto, actorAuthUid, clientRequestId);
  }
}
