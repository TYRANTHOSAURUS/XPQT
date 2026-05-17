import { Module } from '@nestjs/common';
import { DelegationService } from './delegation.service';
import { DelegationController } from './delegation.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  providers: [DelegationService, PermissionGuard, PermissionMetadataGuard],
  controllers: [DelegationController],
  exports: [DelegationService],
})
export class DelegationModule {}
