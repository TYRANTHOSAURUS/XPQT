import { Module } from '@nestjs/common';
import { OrgNodeService } from './org-node.service';
import { OrgNodeController } from './org-node.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [OrgNodeService, PermissionGuard],
  controllers: [OrgNodeController],
  exports: [OrgNodeService],
})
export class OrgNodeModule {}
