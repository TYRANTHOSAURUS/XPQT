import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CreateDelegationDto {
  delegator_user_id: string;
  delegate_user_id: string;
  starts_at: string;
  ends_at: string;
}

@Injectable()
export class DelegationService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('delegations')
      .select(`
        *,
        delegator:users!delegations_delegator_user_id_fkey(id, email, person:persons(first_name, last_name)),
        delegate:users!delegations_delegate_user_id_fkey(id, email, person:persons(first_name, last_name))
      `)
      .eq('tenant_id', tenant.id)
      .order('starts_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async create(dto: CreateDelegationDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('delegations')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async update(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('delegations')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async deactivate(id: string) {
    return this.update(id, { active: false });
  }
}
