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

@Module({
  providers: [UserManagementService, PermissionGuard],
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
