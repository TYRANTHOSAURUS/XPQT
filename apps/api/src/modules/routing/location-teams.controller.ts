import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface CreateLocationTeamDto {
  space_id?: string | null;
  space_group_id?: string | null;
  domain: string;
  team_id?: string | null;
  vendor_id?: string | null;
}

interface UpdateLocationTeamDto {
  space_id?: string | null;
  space_group_id?: string | null;
  domain?: string;
  team_id?: string | null;
  vendor_id?: string | null;
}

function validateScope(space_id: string | null | undefined, space_group_id: string | null | undefined) {
  const hasSpace = !!space_id;
  const hasGroup = !!space_group_id;
  if (hasSpace === hasGroup) {
    throw new BadRequestException('Exactly one of space_id or space_group_id must be set.');
  }
}

function validateAssignee(team_id: string | null | undefined, vendor_id: string | null | undefined) {
  if (!team_id && !vendor_id) {
    throw new BadRequestException('At least one of team_id or vendor_id must be set.');
  }
}

@Controller('location-teams')
export class LocationTeamsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .select(`
        id, space_id, space_group_id, domain, team_id, vendor_id, created_at, updated_at,
        space:spaces(id, name, type),
        space_group:space_groups(id, name),
        team:teams(id, name),
        vendor:vendors(id, name)
      `)
      .eq('tenant_id', tenant.id)
      .order('domain', { ascending: true });
    if (error) throw error;
    return data;
  }

  @Post()
  async create(@Body() dto: CreateLocationTeamDto) {
    const tenant = TenantContext.current();
    if (!dto.domain?.trim()) throw new BadRequestException('domain is required');
    validateScope(dto.space_id, dto.space_group_id);
    validateAssignee(dto.team_id, dto.vendor_id);

    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .insert({
        tenant_id: tenant.id,
        space_id: dto.space_id ?? null,
        space_group_id: dto.space_group_id ?? null,
        domain: dto.domain.trim(),
        team_id: dto.team_id ?? null,
        vendor_id: dto.vendor_id ?? null,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateLocationTeamDto) {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.domain !== undefined) patch.domain = dto.domain.trim();
    if (dto.space_id !== undefined) patch.space_id = dto.space_id;
    if (dto.space_group_id !== undefined) patch.space_group_id = dto.space_group_id;
    if (dto.team_id !== undefined) patch.team_id = dto.team_id;
    if (dto.vendor_id !== undefined) patch.vendor_id = dto.vendor_id;

    if ('space_id' in patch || 'space_group_id' in patch || 'team_id' in patch || 'vendor_id' in patch) {
      const { data: current, error: cerr } = await this.supabase.admin
        .from('location_teams')
        .select('space_id, space_group_id, team_id, vendor_id')
        .eq('id', id)
        .eq('tenant_id', tenant.id)
        .single();
      if (cerr) throw new BadRequestException(cerr.message);
      const merged = { ...current, ...patch };
      validateScope(merged.space_id as string | null, merged.space_group_id as string | null);
      validateAssignee(merged.team_id as string | null, merged.vendor_id as string | null);
    }

    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('location_teams')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }
}
