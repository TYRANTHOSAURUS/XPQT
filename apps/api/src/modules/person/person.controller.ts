import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PersonService } from './person.service';
import { PermissionGuard } from '../../common/permission-guard';

@Controller('persons')
export class PersonController {
  constructor(
    private readonly personService: PersonService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('type') type?: string,
  ) {
    if (search && search.length >= 2) {
      return this.personService.search(search);
    }
    if (type) {
      return this.personService.listByType(type);
    }
    return this.personService.list();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.personService.getById(id);
  }

  @Post()
  async create(@Req() request: Request, @Body() dto: {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    type: string;
    cost_center?: string;
    manager_person_id?: string;
    primary_org_node_id?: string | null;
  }) {
    await this.permissions.requirePermission(request, 'people:manage');
    return this.personService.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    await this.permissions.requirePermission(request, 'people:manage');
    return this.personService.update(id, dto);
  }

  // ── Portal-scope slice: location grants ─────────────────────────────────

  @Get(':id/location-grants')
  async listGrants(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'people:manage');
    return this.personService.listLocationGrants(id);
  }

  @Post(':id/location-grants')
  async addGrant(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: { space_id: string; note?: string },
  ) {
    const { userId } = await this.permissions.requirePermission(request, 'people:manage');
    return this.personService.addLocationGrant(id, dto, userId);
  }

  @Delete(':id/location-grants/:grantId')
  async removeGrant(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ) {
    await this.permissions.requirePermission(request, 'people:manage');
    return this.personService.removeLocationGrant(id, grantId);
  }

  @Get(':id/effective-authorization')
  async listEffectiveAuthorization(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'people:manage');
    return this.personService.listEffectiveAuthorization(id);
  }
}
