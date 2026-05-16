import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { TeamService } from './team.service';
import { AdminGuard } from '../auth/admin.guard';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// ESCALATION-class: `team_members` is an Operator-tier entry in
// `ticket_visibility_ids` (docs/visibility.md §2a). Without AdminGuard
// any active same-tenant user could POST /teams/:id/members to add
// THEMSELVES to a team and gain operator visibility on that team's
// tickets. Team CRUD also feeds routing. Mutations are admin-only;
// GETs stay open (assignment pickers).
@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  async list() { return this.teamService.list(); }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.teamService.getById(id);
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() dto: {
    name: string;
    domain_scope?: string;
    location_scope?: string;
    org_node_id?: string | null;
  }) {
    return this.teamService.create(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.teamService.update(id, dto);
  }

  @Get(':id/members')
  async listMembers(@Param('id') id: string) {
    return this.teamService.listMembers(id);
  }

  @Post(':id/members')
  @UseGuards(AdminGuard)
  async addMember(@Param('id') id: string, @Body() dto: { user_id: string }) {
    return this.teamService.addMember(id, dto.user_id);
  }

  @Delete(':id/members/:userId')
  @UseGuards(AdminGuard)
  async removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.teamService.removeMember(id, userId);
  }
}
