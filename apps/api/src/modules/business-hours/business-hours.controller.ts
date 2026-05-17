import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { BusinessHoursService, CreateBusinessHoursDto } from './business-hours.service';
import { RequirePermission } from '../../common/require-permission.decorator';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// Business hours are tenant-wide operating schedules; mutations are
// admin-only. GETs stay open (read by booking/SLA logic).
@Controller('business-hours')
export class BusinessHoursController {
  constructor(private readonly service: BusinessHoursService) {}

  @Get()
  async list() {
    return this.service.list();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Post()
  @RequirePermission('business_hours.create')
  async create(@Body() dto: CreateBusinessHoursDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('business_hours.update')
  async update(@Param('id') id: string, @Body() dto: Partial<CreateBusinessHoursDto>) {
    return this.service.update(id, dto);
  }
}
