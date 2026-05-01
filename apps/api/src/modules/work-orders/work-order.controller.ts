import {
  BadRequestException,
  Body,
  Controller,
  Get,
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

interface SetWorkOrderPlanDto {
  planned_start_at: string | null;
  planned_duration_minutes?: number | null;
}

/**
 * Work-order command surface. Lives at `/work-orders/*` and is intentionally
 * separate from `/tickets/*` (which is case-only post-1c.10c).
 *
 * Today this controller exposes the SLA + plandate routes; further work-order
 * commands (status, priority, assignment) accumulate here. DO NOT add new
 * commands to TicketService — they belong on this controller.
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

  @Patch(':id/plan')
  async setPlan(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: SetWorkOrderPlanDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');

    // The body must spell out planned_start_at. Like SLA, undefined is not
    // an implicit no-op here — this endpoint exists to set the plan, so a
    // missing field is malformed input. Duration is optional (omitted means
    // "no duration" / clear duration).
    if (!Object.prototype.hasOwnProperty.call(dto ?? {}, 'planned_start_at')) {
      throw new BadRequestException(
        'planned_start_at is required (ISO 8601 string or null)',
      );
    }
    const start = dto.planned_start_at;
    if (start !== null && typeof start !== 'string') {
      throw new BadRequestException('planned_start_at must be a string or null');
    }
    const rawDuration = dto.planned_duration_minutes;
    if (
      rawDuration !== undefined &&
      rawDuration !== null &&
      typeof rawDuration !== 'number'
    ) {
      throw new BadRequestException(
        'planned_duration_minutes must be a number or null',
      );
    }
    const duration = rawDuration === undefined ? null : rawDuration;

    return this.workOrderService.setPlan(id, start, duration, actorAuthUid);
  }

  @Get(':id/can-plan')
  async getCanPlan(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.workOrderService.canPlan(id, actorAuthUid);
  }
}
