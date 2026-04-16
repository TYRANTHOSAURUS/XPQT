import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { AssetService, CreateAssetDto, UpdateAssetDto, CreateAssetTypeDto } from './asset.service';

@Controller('assets')
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Get()
  async list(
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.assetService.list({ asset_role: role, status, search });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.assetService.getById(id);
  }

  @Post()
  async create(@Body() dto: CreateAssetDto) {
    return this.assetService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateAssetDto) {
    return this.assetService.update(id, dto);
  }

  @Get(':id/history')
  async getHistory(@Param('id') id: string) {
    return this.assetService.getHistory(id);
  }
}

@Controller('asset-types')
export class AssetTypeController {
  constructor(private readonly assetService: AssetService) {}

  @Get()
  async list() {
    return this.assetService.listTypes();
  }

  @Post()
  async create(@Body() dto: CreateAssetTypeDto) {
    return this.assetService.createType(dto);
  }
}
