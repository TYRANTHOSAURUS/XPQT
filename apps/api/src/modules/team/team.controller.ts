import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { TeamService } from './team.service';

@Controller('teams')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  async list() { return this.teamService.list(); }

  @Post()
  async create(@Body() dto: { name: string; domain_scope?: string }) {
    return this.teamService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.teamService.update(id, dto);
  }
}
