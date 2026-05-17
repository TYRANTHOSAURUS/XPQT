import { Module } from '@nestjs/common';
import { AssetService } from './asset.service';
import { AssetController, AssetTypeController } from './asset.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [AssetService, PermissionGuard, PermissionMetadataGuard],
  controllers: [AssetController, AssetTypeController],
  exports: [AssetService],
})
export class AssetModule {}
