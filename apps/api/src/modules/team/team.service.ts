import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class TeamService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }

  async create(dto: { name: string; domain_scope?: string; location_scope?: string }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}
