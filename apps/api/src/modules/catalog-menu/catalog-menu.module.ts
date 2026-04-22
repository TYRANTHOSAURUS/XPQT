import { Module } from '@nestjs/common';
import { CatalogMenuService } from './catalog-menu.service';
import { CatalogMenuController } from './catalog-menu.controller';

@Module({
  providers: [CatalogMenuService],
  controllers: [CatalogMenuController],
  exports: [CatalogMenuService],
})
export class CatalogMenuModule {}
