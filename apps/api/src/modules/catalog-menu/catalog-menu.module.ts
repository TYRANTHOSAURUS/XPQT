import { Module } from '@nestjs/common';
import { CatalogMenuService } from './catalog-menu.service';
import { CatalogMenuController } from './catalog-menu.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [CatalogMenuService, PermissionGuard, PermissionMetadataGuard],
  controllers: [CatalogMenuController],
  exports: [CatalogMenuService],
})
export class CatalogMenuModule {}
