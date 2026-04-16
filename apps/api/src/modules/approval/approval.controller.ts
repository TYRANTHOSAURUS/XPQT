import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApprovalService, CreateApprovalDto, RespondDto } from './approval.service';

@Controller('approvals')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  @Get('pending/:personId')
  async getPending(@Param('personId') personId: string) {
    return this.approvalService.getPendingForPerson(personId);
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
    @Param('id') id: string,
    @Body() dto: RespondDto & { responding_person_id: string },
  ) {
    return this.approvalService.respond(id, dto, dto.responding_person_id);
  }

  @Get('chain/:chainId/complete')
  async isChainComplete(@Param('chainId') chainId: string) {
    const complete = await this.approvalService.isChainComplete(chainId);
    return { complete };
  }
}
