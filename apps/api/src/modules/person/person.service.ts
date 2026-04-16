import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class PersonService {
  constructor(private readonly supabase: SupabaseService) {}

  async search(query: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select('id, first_name, last_name, email, department, type')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,email.ilike.%${query}%`)
      .order('first_name')
      .limit(20);

    if (error) throw error;
    return data;
  }

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select('id, first_name, last_name, email, department, type')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name')
      .limit(100);

    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error) throw error;
    return data;
  }
}
