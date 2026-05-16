import { Module } from '@nestjs/common';
import { AssetService } from './asset.service';
import { AssetController, AssetTypeController } from './asset.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [AssetService],
  controllers: [AssetController, AssetTypeController],
  exports: [AssetService],
})
export class AssetModule {}
