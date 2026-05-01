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
  SetPlanDto,
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

  @Patch(':id/plan')
  async setPlan(@Req() request: Request, @Param('id') id: string, @Body() dto: SetPlanDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.setPlan(id, dto, actorAuthUid);
  }

  @Get(':id/can-plan')
  async getCanPlan(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const tenantId = TenantContext.current().id;
    const ctx = await this.visibility.loadContext(actorAuthUid, tenantId);
    try {
      await this.visibility.assertCanPlan(id, ctx);
      return { canPlan: true };
    } catch {
      return { canPlan: false };
    }
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
