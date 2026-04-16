import { Module } from '@nestjs/common';
import { AssetService } from './asset.service';
import { AssetController, AssetTypeController } from './asset.controller';

@Module({
  providers: [AssetService],
  controllers: [AssetController, AssetTypeController],
  exports: [AssetService],
})
export class AssetModule {}
