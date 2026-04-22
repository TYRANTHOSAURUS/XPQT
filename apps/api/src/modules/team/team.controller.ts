import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { TeamService } from './team.service';

@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  async list() { return this.teamService.list(); }

  @Post()
  async create(@Body() dto: {
    name: string;
    domain_scope?: string;
    location_scope?: string;
    org_node_id?: string | null;
  }) {
    return this.teamService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.teamService.update(id, dto);
  }

  @Get(':id/members')
  async listMembers(@Param('id') id: string) {
    return this.teamService.listMembers(id);
  }

  @Post(':id/members')
  async addMember(@Param('id') id: string, @Body() dto: { user_id: string }) {
    return this.teamService.addMember(id, dto.user_id);
  }

  @Delete(':id/members/:userId')
  async removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.teamService.removeMember(id, userId);
  }
}
