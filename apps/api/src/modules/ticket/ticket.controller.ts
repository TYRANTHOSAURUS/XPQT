import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  TicketService,
  CreateTicketDto,
  UpdateTicketDto,
  AddActivityDto,
} from './ticket.service';

@Controller('tickets')
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  @Get()
  async list(
    @Query('status_category') statusCategory?: string,
    @Query('priority') priority?: string,
    @Query('assigned_team_id') assignedTeamId?: string,
    @Query('assigned_user_id') assignedUserId?: string,
    @Query('location_id') locationId?: string,
    @Query('requester_person_id') requesterPersonId?: string,
    @Query('parent_ticket_id') parentTicketId?: string,
    @Query('sla_at_risk') slaAtRisk?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ticketService.list({
      status_category: statusCategory,
      priority,
      assigned_team_id: assignedTeamId,
      assigned_user_id: assignedUserId,
      location_id: locationId,
      requester_person_id: requesterPersonId,
      parent_ticket_id: parentTicketId === 'null' ? null : parentTicketId,
      sla_at_risk: slaAtRisk === 'true' ? true : undefined,
      search,
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.ticketService.getById(id);
  }

  @Post()
  async create(@Body() dto: CreateTicketDto) {
    return this.ticketService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTicketDto) {
    return this.ticketService.update(id, dto);
  }

  @Patch('bulk/update')
  async bulkUpdate(@Body() body: { ids: string[]; updates: UpdateTicketDto }) {
    return this.ticketService.bulkUpdate(body.ids, body.updates);
  }

  @Get(':id/activities')
  async getActivities(
    @Param('id') id: string,
    @Query('visibility') visibility?: string,
  ) {
    return this.ticketService.getActivities(id, visibility);
  }

  @Post(':id/activities')
  async addActivity(
    @Param('id') id: string,
    @Body() dto: AddActivityDto,
    @Req() request: Request,
  ) {
    return this.ticketService.addActivity(
      id,
      dto,
      this.extractAccessToken(request.headers.authorization),
    );
  }

  @Post(':id/attachments')
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadAttachments(
    @Param('id') id: string,
    @UploadedFiles() files: Array<{
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }>,
  ) {
    if (!files?.length) {
      throw new BadRequestException('No files uploaded');
    }

    return this.ticketService.uploadActivityAttachments(id, files);
  }

  @Get(':id/children')
  async getChildTasks(@Param('id') id: string) {
    return this.ticketService.getChildTasks(id);
  }

  private extractAccessToken(authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return authorization.slice(7);
  }
}
