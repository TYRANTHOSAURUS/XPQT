import { Module } from '@nestjs/common';
import { SpaceService } from './space.service';
import { SpaceController } from './space.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [SpaceService, PermissionGuard, PermissionMetadataGuard],
  controllers: [SpaceController],
  exports: [SpaceService],
})
export class SpaceModule {}
