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
import { WorkOrderService, type UpdateWorkOrderDto } from './work-order.service';

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

const ASSIGNMENT_FIELDS = ['assigned_team_id', 'assigned_user_id', 'assigned_vendor_id'] as const;
const PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Work-order command surface. Lives at `/work-orders/*` and is intentionally
 * separate from `/tickets/*` (which is case-only post-1c.10c).
 *
 * Plan-reviewer P1: the previous Slice 2 shape — five per-field PATCH
 * endpoints (`/sla`, `/plan`, `/status`, `/priority`, `/assignment`) — has
 * been collapsed into a single `PATCH /work-orders/:id` accepting a union
 * DTO. Per-field gates dispatch server-side inside `WorkOrderService.update`
 * (which delegates to the existing per-field service methods so the side
 * effects are reused). The non-PATCH routes (`GET /:id/can-plan`,
 * `POST /:id/reassign`) stay separate because they are not field-level
 * mutations.
 */
@Controller('work-orders')
export class WorkOrderController {
  constructor(private readonly workOrderService: WorkOrderService) {}

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: UpdateWorkOrderDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException('body required');
    }

    // Type-narrowing per-field — the orchestrator delegates the empty-DTO
    // check, but the controller stays the type-correctness gate so bad
    // input never makes it to the service layer.
    if (
      Object.prototype.hasOwnProperty.call(dto, 'sla_id') &&
      dto.sla_id !== null &&
      typeof dto.sla_id !== 'string'
    ) {
      throw new BadRequestException('sla_id must be a string or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'planned_start_at') &&
      dto.planned_start_at !== null &&
      typeof dto.planned_start_at !== 'string'
    ) {
      throw new BadRequestException('planned_start_at must be a string or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'planned_duration_minutes') &&
      dto.planned_duration_minutes !== null &&
      typeof dto.planned_duration_minutes !== 'number'
    ) {
      throw new BadRequestException('planned_duration_minutes must be a number or null');
    }
    if (dto.status !== undefined && typeof dto.status !== 'string') {
      throw new BadRequestException('status must be a string');
    }
    if (dto.status_category !== undefined && typeof dto.status_category !== 'string') {
      throw new BadRequestException('status_category must be a string');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'waiting_reason') &&
      dto.waiting_reason !== null &&
      typeof dto.waiting_reason !== 'string'
    ) {
      throw new BadRequestException('waiting_reason must be a string or null');
    }
    if (dto.priority !== undefined && !PRIORITY_VALUES.includes(dto.priority)) {
      throw new BadRequestException(
        `priority must be one of: ${PRIORITY_VALUES.join(', ')}`,
      );
    }
    for (const k of ASSIGNMENT_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(dto, k) &&
        dto[k] !== null &&
        typeof dto[k] !== 'string'
      ) {
        throw new BadRequestException(`${k} must be a string or null`);
      }
    }
    // Slice 3.1 fields
    if (dto.title !== undefined && typeof dto.title !== 'string') {
      throw new BadRequestException('title must be a string');
    }
    if (dto.title !== undefined && dto.title.trim() === '') {
      throw new BadRequestException('title must be a non-empty string');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'description') &&
      dto.description !== null &&
      typeof dto.description !== 'string'
    ) {
      throw new BadRequestException('description must be a string or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'cost') &&
      dto.cost !== null &&
      (typeof dto.cost !== 'number' || !Number.isFinite(dto.cost))
    ) {
      throw new BadRequestException('cost must be a finite number or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'tags') &&
      dto.tags !== null &&
      (!Array.isArray(dto.tags) || !dto.tags.every((t) => typeof t === 'string'))
    ) {
      throw new BadRequestException('tags must be an array of strings or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'watchers') &&
      dto.watchers !== null &&
      (!Array.isArray(dto.watchers) || !dto.watchers.every((w) => typeof w === 'string'))
    ) {
      throw new BadRequestException(
        'watchers must be an array of strings (person UUIDs) or null',
      );
    }

    return this.workOrderService.update(id, dto, actorAuthUid);
  }

  @Get(':id/can-plan')
  async getCanPlan(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.workOrderService.canPlan(id, actorAuthUid);
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
    for (const k of ASSIGNMENT_FIELDS) {
      const v = dto[k];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        throw new BadRequestException(`${k} must be a string or null`);
      }
    }
    return this.workOrderService.reassign(id, dto, actorAuthUid);
  }
}
