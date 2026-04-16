import { Module } from '@nestjs/common';
import { UserManagementService } from './user-management.service';
import {
  UsersController,
  RolesController,
  RoleAssignmentsController,
  PersonsAdminController,
} from './user-management.controller';

@Module({
  providers: [UserManagementService],
  controllers: [UsersController, RolesController, RoleAssignmentsController, PersonsAdminController],
  exports: [UserManagementService],
})
export class UserManagementModule {}
