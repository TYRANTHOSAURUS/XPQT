import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import {
  SpaceService,
  CreateSpaceDto,
  UpdateSpaceDto,
  MoveSpaceDto,
  BulkUpdateDto,
} from './space.service';
import { RequirePermission } from '../../common/require-permission.decorator';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// Spaces are the tenant location hierarchy (buildings/floors/rooms)
// that feeds booking, floor-plan, routing location-scope and
// ticket/visitor visibility closures. Mutations are admin-only. GETs
// stay open — heavily operational (every location picker reads them).
@Controller('spaces')
export class SpaceController {
  constructor(private readonly spaceService: SpaceService) {}

  @Get()
  async list(
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('parent_id') parentId?: string,
    @Query('reservable') reservable?: string,
    @Query('search') search?: string,
    @Query('active_only') activeOnly?: string,
  ) {
    return this.spaceService.list({
      type,
      types: types ? types.split(',').filter(Boolean) : undefined,
      parent_id: parentId,
      reservable: reservable === 'true' ? true : reservable === 'false' ? false : undefined,
      search,
      active_only: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @Get('hierarchy')
  async hierarchy(@Query('root_id') rootId?: string) {
    return this.spaceService.getHierarchy(rootId);
  }

  @Patch('bulk')
  @RequirePermission('spaces.update')
  async bulk(@Body() dto: BulkUpdateDto) {
    return this.spaceService.bulkUpdate(dto);
  }

  @Get(':id/children')
  async children(@Param('id') id: string) {
    return this.spaceService.listChildren(id);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.spaceService.getById(id);
  }

  @Post()
  @RequirePermission('spaces.create')
  async create(@Body() dto: CreateSpaceDto) {
    return this.spaceService.create(dto);
  }

  @Patch(':id')
  @RequirePermission('spaces.update')
  async update(@Param('id') id: string, @Body() dto: UpdateSpaceDto) {
    return this.spaceService.update(id, dto);
  }

  @Post(':id/move')
  @RequirePermission('spaces.update')
  async move(@Param('id') id: string, @Body() dto: MoveSpaceDto) {
    return this.spaceService.move(id, dto);
  }
}
