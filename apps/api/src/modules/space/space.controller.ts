import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { SpaceService, CreateSpaceDto, UpdateSpaceDto } from './space.service';

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
  ) {
    return this.spaceService.list({
      type,
      types: types ? types.split(',').filter(Boolean) : undefined,
      parent_id: parentId,
      reservable: reservable === 'true' ? true : reservable === 'false' ? false : undefined,
      search,
    });
  }

  @Get('hierarchy')
  async hierarchy(@Query('root_id') rootId?: string) {
    return this.spaceService.getHierarchy(rootId);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.spaceService.getById(id);
  }

  @Post()
  async create(@Body() dto: CreateSpaceDto) {
    return this.spaceService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSpaceDto) {
    return this.spaceService.update(id, dto);
  }
}
