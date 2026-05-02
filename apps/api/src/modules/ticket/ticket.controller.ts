import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
  UnauthorizedException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import {
  TicketService,
  CreateTicketDto,
  UpdateTicketDto,
  AddActivityDto,
  ReassignDto,
} from './ticket.service';
import { DispatchService, DispatchDto } from './dispatch.service';
import { TicketVisibilityService } from './ticket-visibility.service';
import { TenantContext } from '../../common/tenant-context';

@Controller('tickets')
export class TicketController {
  constructor(
    private readonly ticketService: TicketService,
    private readonly dispatchService: DispatchService,
    private readonly visibility: TicketVisibilityService,
  ) {}

  @Get('inbox')
  async getInbox(
    @Req() request: Request,
    @Query('limit') limit?: string,
  ) {
    return this.ticketService.getInbox(
      this.extractAccessToken(request.headers.authorization),
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  /**
   * Count + urgency for the desk-shell rail badge on Inbox. Cheap call —
   * see TicketService.getInboxCount.
   */
  @Get('inbox/count')
  async getInboxCount(@Req() request: Request) {
    return this.ticketService.getInboxCount(
      this.extractAccessToken(request.headers.authorization),
    );
  }

  @Get()
  async list(
    @Req() request: Request,
    @Query('status_category') statusCategory?: string | string[],
    @Query('priority') priority?: string | string[],
    @Query('kind') ticketKind?: 'case' | 'work_order',
    @Query('assigned_team_id') assignedTeamId?: string,
    @Query('assigned_user_id') assignedUserId?: string,
    @Query('assigned_vendor_id') assignedVendorId?: string,
    @Query('location_id') locationId?: string,
    @Query('requester_person_id') requesterPersonId?: string,
    @Query('parent_ticket_id') parentTicketId?: string,
    @Query('sla_at_risk') slaAtRisk?: string,
    @Query('sla_breached') slaBreached?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const nullable = (v?: string): string | null | undefined =>
      v === undefined ? undefined : v === 'null' ? null : v;
    return this.ticketService.list({
      status_category: statusCategory,
      priority,
      ticket_kind: ticketKind,
      assigned_team_id: nullable(assignedTeamId),
      assigned_user_id: nullable(assignedUserId),
      assigned_vendor_id: nullable(assignedVendorId),
      location_id: locationId,
      requester_person_id: requesterPersonId,
      parent_ticket_id: parentTicketId === 'null' ? null : parentTicketId,
      sla_at_risk: slaAtRisk === 'true' ? true : undefined,
      sla_breached: slaBreached === 'true' ? true : undefined,
      search,
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    }, actorAuthUid);
  }

  @Get('tags')
  async listTags(@Req() request: Request) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.listDistinctTags(actorAuthUid);
  }

  @Get(':id')
  async getById(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.getById(id, actorAuthUid);
  }

  @Post()
  async create(@Req() request: Request, @Body() dto: CreateTicketDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.create(dto, {}, actorAuthUid);
  }

  @Patch(':id')
  async update(@Req() request: Request, @Param('id') id: string, @Body() dto: UpdateTicketDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    // Type-narrow array fields at the controller boundary (mirrors the WO
    // controller). The service helper does its own pre-flight validation,
    // but rejecting here means a malformed body never reaches the visibility
    // load + diff loop. tags + watchers are the array fields on the case
    // surface today.
    if (
      Object.prototype.hasOwnProperty.call(dto, 'tags') &&
      dto.tags !== null &&
      dto.tags !== undefined &&
      (!Array.isArray(dto.tags) || !dto.tags.every((t) => typeof t === 'string'))
    ) {
      throw new BadRequestException('tags must be an array of strings or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'watchers') &&
      dto.watchers !== null &&
      dto.watchers !== undefined &&
      (!Array.isArray(dto.watchers) || !dto.watchers.every((w) => typeof w === 'string'))
    ) {
      throw new BadRequestException(
        'watchers must be an array of strings (person UUIDs) or null',
      );
    }
    return this.ticketService.update(id, dto, actorAuthUid);
  }

  @Patch('bulk/update')
  async bulkUpdate(
    @Req() request: Request,
    @Body() body: { ids: string[]; updates: UpdateTicketDto },
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.bulkUpdate(body.ids, body.updates, actorAuthUid);
  }

  @Post(':id/reassign')
  async reassign(@Req() request: Request, @Param('id') id: string, @Body() dto: ReassignDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.reassign(id, dto, actorAuthUid);
  }

  @Post(':id/dispatch')
  async dispatch(@Req() request: Request, @Param('id') id: string, @Body() dto: DispatchDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.dispatchService.dispatch(id, dto, actorAuthUid);
  }

  @Get(':id/activities')
  async getActivities(
    @Req() request: Request,
    @Param('id') id: string,
    @Query('visibility') visibility?: string,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.getActivities(id, visibility, actorAuthUid);
  }

  @Post(':id/activities')
  async addActivity(
    @Param('id') id: string,
    @Body() dto: AddActivityDto,
    @Req() request: Request,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.addActivity(
      id,
      dto,
      this.extractAccessToken(request.headers.authorization),
      actorAuthUid,
    );
  }

  @Post(':id/attachments')
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadAttachments(
    @Req() request: Request,
    @Param('id') id: string,
    @UploadedFiles() files: Array<{
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }>,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    if (!files?.length) {
      throw new BadRequestException('No files uploaded');
    }

    return this.ticketService.uploadActivityAttachments(id, files, actorAuthUid);
  }

  @Get(':id/children')
  async children(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.getChildTasks(id, actorAuthUid);
  }

  @Get(':id/visibility-trace')
  async visibilityTrace(@Req() request: Request, @Param('id') id: string) {
    const tenant = TenantContext.current();
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    if (!ctx.has_read_all) {
      throw new ForbiddenException('visibility-trace requires tickets.read_all');
    }
    return this.visibility.trace(id, ctx);
  }

  private extractAccessToken(authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return authorization.slice(7);
  }
}
