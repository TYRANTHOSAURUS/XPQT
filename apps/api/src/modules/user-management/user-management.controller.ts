import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UnauthorizedException, HttpCode,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  UserManagementService,
  CreateRoleDto,
  CreateRoleAssignmentDto,
  CreatePersonDto,
  CreateUserDto,
} from './user-management.service';
import { PermissionGuard } from '../../common/permission-guard';

@Controller('users')
export class UsersController {
  constructor(
    private readonly service: UserManagementService,
    private readonly permissions: PermissionGuard,
  ) {}

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
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: {
      role_id: string;
      domain_scope?: string[];
      location_scope?: string[];
      starts_at?: string | null;
      ends_at?: string | null;
    },
  ) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.addUserRole(id, dto, actor);
  }

  @Delete(':id/roles/:roleId')
  async removeRole(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.removeUserRole(id, roleId, actor);
  }

  @Get(':id/audit')
  async audit(@Param('id') id: string) {
    return this.service.listRoleAuditEvents({ user_id: id });
  }

  @Get(':id/sign-ins')
  async getSignIns(
    @Req() request: Request,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    await this.permissions.requirePermission(request, 'users.read');
    const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100) : 10;
    return this.service.listSignIns(id, n);
  }

  @Post(':id/password-reset')
  @HttpCode(204)
  async sendPasswordReset(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'users.update');
    await this.service.sendPasswordReset(id);
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
  async create(@Req() request: Request, @Body() dto: CreateRoleDto) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.createRole(dto, actor);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Partial<CreateRoleDto>,
  ) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.updateRole(id, dto, actor);
  }

  @Get(':id/audit')
  async audit(@Param('id') id: string) {
    return this.service.listRoleAuditEvents({ role_id: id });
  }
}

@Controller('role-assignments')
export class RoleAssignmentsController {
  constructor(private readonly service: UserManagementService) {}

  @Post()
  async assign(@Req() request: Request, @Body() dto: CreateRoleAssignmentDto) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.assignRole(dto, actor);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Partial<{
      domain_scope: string[];
      location_scope: string[];
      starts_at: string | null;
      ends_at: string | null;
      active: boolean;
    }>,
  ) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.updateRoleAssignment(id, dto, actor);
  }

  @Delete(':id')
  async remove(@Req() request: Request, @Param('id') id: string) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.removeRoleAssignment(id, actor);
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
