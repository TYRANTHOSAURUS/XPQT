import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ServiceCatalogService } from './service-catalog.service';

interface UpdateCategoryDto {
  name?: string;
  description?: string | null;
  icon?: string | null;
  cover_image_url?: string | null;
  cover_source?: 'image' | 'icon' | null;
  parent_category_id?: string | null;
  display_order?: number;
  active?: boolean;
}

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

  @Post('categories')
  async createCategory(@Body() dto: { name: string; description?: string; icon?: string; parent_category_id?: string; display_order?: number }) {
    return this.catalogService.createCategory(dto);
  }

  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.catalogService.updateCategory(id, dto);
  }

  @Post('categories/:id/cover')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadCategoryCover(
    @Param('id') id: string,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.catalogService.uploadCategoryCover(id, file);
  }

  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return this.catalogService.deleteCategory(id);
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
