import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Patch,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { WorkOrderService } from './work-order.service';

interface UpdateWorkOrderSlaDto {
  sla_id: string | null;
}

/**
 * Work-order command surface. Lives at `/work-orders/*` and is intentionally
 * separate from `/tickets/*` (which is case-only post-1c.10c).
 *
 * Today this controller exposes a single route — `PATCH /work-orders/:id/sla`
 * — as the scaffolding for further work-order commands (status, plan,
 * priority, assignment). DO NOT add new commands to TicketService — they
 * accumulate here.
 */
@Controller('work-orders')
export class WorkOrderController {
  constructor(private readonly workOrderService: WorkOrderService) {}

  @Patch(':id/sla')
  async updateSla(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateWorkOrderSlaDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');

    // The body must spell out `sla_id`. `undefined` is not "no change" here;
    // PATCH /sla is the dedicated endpoint for changing SLA, so leaving it
    // off is a malformed request, not an implicit no-op.
    if (!Object.prototype.hasOwnProperty.call(dto ?? {}, 'sla_id')) {
      throw new BadRequestException('sla_id is required (string or null)');
    }
    const slaId = dto.sla_id;
    if (slaId !== null && typeof slaId !== 'string') {
      throw new BadRequestException('sla_id must be a string or null');
    }

    return this.workOrderService.updateSla(id, slaId, actorAuthUid);
  }
}
