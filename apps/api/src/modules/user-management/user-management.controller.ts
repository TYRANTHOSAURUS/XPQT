import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  UserManagementService,
  CreateRoleDto,
  CreateRoleAssignmentDto,
  CreatePersonDto,
  CreateUserDto,
} from './user-management.service';
import { AdminGuard } from '../auth/admin.guard';
import { AppErrors } from '../../common/errors';

// docs/follow-ups/audits/04-rls-security.md Slice 9 (reviewer-surfaced
// P0, 2026-05-16). These controllers were unguarded beyond the global
// AuthGuard — any active same-tenant user could POST /role-assignments
// to self-grant admin, then AdminGuard would accept the assignment.
//
// AdminGuard is applied per-MUTATION (not class-level) because the read
// endpoints are operational: GET /users (`useUsers`) backs the desk
// ticket-filter / ticket-detail / user-picker / workflow assign-form,
// and GET /roles backs role pickers. Locking those to admin-only would
// break non-admin operator UX. The escalation vector is the writes —
// those are guarded. Remaining GET info-disclosure (full user/role
// roster visible to any same-tenant user) is tracked as a P2 follow-up
// in the closure ledger; it is not an escalation vector.

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
    if (!authUid) throw AppErrors.unauthorized('No auth user');
    return this.service.getByAuthUid(authUid);
  }

  @Get()
  async list() {
    return this.service.listUsers();
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateUserDto) {
    return this.service.createUser(dto);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.service.getUser(id);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.service.updateUser(id, dto);
  }

  @Get(':id/roles')
  async getRoles(@Param('id') id: string) {
    return this.service.getUserRoles(id);
  }

  @Post(':id/roles')
  @UseGuards(AdminGuard)
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
  @UseGuards(AdminGuard)
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
}

@Controller('roles')
export class RolesController {
  constructor(private readonly service: UserManagementService) {}

  @Get()
  async list() {
    return this.service.listRoles();
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() request: Request, @Body() dto: CreateRoleDto) {
    const actor = await this.service.actorFromRequest(request);
    return this.service.createRole(dto, actor);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
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

// Entire controller is mutations (POST/PATCH/DELETE — no operational
// GET), and POST /role-assignments is the primary privilege-escalation
// vector. Class-level AdminGuard is the correct posture here.
@UseGuards(AdminGuard)
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
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreatePersonDto) {
    return this.service.createPerson(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  async update(@Param('id') id: string, @Body() dto: Partial<CreatePersonDto>) {
    return this.service.updatePerson(id, dto);
  }
}
