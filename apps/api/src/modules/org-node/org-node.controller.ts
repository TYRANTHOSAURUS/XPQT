import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrgNodeService } from './org-node.service';
import { PermissionGuard } from '../../common/permission-guard';

const PERMISSION = 'organisations:manage';

@Controller('org-nodes')
export class OrgNodeController {
  constructor(
    private readonly service: OrgNodeService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.list();
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    const [node, members, grants, teams] = await Promise.all([
      this.service.getById(id),
      this.service.listMembers(id),
      this.service.listGrants(id),
      this.service.listAttachedTeams(id),
    ]);
    return { ...node, members, location_grants: grants, teams };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: { name: string; parent_id?: string | null; code?: string | null; description?: string | null },
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: { name?: string; parent_id?: string | null; code?: string | null; description?: string | null; active?: boolean },
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.remove(id);
  }

  // ── Members ──────────────────────────────────────────────────────────
  @Get(':id/members')
  async listMembers(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.listMembers(id);
  }

  @Post(':id/members')
  async addMember(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: { person_id: string; is_primary?: boolean },
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.addMember(id, dto.person_id, dto.is_primary ?? true);
  }

  @Delete(':id/members/:personId')
  async removeMember(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('personId') personId: string,
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.removeMember(id, personId);
  }

  // ── Location grants ──────────────────────────────────────────────────
  @Get(':id/location-grants')
  async listGrants(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.listGrants(id);
  }

  @Post(':id/location-grants')
  async addGrant(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: { space_id: string; note?: string },
  ) {
    const { userId } = await this.permissions.requirePermission(req, PERMISSION);
    return this.service.addGrant(id, dto.space_id, dto.note, userId);
  }

  @Delete(':id/location-grants/:grantId')
  async removeGrant(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.removeGrant(id, grantId);
  }
}
