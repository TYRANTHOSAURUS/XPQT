import { Module } from '@nestjs/common';
import { UserManagementService } from './user-management.service';
import {
  UsersController,
  RolesController,
  RoleAssignmentsController,
  PersonsAdminController,
} from './user-management.controller';
import { PermissionsController } from './permissions.controller';
import { PermissionGuard } from '../../common/permission-guard';
import { PermissionMetadataGuard } from '../../common/require-permission.decorator';

@Module({
  // RLS audit Slice 11.3: the 4 mutation controllers re-gated AdminGuard
  // → @RequirePermission('users.*' / 'roles.*' / 'roles.assign' /
  // 'people.*'); no controller here uses AdminGuard anymore, so
  // AuthModule is dropped and the two permission guards are provided
  // locally (config-engine.module pattern).
  providers: [UserManagementService, PermissionGuard, PermissionMetadataGuard],
  controllers: [
    UsersController,
    RolesController,
    RoleAssignmentsController,
    PersonsAdminController,
    PermissionsController,
  ],
  exports: [UserManagementService],
})
export class UserManagementModule {}
