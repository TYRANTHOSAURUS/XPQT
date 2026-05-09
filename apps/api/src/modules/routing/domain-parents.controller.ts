import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';
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
    if (error) throw AppErrors.server('routing.db_failed', { detail: error.message, cause: error });
    return data;
  }

  @Post()
  async create(@Body() dto: CreateDomainParentDto) {
    const tenant = TenantContext.current();
    const domain = dto.domain?.trim();
    const parent = dto.parent_domain?.trim();
    if (!domain) throw AppErrors.validationFailed('routing.field_required', { detail: 'domain is required' });
    if (!parent) throw AppErrors.validationFailed('routing.field_required', { detail: 'parent_domain is required' });
    if (domain === parent) throw AppErrors.validationFailed('routing.field_required', { detail: 'domain and parent_domain must differ' });

    const { data, error } = await this.supabase.admin
      .from('domain_parents')
      .insert({
        tenant_id: tenant.id,
        domain,
        parent_domain: parent})
      .select()
      .single();
    if (error) throw AppErrors.server('routing.db_failed', { detail: error.message, cause: error });
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
    if (error) throw AppErrors.server('routing.db_failed', { detail: error.message, cause: error });
    return { ok: true };
  }
}
