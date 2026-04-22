import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { ServiceCatalogService } from './service-catalog.service';

@Controller('service-catalog')
export class ServiceCatalogController {
  constructor(private readonly catalogService: ServiceCatalogService) {}

  @Get('categories')
  async listCategories() {
    return this.catalogService.listCategories();
  }

  @Get('tree')
  async getTree() {
    return this.catalogService.getTree();
  }

  @Get('search')
  async search(@Query('q') q: string) {
    return this.catalogService.search(q ?? '');
  }

  @Get('categories/:id/request-types')
  async getCategoryRequestTypes(@Param('id') id: string) {
    return this.catalogService.getCategoryWithRequestTypes(id);
  }

  @Post('categories')
  async createCategory(@Body() dto: { name: string; description?: string; icon?: string; parent_category_id?: string; display_order?: number }) {
    return this.catalogService.createCategory(dto);
  }

  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.catalogService.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return this.catalogService.deleteCategory(id);
  }

  @Post('categories/:categoryId/link/:requestTypeId')
  async linkRequestType(@Param('categoryId') categoryId: string, @Param('requestTypeId') requestTypeId: string) {
    return this.catalogService.linkRequestTypeToCategory(requestTypeId, categoryId);
  }

  @Post('categories/reorder')
  async reorderCategories(
    @Body() body: { updates: Array<{ id: string; parent_category_id: string | null; display_order: number }> },
  ) {
    return this.catalogService.reorderCategories(body.updates);
  }

  @Post('request-types/move')
  async moveRequestTypes(
    @Body() body: { updates: Array<{ id: string; category_id: string; display_order: number }> },
  ) {
    return this.catalogService.moveRequestTypes(body.updates);
  }
}
