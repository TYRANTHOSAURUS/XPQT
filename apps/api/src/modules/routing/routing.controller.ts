import { Controller, Get, Post, Patch, Param, Body } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Controller('routing-rules')
export class RoutingRuleController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('routing_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('priority', { ascending: false });
    if (error) throw error;
    return data;
  }

  @Post()
  async create(@Body() dto: { name: string; priority?: number; conditions?: unknown; action_assign_team_id?: string }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('routing_rules')
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
      .from('routing_rules')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}
