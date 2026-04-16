import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Controller('sla-policies')
export class SlaPolicyController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('sla_policies')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }

  @Post()
  async create(@Body() dto: { name: string; response_time_minutes?: number; resolution_time_minutes?: number }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('sla_policies')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('sla_policies')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}
