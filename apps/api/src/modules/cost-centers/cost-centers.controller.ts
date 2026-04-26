import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CostCentersService, type CostCenterUpsertDto } from './cost-centers.service';

@Controller('admin/cost-centers')
export class CostCentersController {
  constructor(private readonly service: CostCentersService) {}

  @Get()
  list(@Query('active') active?: string) {
    const filter =
      active === 'true' ? { active: true } : active === 'false' ? { active: false } : undefined;
    return this.service.list(filter);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CostCenterUpsertDto) {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<CostCenterUpsertDto>) {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
