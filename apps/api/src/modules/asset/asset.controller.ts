import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AssetService, CreateAssetDto, UpdateAssetDto, CreateAssetTypeDto } from './asset.service';
import { AdminGuard } from '../auth/admin.guard';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// Asset inventory + asset types are tenant config; mutations are
// admin-only. GETs stay open (work-order/dispatch flows read assets).
@Controller('assets')
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Get()
  async list(
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('asset_type_ids') assetTypeIds?: string,
    @Query('space_id') spaceId?: string,
  ) {
    return this.assetService.list({
      asset_role: role,
      status,
      search,
      asset_type_ids: assetTypeIds ? assetTypeIds.split(',').filter(Boolean) : undefined,
      space_id: spaceId,
    });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.assetService.getById(id);
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateAssetDto) {
    return this.assetService.create(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
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
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateAssetTypeDto) {
    return this.assetService.createType(dto);
  }
}
