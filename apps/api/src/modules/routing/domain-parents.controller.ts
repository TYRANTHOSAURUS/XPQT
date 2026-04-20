import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface CreateDomainParentDto {
  domain: string;
  parent_domain: string;
}

@Controller('domain-parents')
export class DomainParentsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('domain_parents')
      .select('id, domain, parent_domain, created_at, updated_at')
      .eq('tenant_id', tenant.id)
      .order('domain');
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post()
  async create(@Body() dto: CreateDomainParentDto) {
    const tenant = TenantContext.current();
    const domain = dto.domain?.trim();
    const parent = dto.parent_domain?.trim();
    if (!domain) throw new BadRequestException('domain is required');
    if (!parent) throw new BadRequestException('parent_domain is required');
    if (domain === parent) throw new BadRequestException('domain and parent_domain must differ');

    const { data, error } = await this.supabase.admin
      .from('domain_parents')
      .insert({
        tenant_id: tenant.id,
        domain,
        parent_domain: parent,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('domain_parents')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }
}
