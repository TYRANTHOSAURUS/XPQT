import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { DelegationService, CreateDelegationDto } from './delegation.service';

@Controller('delegations')
export class DelegationController {
  constructor(private readonly service: DelegationService) {}

  @Get()
  async list() {
    return this.service.list();
  }

  @Post()
  async create(@Body() dto: CreateDelegationDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.service.update(id, dto);
  }
}
