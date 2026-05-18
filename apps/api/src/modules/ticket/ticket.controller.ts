import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AppErrors } from '../../common/errors';
import { RequireClientRequestIdGuard } from '../../common/guards/require-client-request-id.guard';
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

/** RFC 4122 v1–5, mirrors client-request-id.middleware.ts. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
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
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    return this.ticketService.listDistinctTags(actorAuthUid);
  }

  @Get(':id')
  async getById(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    return this.ticketService.getById(id, actorAuthUid);
  }

  /** B.2.A I1 — producer route, requires X-Client-Request-Id (spec §3.9.1). */
  @Post()
  @UseGuards(RequireClientRequestIdGuard)
  async create(@Req() request: Request, @Body() dto: CreateTicketDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    return this.ticketService.create(dto, {}, actorAuthUid, clientRequestId);
  }

  /** B.2.A I1 — producer route, requires X-Client-Request-Id (spec §3.9.1). */
  @Patch(':id')
  @UseGuards(RequireClientRequestIdGuard)
  async update(@Req() request: Request, @Param('id') id: string, @Body() dto: UpdateTicketDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
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
      throw AppErrors.validationFailed('ticket.tags_invalid', {
        detail: 'tags must be an array of strings or null',
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(dto, 'watchers') &&
      dto.watchers !== null &&
      dto.watchers !== undefined &&
      (!Array.isArray(dto.watchers) || !dto.watchers.every((w) => typeof w === 'string'))
    ) {
      throw AppErrors.validationFailed('ticket.watchers_invalid', {
        detail: 'watchers must be an array of strings (person UUIDs) or null',
      });
    }
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    return this.ticketService.update(id, dto, actorAuthUid, clientRequestId);
  }

  /**
   * B.2.A I1 — producer route, requires X-Client-Request-Id (spec §3.9.1).
   * Audit 02 / P0-1: bulk now routes every id through the hardened
   * single-path `update()` (see TicketService.bulkUpdate); the guard +
   * controller-boundary narrowing match the single `@Patch(':id')` so the
   * bulk surface inherits every B.2.A guarantee. `ids` is validated as a
   * non-empty array of ticket UUIDs (review fix: closes the "raw garbage
   * ids → N loadContext round-trips" amplification the cap didn't cover).
   * HTTP status follows the error-handling spec §3.1 line 88: all ok →
   * 200 · mixed → 207 Multi-Status · all failed → 422; `results[]` body is
   * always present so the (future) FE bulk renderer has a single shape.
   */
  @Patch('bulk/update')
  @UseGuards(RequireClientRequestIdGuard)
  async bulkUpdate(
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { ids: string[]; updates: UpdateTicketDto },
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((i) => typeof i === 'string' && UUID_RE.test(i))
    ) {
      throw AppErrors.validationFailed('reference.invalid_uuid', {
        detail: 'bulk update requires a non-empty array of ticket UUIDs',
      });
    }
    const updates = body?.updates ?? ({} as UpdateTicketDto);
    if (
      Object.prototype.hasOwnProperty.call(updates, 'tags') &&
      updates.tags !== null &&
      updates.tags !== undefined &&
      (!Array.isArray(updates.tags) || !updates.tags.every((t) => typeof t === 'string'))
    ) {
      throw AppErrors.validationFailed('ticket.tags_invalid', {
        detail: 'tags must be an array of strings or null',
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'watchers') &&
      updates.watchers !== null &&
      updates.watchers !== undefined &&
      (!Array.isArray(updates.watchers) ||
        !updates.watchers.every((w) => typeof w === 'string'))
    ) {
      throw AppErrors.validationFailed('ticket.watchers_invalid', {
        detail: 'watchers must be an array of strings (person UUIDs) or null',
      });
    }
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    const result = await this.ticketService.bulkUpdate(
      ids,
      updates,
      actorAuthUid,
      clientRequestId,
    );
    // error-handling spec §3.1 line 88 — HTTP status = worst-case outcome.
    if (result.okCount > 0 && result.errorCount > 0) {
      res.status(207); // Multi-Status — partial success
    } else if (result.okCount === 0 && result.errorCount > 0) {
      res.status(422); // every id failed
    }
    return result;
  }

  /** B.2.A I1 — producer route, requires X-Client-Request-Id (spec §3.9.1). */
  @Post(':id/reassign')
  @UseGuards(RequireClientRequestIdGuard)
  async reassign(@Req() request: Request, @Param('id') id: string, @Body() dto: ReassignDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    return this.ticketService.reassign(id, dto, actorAuthUid, clientRequestId);
  }

  /** B.2.A I1 — producer route, requires X-Client-Request-Id (spec §3.9.1). */
  @Post(':id/dispatch')
  @UseGuards(RequireClientRequestIdGuard)
  async dispatch(@Req() request: Request, @Param('id') id: string, @Body() dto: DispatchDto) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    return this.dispatchService.dispatch(id, dto, actorAuthUid, clientRequestId);
  }

  @Get(':id/activities')
  async getActivities(
    @Req() request: Request,
    @Param('id') id: string,
    @Query('visibility') visibility?: string,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    return this.ticketService.getActivities(id, visibility, actorAuthUid);
  }

  @Post(':id/activities')
  async addActivity(
    @Param('id') id: string,
    @Body() dto: AddActivityDto,
    @Req() request: Request,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
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
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    if (!files?.length) {
      throw AppErrors.validationFailed('ticket.no_files_uploaded', {
        detail: 'No files uploaded',
      });
    }

    return this.ticketService.uploadActivityAttachments(id, files, actorAuthUid);
  }

  @Get(':id/children')
  async children(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    return this.ticketService.getChildTasks(id, actorAuthUid);
  }

  /**
   * Audit-02 P1-5 FE-rollup fix. Privileged aggregate count of a case's
   * child work_orders — parent-`read`-gated (same precondition as
   * `children`), tenant-scoped, returns ONLY `{ done, total }`. It
   * deliberately does NOT apply the per-child `work_order_visibility_ids`
   * filter so the desk progress ring/badge reports the true total even to
   * a scoped operator who can't see every child. No child identities or
   * metadata are exposed. See docs/visibility.md §7.
   */
  @Get(':id/children/rollup')
  async childrenRollup(@Req() request: Request, @Param('id') id: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    return this.ticketService.getChildTasksRollup(id, actorAuthUid);
  }

  @Get(':id/visibility-trace')
  async visibilityTrace(@Req() request: Request, @Param('id') id: string) {
    const tenant = TenantContext.current();
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw AppErrors.unauthorized('No auth user');
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    if (!ctx.has_read_all) {
      throw AppErrors.forbidden(
        'ticket.visibility_trace_forbidden',
        'visibility-trace requires tickets.read_all',
      );
    }
    return this.visibility.trace(id, ctx);
  }

  private extractAccessToken(authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return authorization.slice(7);
  }
}
