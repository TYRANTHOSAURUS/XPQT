import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  UserManagementService,
  CreateRoleDto,
  CreateRoleAssignmentDto,
  CreatePersonDto,
  CreateUserDto,
} from './user-management.service';

@Controller('users')
export class UsersController {
  constructor(private readonly service: UserManagementService) {}

  // Single-hop resolver for the authenticated caller. Looks up public.users by
  // auth_uid (set by AuthGuard on request.user.id), returns the user, linked
  // person, and role_assignments in one call. Replaces the fragile
  // persons-by-email → users-list chain that previously gated admin access.
  @Get('me')
  async me(@Req() request: Request) {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    return this.service.getByAuthUid(authUid);
  }

  @Get()
  async list() {
    return this.service.listUsers();
  }

  @Post()
  async create(@Body() dto: CreateUserDto) {
    return this.service.createUser(dto);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.service.getUser(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.service.updateUser(id, dto);
  }

  @Get(':id/roles')
  async getRoles(@Param('id') id: string) {
    return this.service.getUserRoles(id);
  }

  @Post(':id/roles')
  async addRole(
    @Param('id') id: string,
    @Body() dto: { role_id: string; domain_scope?: string[]; location_scope?: string[] },
  ) {
    return this.service.addUserRole(id, dto);
  }

  @Delete(':id/roles/:roleId')
  async removeRole(@Param('id') id: string, @Param('roleId') roleId: string) {
    return this.service.removeUserRole(id, roleId);
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly service: UserManagementService) {}

  @Get()
  async list() {
    return this.service.listRoles();
  }

  @Post()
  async create(@Body() dto: CreateRoleDto) {
    return this.service.createRole(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Partial<CreateRoleDto>) {
    return this.service.updateRole(id, dto);
  }
}

@Controller('role-assignments')
export class RoleAssignmentsController {
  constructor(private readonly service: UserManagementService) {}

  @Post()
  async assign(@Body() dto: CreateRoleAssignmentDto) {
    return this.service.assignRole(dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.service.removeRoleAssignment(id);
  }
}

@Controller('persons-admin')
export class PersonsAdminController {
  constructor(private readonly service: UserManagementService) {}

  @Get()
  async list(@Query('type') type?: string) {
    return this.service.listPersons(type);
  }

  @Post()
  async create(@Body() dto: CreatePersonDto) {
    return this.service.createPerson(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Partial<CreatePersonDto>) {
    return this.service.updatePerson(id, dto);
  }
}
