import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { DelegationService, CreateDelegationDto } from './delegation.service';
import { AdminGuard } from '../auth/admin.guard';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// `create` takes no actor — without AdminGuard any active same-tenant
// user could mint a delegation granting authority between arbitrary
// users. Mutations are admin-only; GET stays open (operational).
@Controller('delegations')
export class DelegationController {
  constructor(private readonly service: DelegationService) {}

  @Get()
  async list() {
    return this.service.list();
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateDelegationDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.service.update(id, dto);
  }
}
