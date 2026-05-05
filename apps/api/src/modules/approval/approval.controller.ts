import { Controller, Get, Post, Param, Body, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { ApprovalService, CreateApprovalDto, RespondDto } from './approval.service';

@Controller('approvals')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  /**
   * Count + urgency for the desk-shell rail badge on Approvals. Auth-derived
   * (no `:personId` param) so the rail badge doesn't have to know the
   * caller's person id. Declared BEFORE `@Get('pending/:personId')` so Nest's
   * route table matches `pending/me/count` here rather than treating "me" as
   * a personId.
   */
  @Get('pending/me/count')
  async getMyPendingCount(@Req() request: Request) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const actor = await this.approvalService.resolveActorPerson(actorAuthUid);
    if (!actor) {
      // No linked person → an empty queue rather than 403; the caller is a
      // valid auth user but simply has nothing to approve.
      return { count: 0, hasUrgency: false };
    }
    return this.approvalService.getPendingCountForActor(actor);
  }

  @Get('pending/:personId')
  async getPending(@Req() request: Request, @Param('personId') personId: string) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    // The :personId path param is retained for cache-key continuity on the
    // frontend, but the server only ever lists the caller's own queue. A
    // mismatch is treated as a permission error rather than silently swapped.
    const actor = await this.approvalService.resolveActorPerson(actorAuthUid);
    if (!actor) throw new ForbiddenException('No person record linked to caller');
    if (actor.personId !== personId) {
      throw new ForbiddenException('Cannot read another user\'s pending approvals');
    }
    return this.approvalService.getPendingForActor(actor);
  }

  @Get('entity/:entityType/:entityId')
  async getForEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.approvalService.getForEntity(entityType, entityId);
  }

  @Post()
  async createSingleStep(@Body() dto: CreateApprovalDto) {
    return this.approvalService.createSingleStep(dto);
  }

  @Post('chain')
  async createChain(@Body() dto: {
    target_entity_type: string;
    target_entity_id: string;
    steps: Array<{ approver_person_id?: string; approver_team_id?: string }>;
  }) {
    return this.approvalService.createSequentialChain(dto.target_entity_type, dto.target_entity_id, dto.steps);
  }

  @Post('parallel')
  async createParallelGroup(@Body() dto: {
    target_entity_type: string;
    target_entity_id: string;
    group_name: string;
    approvers: Array<{ approver_person_id?: string; approver_team_id?: string }>;
  }) {
    return this.approvalService.createParallelGroup(dto.target_entity_type, dto.target_entity_id, dto.approvers, dto.group_name);
  }

  @Post(':id/respond')
  async respond(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: RespondDto,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const actor = await this.approvalService.resolveActorPerson(actorAuthUid);
    if (!actor) throw new ForbiddenException('No person record linked to caller');
    // Body's responding_person_id is now ignored — server-derived only.
    // clientRequestId is threaded from ClientRequestIdMiddleware (B.0.D.1)
    // and used by the grant_booking_approval RPC as the idempotency key
    // (spec §3.3 + §10.1).
    const clientRequestId = (request as { clientRequestId?: string }).clientRequestId;
    return this.approvalService.respond(id, dto, actor.personId, actor.userId, clientRequestId);
  }

  @Get('chain/:chainId/complete')
  async isChainComplete(@Param('chainId') chainId: string) {
    const complete = await this.approvalService.isChainComplete(chainId);
    return { complete };
  }
}
