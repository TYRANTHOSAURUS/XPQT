import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { BusinessHoursService, CreateBusinessHoursDto } from './business-hours.service';

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
  async create(@Body() dto: CreateBusinessHoursDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Partial<CreateBusinessHoursDto>) {
    return this.service.update(id, dto);
  }
}
