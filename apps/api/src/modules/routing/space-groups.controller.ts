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

interface CreateSpaceGroupDto {
  name: string;
  description?: string | null;
}

interface UpdateSpaceGroupDto {
  name?: string;
  description?: string | null;
}

interface AddMemberDto {
  space_id: string;
}

@Controller('space-groups')
export class SpaceGroupsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('space_groups')
      .select(`
        id, name, description, created_at, updated_at,
        members:space_group_members(space_id, space:spaces(id, name, type))
      `)
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post()
  async create(@Body() dto: CreateSpaceGroupDto) {
    const tenant = TenantContext.current();
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    const { data, error } = await this.supabase.admin
      .from('space_groups')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        description: dto.description?.trim() ?? null,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSpaceGroupDto) {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('name cannot be empty');
      patch.name = dto.name.trim();
    }
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;

    const { data, error } = await this.supabase.admin
      .from('space_groups')
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
      .from('space_groups')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  @Post(':id/members')
  async addMember(@Param('id') groupId: string, @Body() dto: AddMemberDto) {
    const tenant = TenantContext.current();
    if (!dto.space_id) throw new BadRequestException('space_id is required');
    const { data, error } = await this.supabase.admin
      .from('space_group_members')
      .insert({
        tenant_id: tenant.id,
        space_group_id: groupId,
        space_id: dto.space_id,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id/members/:spaceId')
  async removeMember(@Param('id') groupId: string, @Param('spaceId') spaceId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('space_group_members')
      .delete()
      .eq('tenant_id', tenant.id)
      .eq('space_group_id', groupId)
      .eq('space_id', spaceId);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }
}
