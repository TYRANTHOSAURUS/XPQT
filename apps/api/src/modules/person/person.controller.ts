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
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Controller('persons')
export class PersonController {
  constructor(
    private readonly personService: PersonService,
    private readonly supabase: SupabaseService,
  ) {}

  private async resolveActorUserId(request: Request): Promise<string | null> {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) return null;
    const tenant = TenantContext.currentOrNull();
    if (!tenant) return null;
    const { data } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

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
  async create(@Body() dto: {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    type: string;
    division?: string;
    department?: string;
    cost_center?: string;
    manager_person_id?: string;
  }) {
    return this.personService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.personService.update(id, dto);
  }

  // ── Portal-scope slice: location grants ─────────────────────────────────

  @Get(':id/location-grants')
  async listGrants(@Param('id') id: string) {
    return this.personService.listLocationGrants(id);
  }

  @Post(':id/location-grants')
  async addGrant(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() dto: { space_id: string; note?: string },
  ) {
    const grantedByUserId = await this.resolveActorUserId(request);
    return this.personService.addLocationGrant(id, dto, grantedByUserId ?? undefined);
  }

  @Delete(':id/location-grants/:grantId')
  async removeGrant(@Param('id') id: string, @Param('grantId') grantId: string) {
    return this.personService.removeLocationGrant(id, grantId);
  }
}
