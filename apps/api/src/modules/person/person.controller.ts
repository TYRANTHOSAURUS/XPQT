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

  /**
   * R1 (handoff-residuals 2026-05-20): real `/persons/me` route.
   *
   * Order matters — this MUST be declared BEFORE `@Get(':id')`. NestJS
   * matches routes in declaration order; the `:id` pattern would otherwise
   * capture `me` and forward it to `personService.getById('me')`, which
   * Postgres rejects as an invalid UUID → raw throw → 500
   * `unknown.server_error`. See `person.service.ts:getMe` for the
   * AuthGuard-bridged resolution.
   *
   * No extra permission gate: AuthGuard is global (app.module.ts) and the
   * endpoint returns the caller's OWN person record only — same
   * authorisation model as `/api/me/inbox` (inbox.controller.ts:14-38).
   */
  @Get('me')
  async getMe(@Req() request: Request) {
    return this.personService.getMe(request);
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
    await this.permissions.requirePermission(request, 'people.create');
    return this.personService.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    await this.permissions.requirePermission(request, 'people.update');
    return this.personService.update(id, dto);
  }

  // ── Portal-scope slice: location grants ─────────────────────────────────

  @Get(':id/location-grants')
  async listGrants(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'people.read');
    return this.personService.listLocationGrants(id);
  }

  @Post(':id/location-grants')
  async addGrant(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: { space_id: string; note?: string },
  ) {
    const { userId } = await this.permissions.requirePermission(request, 'people.update');
    return this.personService.addLocationGrant(id, dto, userId);
  }

  @Delete(':id/location-grants/:grantId')
  async removeGrant(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ) {
    await this.permissions.requirePermission(request, 'people.update');
    return this.personService.removeLocationGrant(id, grantId);
  }

  @Get(':id/effective-authorization')
  async listEffectiveAuthorization(@Req() request: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(request, 'people.read');
    return this.personService.listEffectiveAuthorization(id);
  }
}
