import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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

interface UpdateWorkOrderStatusDto {
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
}

interface UpdateWorkOrderPriorityDto {
  priority: 'low' | 'medium' | 'high' | 'critical';
}

interface UpdateWorkOrderAssignmentDto {
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
}

interface ReassignWorkOrderDto extends UpdateWorkOrderAssignmentDto {
  reason: string;
  actor_person_id?: string | null;
  rerun_resolver?: boolean;
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

  @Patch(':id/status')
  async updateStatus(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateWorkOrderStatusDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException('body required');
    }
    // Type-narrow each provided field. undefined is "no change"; null is
    // only valid for waiting_reason (clear it).
    if (dto.status !== undefined && typeof dto.status !== 'string') {
      throw new BadRequestException('status must be a string');
    }
    if (dto.status_category !== undefined && typeof dto.status_category !== 'string') {
      throw new BadRequestException('status_category must be a string');
    }
    if (
      dto.waiting_reason !== undefined &&
      dto.waiting_reason !== null &&
      typeof dto.waiting_reason !== 'string'
    ) {
      throw new BadRequestException('waiting_reason must be a string or null');
    }
    return this.workOrderService.updateStatus(id, dto, actorAuthUid);
  }

  @Patch(':id/priority')
  async updatePriority(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateWorkOrderPriorityDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    if (!dto || typeof dto.priority !== 'string') {
      throw new BadRequestException('priority is required (string)');
    }
    return this.workOrderService.updatePriority(id, dto.priority as 'low' | 'medium' | 'high' | 'critical', actorAuthUid);
  }

  @Patch(':id/assignment')
  async updateAssignment(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateWorkOrderAssignmentDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException('body required');
    }
    for (const k of ['assigned_team_id', 'assigned_user_id', 'assigned_vendor_id'] as const) {
      const v = dto[k];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        throw new BadRequestException(`${k} must be a string or null`);
      }
    }
    return this.workOrderService.updateAssignment(id, dto, actorAuthUid);
  }

  @Post(':id/reassign')
  async reassign(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: ReassignWorkOrderDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException('body required');
    }
    if (typeof dto.reason !== 'string' || !dto.reason.trim()) {
      throw new BadRequestException('reason is required (non-empty string)');
    }
    for (const k of ['assigned_team_id', 'assigned_user_id', 'assigned_vendor_id'] as const) {
      const v = dto[k];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        throw new BadRequestException(`${k} must be a string or null`);
      }
    }
    return this.workOrderService.reassign(id, dto, actorAuthUid);
  }
}
