import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { ConfigEngineService, CreateConfigEntityDto, UpdateConfigVersionDto } from './config-engine.service';

@Controller('config-entities')
export class ConfigEntityController {
  constructor(private readonly configEngineService: ConfigEngineService) {}

  @Get()
  async list(@Query('type') type?: string) {
    if (!type) return [];
    return this.configEngineService.listByType(type);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.configEngineService.getById(id);
  }

  @Post()
  async create(@Body() dto: CreateConfigEntityDto) {
    return this.configEngineService.create(dto);
  }

  @Post(':id/draft')
  async createDraft(@Param('id') id: string, @Body() dto: UpdateConfigVersionDto) {
    return this.configEngineService.createDraft(id, dto);
  }

  @Patch(':id/draft')
  async updateDraft(@Param('id') id: string, @Body() dto: UpdateConfigVersionDto) {
    return this.configEngineService.updateDraft(id, dto);
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string) {
    return this.configEngineService.publish(id);
  }

  @Post(':id/rollback/:versionId')
  async rollback(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.configEngineService.rollback(id, versionId);
  }
}
