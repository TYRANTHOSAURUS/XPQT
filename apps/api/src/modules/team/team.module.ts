import { Module } from '@nestjs/common';
import { TeamService } from './team.service';
import { TeamController } from './team.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [TeamService, PermissionGuard, PermissionMetadataGuard],
  controllers: [TeamController],
  exports: [TeamService],
})
export class TeamModule {}
