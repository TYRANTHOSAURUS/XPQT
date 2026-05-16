import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import {
  CatalogMenuService,
  CreateMenuDto,
  CreateMenuItemDto,
  DuplicateMenuDto,
  ResolveOfferDto,
} from './catalog-menu.service';
import { RequirePermission } from '../../common/require-permission.decorator';

// docs/follow-ups/audits/04-rls-security.md Slice 10 (2026-05-16).
// Catalog menus + items are vendor/service config; mutations are
// admin-only. GETs + `catalog-menus/resolve` (read-shaped — the
// booking flow resolves an offer) stay open.
@Controller()
export class CatalogMenuController {
  constructor(private readonly service: CatalogMenuService) {}

  @Get('catalog-items')
  listCatalogItems() {
    return this.service.listCatalogItems();
  }

  @Get('catalog-menus')
  list(
    @Query('vendor_id') vendorId?: string,
    @Query('service_type') serviceType?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list({
      vendor_id: vendorId,
      service_type: serviceType,
      status,
    });
  }

  @Post('catalog-menus/resolve')
  resolve(@Body() dto: ResolveOfferDto) {
    return this.service.resolveOffer(dto);
  }

  @Get('catalog-menus/:id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post('catalog-menus')
  @RequirePermission('catalog_menus.create')
  create(@Body() dto: CreateMenuDto) {
    return this.service.create(dto);
  }

  @Patch('catalog-menus/:id')
  @RequirePermission('catalog_menus.update')
  update(@Param('id') id: string, @Body() dto: Partial<CreateMenuDto>) {
    return this.service.update(id, dto);
  }

  @Get('catalog-menus/:id/items')
  listItems(@Param('id') id: string) {
    return this.service.listItems(id);
  }

  @Post('catalog-menus/:id/items')
  @RequirePermission('catalog_menus.update')
  addItem(@Param('id') id: string, @Body() dto: CreateMenuItemDto) {
    return this.service.addItem(id, dto);
  }

  @Patch('catalog-menus/:id/items/:itemId')
  @RequirePermission('catalog_menus.update')
  updateItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: Partial<CreateMenuItemDto> & { active?: boolean },
  ) {
    return this.service.updateItem(id, itemId, dto);
  }

  @Delete('catalog-menus/:id/items/:itemId')
  @RequirePermission('catalog_menus.delete')
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.service.removeItem(id, itemId);
  }

  @Post('catalog-menus/:id/duplicate')
  @RequirePermission('catalog_menus.create')
  duplicate(@Param('id') id: string, @Body() dto: DuplicateMenuDto) {
    return this.service.duplicate(id, dto);
  }

  @Post('catalog-menus/:id/items/bulk-update')
  @RequirePermission('catalog_menus.update')
  bulkUpdateItems(
    @Param('id') id: string,
    @Body() dto: {
      item_ids: string[];
      price_adjustment_percent?: number | null;
      price_adjustment_flat?: number | null;
      lead_time_hours?: number | null;
      unit?: string;
      active?: boolean;
    },
  ) {
    const { item_ids, ...patch } = dto;
    return this.service.bulkUpdateItems(id, item_ids, patch);
  }

  @Post('catalog-menus/:id/items/bulk-delete')
  @RequirePermission('catalog_menus.delete')
  bulkDeleteItems(@Param('id') id: string, @Body() dto: { item_ids: string[] }) {
    return this.service.bulkDeleteItems(id, dto.item_ids);
  }
}
